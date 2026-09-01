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
import { renderSpread } from "../render/trend.js";
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

    const entries = rows
        .filter((row) => !row.onLeave)
        .map((row) => ({
            minutes: row.activityMinutes,
            below: row.activityMinutes < config.weeklyTargetMinutes
        }));

    return teamRecapCard({
        windowLabel: labelWindow(week.start, week.end, config.accountingTimezone),
        headline: teamRecapHeadline(summary),
        totalMinutes: formatMinutes(summary.totalMinutes),
        medianMinutes: summary.medianMinutes,
        meanMinutes: summary.meanMinutes,
        targetMinutes: config.weeklyTargetMinutes,
        topStreak,
        spread:
            entries.length > 0
                ? {
                      png: renderSpread({
                          entries,
                          requiredMinutes: config.weeklyTargetMinutes,
                          title: "Everyone this week"
                      }),
                      alt:
                          `${entries.length} members against a ${config.weeklyTargetMinutes} ` +
                          `minute weekly target. ${summary.closed} closed their ring. ` +
                          `Median ${summary.medianMinutes} minutes.`
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
