import type { Client } from "discord.js";
import { collections } from "../db/client.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { WeekWindow } from "../domain/weekly.js";
import { computeStreak, previousWeekWindow } from "../domain/weekly.js";
import { summariseTeamWeek, teamRecapHeadline } from "../domain/teamRecap.js";
import { findStaffById } from "../domain/staff.js";
import { staffChannel } from "./leaveService.js";
import { claimTeamRecap } from "./notifications.js";
import { teamRecapCard, type RenderedMessage } from "../render/cards.js";
import { describeRings, renderRingCard } from "../render/rings.js";
import { ringStateFor } from "../domain/rings.js";
import { formatMinutes, labelWindow } from "../time/format.js";
import { log } from "../log.js";

/**
 * The team's week, posted once to the recap channel when the week closes.
 *
 * `recapChannelId` has been configurable since the beginning and nothing ever
 * read it, so `/config view` offered a channel picker for a posting that did
 * not exist and the setup checklist promised "recaps still arrive by DM" as the
 * consequence of leaving it unset. Nothing was being skipped, because nothing
 * had been built. This is that posting.
 *
 * The personal recaps are untouched: each member still gets their own card at
 * their own local 09:00. This is the part nobody can see from inside their own.
 */
export async function buildTeamRecap(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    rehearsal: boolean
): Promise<RenderedMessage | null> {
    const rows = await collections.weeklyStats().find({ weekStart: week.start }).toArray();
    if (rows.length === 0) return null;

    const prior = previousWeekWindow(week.start, config);
    const priorRows = await collections
        .weeklyStats()
        .find({ weekStart: prior.start })
        .toArray();
    const priorTotal = priorRows.length
        ? priorRows
              .filter((row) => !row.onLeave)
              .reduce((sum, row) => sum + row.activityMinutes, 0)
        : null;

    const summary = summariseTeamWeek(
        rows.map((row) => ({
            activityMinutes: row.activityMinutes,
            shiftMs: row.shiftMs,
            activeDays: row.activeDays,
            ringState: row.ringState,
            onLeave: row.onLeave
        })),
        priorTotal
    );

    // The one person named, and only when the run is worth naming. Recognition
    // rather than a ranking: the leaderboard is where positions live.
    let topStreak: { mention: string; weeks: number } | null = null;
    for (const row of rows) {
        if (row.onLeave) continue;
        const weeks = await computeStreak(row.staffId, config, week.end);
        if (weeks > (topStreak?.weeks ?? 0)) {
            const staff = await findStaffById(row.staffId);
            if (staff) topStreak = { mention: `<@${staff.discordId}>`, weeks };
        }
    }

    // The team's own rings, drawn by the same renderer that draws a member's.
    //
    // Not a bar per person. A chart with one mark per member is a ranking
    // whether or not it carries names: in a room of fifteen, the short bar on
    // the right is somebody everyone can work out, and the recap channel is
    // read by the whole team rather than by the Executives deciding about them.
    // The fortnight review keeps its per-member chart, because that card is a
    // decision queue and already names the people on it.
    //
    // Targets are the individual ones multiplied by the head count actually
    // expected to work, so the ring reads as "the team, together, against what
    // was asked of it" and a week with people on leave is not scored against
    // work nobody owed.
    const ringsInput = {
        activityMinutes: summary.totalMinutes,
        activityTarget: Math.max(1, config.weeklyTargetMinutes * summary.counted),
        shiftHours: summary.totalShiftMs / 3_600_000,
        shiftTarget: Math.max(1, config.weeklyShiftTargetHours * summary.counted),
        activeDays: summary.totalActiveDays,
        activeDaysTarget: Math.max(1, config.weeklyActiveDaysTarget * summary.counted),
        state: ringStateFor({
            activityMinutes: summary.totalMinutes,
            weeklyTargetMinutes: Math.max(1, config.weeklyTargetMinutes * summary.counted),
            amberThresholdPercent: config.amberThresholdPercent,
            onLeave: false
        }),
        softRingsEnabled: config.softRingsEnabled,
        // No face: a face is a member's own choice and the team is not a
        // member. The default is the only honest one here.
        face: null
    };

    return teamRecapCard({
        windowLabel: labelWindow(week.start, week.end, config.accountingTimezone),
        headline: teamRecapHeadline(summary),
        totalMinutes: formatMinutes(summary.totalMinutes),
        // The team's target, not each member's. A per-member figure invites the
        // reader to work out who was under it, which is what this card is
        // deliberately not for.
        teamTargetMinutes: formatMinutes(config.weeklyTargetMinutes * summary.counted),
        topStreak,
        rings:
            summary.counted > 0
                ? {
                      png: renderRingCard(ringsInput),
                      alt: `The team's week, as rings. ${describeRings(ringsInput)}`
                  }
                : null,
        rehearsal
    });
}

/**
 * Post it, once per week, ever.
 *
 * Claimed against a delivery receipt for the same reason the fortnight
 * announcement is: weeks are rebuilt routinely, by `/admin recompute` and by the
 * boot backfill, and a rebuild must refresh the figures without posting the
 * week again.
 */
export async function postTeamRecap(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<boolean> {
    if (!config.recapChannelId) return false;

    const channel = await staffChannel(client, config, config.recapChannelId);
    if (!channel) {
        log.warn("recapChannelId is set but the channel could not be fetched.");
        return false;
    }

    if (!(await claimTeamRecap(week.start))) return false;

    const card = await buildTeamRecap(client, config, week, false);
    if (!card) return false;

    await channel.send({ ...card });
    return true;
}
