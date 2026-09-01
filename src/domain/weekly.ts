import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { StaffDoc, WeeklyStatsDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    countActiveDaysBetween,
    countMinutesBetween
} from "./activity.js";
import { shiftMsInWindow, shiftsOverlapping } from "./shifts.js";
import { leaveCoverageFor } from "./leave.js";
import { ringStateFor } from "./rings.js";
import {
    nextWeekStart,
    weekStartFor,
    weekIndexFrom,
    DAY_MS
} from "../time/calendar.js";
import { listActiveStaff } from "./staff.js";
import { log } from "../log.js";

/**
 * weeklyStats is a materialised rollup and never the source of truth. Every
 * field here is recomputable from activityDays, shifts and leave at any time,
 * which is what makes /admin recompute safe to run over any range.
 */

export interface WeekWindow {
    start: Date;
    /** Exclusive. */
    end: Date;
}

export function weekWindowFor(instant: Date, config: StaffBotConfig): WeekWindow {
    const start = weekStartFor(instant, config.accountingTimezone, config.weekStartDay);
    const end = nextWeekStart(start, config.accountingTimezone, config.weekStartDay);
    return { start, end };
}

export function previousWeekWindow(instant: Date, config: StaffBotConfig): WeekWindow {
    const current = weekWindowFor(instant, config);
    const previousStart = weekStartFor(
        new Date(current.start.getTime() - DAY_MS),
        config.accountingTimezone,
        config.weekStartDay
    );
    return {
        start: previousStart,
        end: nextWeekStart(previousStart, config.accountingTimezone, config.weekStartDay)
    };
}

/**
 * A week's figures, plus what the card needs to explain a week that leave only
 * touched. The two extra fields are derived on read and never stored: they
 * describe a boundary, and the boundary is already in the leave record.
 */
export interface WeekStats extends Omit<WeeklyStatsDoc, "_id"> {
    /** When leave ended inside this week, if it did. */
    leaveEndedAt: Date | null;
    /** When leave began inside this week, if it did. */
    leaveStartedAt: Date | null;
}

/**
 * Compute one week for one member from raw data. No writes.
 *
 * Only leave covering the entire week counts as being on leave. A week in which
 * leave started on the Thursday, or ended on the Tuesday, is a worked week with
 * a note on it: the member's minutes are real, they are ranked on them, and the
 * rings show the state those minutes earned rather than a flat grey.
 */
export async function computeWeek(
    staffId: ObjectId,
    window: WeekWindow,
    config: StaffBotConfig,
    now = new Date()
): Promise<WeekStats> {
    const [activityMinutes, activeDays, coverage, shifts] = await Promise.all([
        countMinutesBetween(staffId, window.start, window.end),
        countActiveDaysBetween(staffId, window.start, window.end),
        leaveCoverageFor(staffId, window.start, window.end),
        shiftsOverlapping(staffId, window.start, window.end)
    ]);

    const shiftMs = shifts.reduce(
        (total, shift) => total + shiftMsInWindow(shift, window.start, window.end, now),
        0
    );

    return {
        staffId,
        weekStart: window.start,
        activityMinutes,
        shiftMs,
        activeDays,
        onLeave: coverage.full,
        partialLeave: coverage.partial,
        leaveEndedAt: coverage.endedAt,
        leaveStartedAt: coverage.startedAt,
        ringState: ringStateFor({
            activityMinutes,
            weeklyTargetMinutes: config.weeklyTargetMinutes,
            amberThresholdPercent: config.amberThresholdPercent,
            onLeave: coverage.full
        })
    };
}

/**
 * The line a card shows when leave only touched the week.
 *
 * Written as a fact about the week rather than as a caveat, because the member
 * did work it and the target did apply to the part they worked.
 */
export function leaveNoteFor(stats: WeekStats): string | undefined {
    if (stats.onLeave) return undefined;
    if (!stats.partialLeave) return undefined;
    if (stats.leaveEndedAt && stats.leaveStartedAt) {
        return "You were on leave during part of this week. The target still applies to the " +
            "rest of it.";
    }
    if (stats.leaveEndedAt) {
        return "Your leave ended part way through this week, so this week counts. Only the " +
            "days after it are yours to make up.";
    }
    if (stats.leaveStartedAt) {
        return "Your leave starts part way through this week, so the days before it still " +
            "count.";
    }
    return undefined;
}

export async function upsertWeek(stats: Omit<WeeklyStatsDoc, "_id">): Promise<void> {
    await collections.weeklyStats().updateOne(
        { staffId: stats.staffId, weekStart: stats.weekStart },
        {
            $set: {
                activityMinutes: stats.activityMinutes,
                shiftMs: stats.shiftMs,
                activeDays: stats.activeDays,
                onLeave: stats.onLeave,
                partialLeave: stats.partialLeave,
                ringState: stats.ringState
            },
            $setOnInsert: {
                _id: new ObjectId(),
                staffId: stats.staffId,
                weekStart: stats.weekStart
            }
        },
        { upsert: true }
    );
}

export async function rebuildWeek(
    staffId: ObjectId,
    window: WeekWindow,
    config: StaffBotConfig,
    now = new Date()
): Promise<WeeklyStatsDoc> {
    const stats = await computeWeek(staffId, window, config, now);
    await upsertWeek(stats);
    return { _id: new ObjectId(), ...stats };
}

/** Rebuild one week for every active member. Idempotent. */
export async function rebuildWeekForAll(
    window: WeekWindow,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    const staff = await listActiveStaff();
    for (const member of staff) {
        await rebuildWeek(member._id, window, config, now);
    }
    log.info(
        `Rebuilt weeklyStats for ${staff.length} staff, week starting ${window.start.toISOString()}`
    );
    return staff.length;
}

/**
 * Live figures for the current, still open week. weeklyStats is only written at
 * week close, so anything asking about "this week" computes fresh.
 */
export async function currentWeekStats(
    staffId: ObjectId,
    config: StaffBotConfig,
    now = new Date()
): Promise<WeekStats> {
    return computeWeek(staffId, weekWindowFor(now, config), config, now);
}

export async function getStoredWeek(
    staffId: ObjectId,
    weekStart: Date
): Promise<WeeklyStatsDoc | null> {
    return collections.weeklyStats().findOne({ staffId, weekStart });
}

export async function weeksInRange(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<WeeklyStatsDoc[]> {
    return collections
        .weeklyStats()
        .find({ staffId, weekStart: { $gte: from, $lt: to } })
        .sort({ weekStart: 1 })
        .toArray();
}

export async function allWeeksFor(staffId: ObjectId): Promise<WeeklyStatsDoc[]> {
    return collections.weeklyStats().find({ staffId }).sort({ weekStart: 1 }).toArray();
}

/**
 * Consecutive weeks meeting the outer target, counting back from the last
 * completed week. Leave weeks are skipped rather than breaking the run, so a
 * four week streak into three weeks of leave resumes at four.
 */
export async function computeStreak(
    staffId: ObjectId,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    const weeks = await collections
        .weeklyStats()
        .find({ staffId })
        .sort({ weekStart: -1 })
        .limit(104)
        .toArray();

    const currentWeekStart = weekWindowFor(now, config).start.getTime();
    let streak = 0;
    for (const week of weeks) {
        // The open week has not closed and cannot yet count either way.
        if (week.weekStart.getTime() >= currentWeekStart) continue;
        if (week.onLeave || week.ringState === "leave") continue; // frozen, not broken
        if (week.ringState === "green") streak += 1;
        else break;
    }
    return streak;
}

/** Weeks with no rollup between the anchor-ish past and the current week. */
/**
 * Whether the database holds no weekly rollup at all.
 *
 * A first boot and eight weeks of downtime look identical to
 * `missingWeekWindows`: both leave every week in the lookback without a
 * rollup. This is what tells them apart, and it is asked before anything is
 * rebuilt, because rebuilding is what stops it being true.
 */
export async function hasNoWeeklyRollups(): Promise<boolean> {
    const one = await collections.weeklyStats().findOne({}, { projection: { _id: 1 } });
    return one === null;
}

export async function missingWeekWindows(
    config: StaffBotConfig,
    lookbackWeeks: number,
    now = new Date()
): Promise<WeekWindow[]> {
    const current = weekWindowFor(now, config);
    const windows: WeekWindow[] = [];

    let cursor = current.start;
    for (let step = 0; step < lookbackWeeks; step += 1) {
        const start = weekStartFor(
            new Date(cursor.getTime() - DAY_MS),
            config.accountingTimezone,
            config.weekStartDay
        );
        windows.push({
            start,
            end: nextWeekStart(start, config.accountingTimezone, config.weekStartDay)
        });
        cursor = start;
    }

    const existing = await collections
        .weeklyStats()
        .distinct("weekStart", {
            weekStart: { $gte: windows[windows.length - 1]?.start ?? current.start }
        });
    const have = new Set(existing.map((date: Date) => date.getTime()));

    // A week is missing only if nobody has a rollup for it at all.
    return windows.filter((window) => !have.has(window.start.getTime())).reverse();
}

export function weekIndexOf(window: WeekWindow, anchor: Date): number {
    return weekIndexFrom(window.start, anchor);
}

export interface LeaderboardRow {
    staff: StaffDoc;
    activityMinutes: number;
    shiftMs: number;
    activeDays: number;
    onLeave: boolean;
    rank: number;
}
