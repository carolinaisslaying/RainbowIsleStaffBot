import type { StaffBotConfig } from "../config/guildConfig.js";
import type { RingState, StaffDoc } from "../db/types.js";
import { collections } from "../db/client.js";
import { ringStateFor } from "./rings.js";
import { fortnightIndexForWeek, isAssessableFortnight, weekClosesFortnight } from "./assessments.js";
import { computeWeek, previousWeekWindow } from "./weekly.js";

/**
 * Last week's shortfall, carried onto the second week's ring.
 *
 * The fortnight pools both weeks, but a ring only ever showed one week's
 * target, so somebody who fell short in week one had nothing in week two
 * telling them what they still needed. This is a picture, not a rule: the
 * stored ring state, weeks in a row, the review and the team recap all stay on
 * the plain weekly target, and a week under it is still a missed week.
 *
 * Only a shortfall carries. A week over target carries nothing, deliberately,
 * even though the review would count the surplus. Leave in either week carries
 * nothing: an exempt week is out of the fortnight, so there is no shortfall to
 * speak of and nothing to add to a ring that is already grey.
 */
export interface CarryRule {
    weeklyTargetMinutes: number;
    /** This week is the second of its fortnight. */
    secondWeek: boolean;
    /** The fortnight is one the bot assesses (not before the anchor). */
    assessable: boolean;
    thisWeekExempt: boolean;
    /** Null when the member was not on the team last week. */
    previousWeek: { activityMinutes: number; onLeave: boolean } | null;
}

export function carriedShortfall(rule: CarryRule): number {
    if (!rule.secondWeek || !rule.assessable || rule.thisWeekExempt) return 0;
    if (!rule.previousWeek || rule.previousWeek.onLeave) return 0;
    return Math.max(0, rule.weeklyTargetMinutes - rule.previousWeek.activityMinutes);
}

export interface WeekTarget {
    activityTarget: number;
    carriedMinutes: number;
    state: RingState;
}

/** What a member's own ring measures this week against, and the colour that gives. */
export function weekTargetFor(
    stats: { activityMinutes: number; onLeave: boolean },
    carriedMinutes: number,
    config: Pick<StaffBotConfig, "weeklyTargetMinutes" | "amberThresholdPercent">
): WeekTarget {
    const activityTarget = config.weeklyTargetMinutes + carriedMinutes;
    return {
        activityTarget,
        carriedMinutes,
        state: ringStateFor({
            activityMinutes: stats.activityMinutes,
            weeklyTargetMinutes: activityTarget,
            amberThresholdPercent: config.amberThresholdPercent,
            onLeave: stats.onLeave
        })
    };
}

function position(weekStart: Date, config: StaffBotConfig) {
    return {
        secondWeek: weekClosesFortnight(weekStart, config),
        assessable: isAssessableFortnight(fortnightIndexForWeek(weekStart, config))
    };
}

/**
 * Last week's figures for each member, from the stored rollup where there is
 * one. The rollup is written at the close, so a recap or a card drawn in the
 * minutes either side of it may find none and computes instead.
 */
async function previousWeeks(
    staff: StaffDoc[],
    weekStart: Date,
    config: StaffBotConfig,
    now: Date
): Promise<Map<string, { activityMinutes: number; onLeave: boolean } | null>> {
    const previous = previousWeekWindow(weekStart, config);
    const stored = await collections
        .weeklyStats()
        .find({ weekStart: previous.start, staffId: { $in: staff.map((member) => member._id) } })
        .toArray();
    const byId = new Map(stored.map((doc) => [doc.staffId.toHexString(), doc]));

    const result = new Map<string, { activityMinutes: number; onLeave: boolean } | null>();
    for (const member of staff) {
        const key = member._id.toHexString();
        // Joined after last week began: they were never asked for its minutes.
        if (member.joinedTeamAt.getTime() > previous.start.getTime()) {
            result.set(key, null);
            continue;
        }
        const doc = byId.get(key) ?? (await computeWeek(member._id, previous, config, now));
        result.set(key, { activityMinutes: doc.activityMinutes, onLeave: doc.onLeave });
    }
    return result;
}

/** The carry onto one member's week. */
export async function carryIntoWeek(
    staff: StaffDoc,
    weekStart: Date,
    thisWeekExempt: boolean,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    const where = position(weekStart, config);
    if (!where.secondWeek || !where.assessable || thisWeekExempt) return 0;
    const previous = await previousWeeks([staff], weekStart, config, now);
    return carriedShortfall({
        weeklyTargetMinutes: config.weeklyTargetMinutes,
        ...where,
        thisWeekExempt,
        previousWeek: previous.get(staff._id.toHexString()) ?? null
    });
}

/** The carry onto everybody's week, in one rollup read. Keyed by staff id. */
export async function carriesIntoWeek(
    staff: StaffDoc[],
    weekStart: Date,
    exempt: Set<string>,
    config: StaffBotConfig,
    now = new Date()
): Promise<Map<string, number>> {
    const where = position(weekStart, config);
    const carries = new Map<string, number>();
    if (!where.secondWeek || !where.assessable || staff.length === 0) return carries;
    const previous = await previousWeeks(staff, weekStart, config, now);
    for (const member of staff) {
        const key = member._id.toHexString();
        carries.set(
            key,
            carriedShortfall({
                weeklyTargetMinutes: config.weeklyTargetMinutes,
                ...where,
                thisWeekExempt: exempt.has(key),
                previousWeek: previous.get(key) ?? null
            })
        );
    }
    return carries;
}

/** One member's ring target for a week: the carry, the target and the colour. */
export async function weekRingFor(
    staff: StaffDoc,
    stats: { weekStart: Date; activityMinutes: number; onLeave: boolean },
    config: StaffBotConfig,
    now = new Date()
): Promise<WeekTarget> {
    const carried = await carryIntoWeek(staff, stats.weekStart, stats.onLeave, config, now);
    return weekTargetFor(stats, carried, config);
}
