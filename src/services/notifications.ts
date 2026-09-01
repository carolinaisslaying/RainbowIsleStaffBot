import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { collections } from "../db/client.js";
import { fetchMember, tryDm } from "../discord/roles.js";
import { findStaffById, listActiveStaff } from "../domain/staff.js";
import {
    computeStreak,
    currentWeekStats,
    previousWeekWindow,
    weekWindowFor,
    type WeekWindow
} from "../domain/weekly.js";
import { activeLeaveFor } from "../domain/leave.js";
import { noticeCard, ringCard, ringGalleryCard, type RenderedMessage } from "../render/cards.js";
import { localHourIn } from "../time/timezones.js";
import { formatMinutes, ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * Ring closure DMs, weekly recaps and milestones.
 *
 * Delivery state lives in a small collection rather than in memory, because the
 * container restarts and a recap must not be sent twice or dropped.
 */

/** Claim a one-shot delivery. Returns false if it has already been sent. */
async function claim(key: string): Promise<boolean> {
    try {
        await collections.deliveries().insertOne({ _id: key, at: new Date() });
        return true;
    } catch {
        return false; // duplicate key: already delivered
    }
}

export const MILESTONES = {
    firstRing: "first ring closed",
    streak4: "4 week streak",
    streak12: "12 week streak"
} as const;

/**
 * Fires the moment the outer ring reaches 100 percent. Called after a credit,
 * so it must be cheap and must never fire twice for the same week.
 */
export async function maybeRingClosure(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    now = new Date()
): Promise<void> {
    const stats = await currentWeekStats(staffId, config, now);
    if (stats.activityMinutes < config.weeklyTargetMinutes) return;
    if (stats.onLeave) return;

    const window = weekWindowFor(now, config);
    const key = `ring:${staffId.toHexString()}:${window.start.getTime()}`;
    if (!(await claim(key))) return;

    const staff = await findStaffById(staffId);
    if (!staff) return;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    const streak = await computeStreak(staffId, config, now);

    const card = ringGalleryCard({
        staffId: staffId.toHexString(),
        displayName: member?.displayName ?? "You",
        weekStart: window.start,
        weekEnd: window.end,
        activityMinutes: stats.activityMinutes,
        activityTarget: config.weeklyTargetMinutes,
        shiftMs: stats.shiftMs,
        shiftTargetHours: config.weeklyShiftTargetHours,
        activeDays: stats.activeDays,
        activeDaysTarget: config.weeklyActiveDaysTarget,
        state: stats.ringState,
        softRingsEnabled: config.softRingsEnabled,
        streak,
        heading: "## Ring closed"
    });

    await tryDm(client, staff.discordId, { ...card });

    // Milestones. The list is deliberately short.
    const closedBefore = await collections
        .weeklyStats()
        .countDocuments({ staffId, ringState: "green" });
    if (closedBefore === 0) await sendMilestone(client, staff.discordId, MILESTONES.firstRing);
    if (streak + 1 === 4) await sendMilestone(client, staff.discordId, MILESTONES.streak4);
    if (streak + 1 === 12) await sendMilestone(client, staff.discordId, MILESTONES.streak12);
}

async function sendMilestone(
    client: Client,
    discordId: string,
    milestone: string
): Promise<void> {
    const key = `milestone:${discordId}:${milestone}`;
    if (!(await claim(key))) return;
    await tryDm(client, discordId, {
        ...noticeCard("Milestone", `**${milestone}**. Nice work.`, {
            colour: COLOUR.milestone
        })
    });
}

/**
 * Weekly recap, held until the recipient's local 09:00 on the week's first day.
 * The scheduler calls this every hour; each member is delivered exactly once
 * per week, whenever their own 09:00 comes round.
 */
export async function deliverDueRecaps(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    const closed = previousWeekWindow(now, config);
    const staff = await listActiveStaff();
    let sent = 0;

    // Team total for the closed week, quoted in every recap.
    const teamRows = await collections
        .weeklyStats()
        .find({ weekStart: closed.start })
        .toArray();
    const teamMinutes = teamRows.reduce((total, row) => total + row.activityMinutes, 0);

    for (const member of staff) {
        if (!member.timezone) continue;
        if (localHourIn(now, member.timezone) !== 9) continue;

        const key = `recap:${member._id.toHexString()}:${closed.start.getTime()}`;
        if (!(await claim(key))) continue;

        try {
            await sendRecap(client, config, member._id, closed, teamMinutes, teamRows.length);
            sent += 1;
        } catch (error) {
            log.error(`Recap delivery failed for ${member._id.toHexString()}`, error);
        }
    }
    return sent;
}

async function sendRecap(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    closed: WeekWindow,
    teamMinutes: number,
    teamSize: number
): Promise<void> {
    const staff = await findStaffById(staffId);
    if (!staff) return;

    const stored = await collections.weeklyStats().findOne({ staffId, weekStart: closed.start });
    if (!stored) return;

    const previous = await collections
        .weeklyStats()
        .find({ weekStart: closed.start })
        .sort({ activityMinutes: -1 })
        .toArray();
    const rank = previous.findIndex((row) => row.staffId.equals(staffId)) + 1;

    const priorWeek = previousWeekWindow(closed.start, config);
    const priorRows = await collections
        .weeklyStats()
        .find({ weekStart: priorWeek.start })
        .sort({ activityMinutes: -1 })
        .toArray();
    const priorRank = priorRows.findIndex((row) => row.staffId.equals(staffId)) + 1;

    const movement =
        priorRank === 0 || rank === 0
            ? "no previous position to compare"
            : priorRank === rank
              ? `unchanged`
              : priorRank > rank
                ? `up ${priorRank - rank}`
                : `down ${rank - priorRank}`;

    const streak = await computeStreak(staffId, config);
    const member = await fetchMember(client, config.publicGuildId, staff.discordId);

    const card = ringCard({
        staffId: staffId.toHexString(),
        displayName: member?.displayName ?? "You",
        weekStart: closed.start,
        weekEnd: closed.end,
        activityMinutes: stored.activityMinutes,
        activityTarget: config.weeklyTargetMinutes,
        shiftMs: stored.shiftMs,
        shiftTargetHours: config.weeklyShiftTargetHours,
        activeDays: stored.activeDays,
        activeDaysTarget: config.weeklyActiveDaysTarget,
        state: stored.ringState,
        softRingsEnabled: config.softRingsEnabled,
        streak,
        heading: "## Your week",
        footnote:
            (stored.partialLeave
                ? "You were on leave for part of this week, and the week still counted for " +
                  "the days you were here. "
                : "") +
            `Rank ${rank || "unranked"} of ${teamSize} (${movement}). ` +
            `The team recorded ${formatMinutes(teamMinutes)} between them. ` +
            `This week closes ${ts(weekWindowFor(new Date(), config).end, "F")}.`
    });

    await tryDm(client, staff.discordId, { ...card });
}

/** Sent after a fortnight assessment, telling the member their own outcome. */
export async function sendFortnightOutcome(
    client: Client,
    discordId: string,
    body: string,
    colour: number = COLOUR.admin
): Promise<void> {
    await tryDm(client, discordId, {
        ...noticeCard("Fortnight closed", body, { colour })
    });
}

export type { RenderedMessage };
