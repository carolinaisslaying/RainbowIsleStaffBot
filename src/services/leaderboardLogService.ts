import type { Client } from "discord.js";
import { collections } from "../db/client.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc, WeeklyStatsDoc } from "../db/types.js";
import type { WeekWindow } from "../domain/weekly.js";
import { leaderboardVisibility, publicStandings } from "../domain/leaderboard.js";
import { staffChannel } from "./leaveService.js";
import { claimLeaderboardLog } from "./notifications.js";
import { leaderboardCard, type RenderedMessage } from "../render/cards.js";
import { staffDisplayName } from "../discord/displayName.js";
import { labelWindow } from "../time/format.js";
import { log } from "../log.js";

/**
 * A closed week's leaderboard, posted once to `leaderboardLogChannelId` as a
 * record of how that week finished.
 *
 * The live leaderboard answers "where do we stand now" and forgets the week the
 * moment it closes. This is the same standings frozen at the close, read from
 * the week's rollups rather than counted live, so the log agrees with the team
 * recap and with every member's own recap for that week.
 *
 * Always the public view: the card sits in a channel with no reader to make an
 * exception for, so hidden members are left out and counted in the footnote,
 * exactly as the channel copy of `/stats leaderboard` does. No buttons: every
 * row is on the one card, because a record that has to be paged is a record
 * nobody scrolls back through.
 */
export async function buildLeaderboardLog(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<RenderedMessage | null> {
    const rollups = await collections.weeklyStats().find({ weekStart: week.start }).toArray();
    if (rollups.length === 0) return null;

    const staff = await collections
        .staff()
        .find({ _id: { $in: rollups.map((row) => row.staffId) } })
        .toArray();
    const byId = new Map(staff.map((member) => [member._id.toHexString(), member]));

    const inputs = rollups.flatMap((row) => {
        const member = byId.get(row.staffId.toHexString());
        // A rollup whose member has since been removed has nobody to name.
        if (!member) return [];
        return [
            {
                member: { staff: member, rollup: row },
                minutes: row.activityMinutes,
                onLeave: row.onLeave,
                optedOut: member.leaderboardOptOut
            }
        ];
    });

    const { rows, hiddenCount } = publicStandings<{ staff: StaffDoc; rollup: WeeklyStatsDoc }>(
        inputs
    );

    const views = [];
    for (const row of rows) {
        views.push({
            rank: row.rank,
            label: await staffDisplayName(
                client,
                config,
                row.member.staff.discordId,
                `<@${row.member.staff.discordId}>`
            ),
            activityMinutes: row.minutes,
            target: config.weeklyTargetMinutes,
            state: row.member.rollup.ringState,
            isViewer: false,
            onLeave: row.onLeave
        });
    }

    return leaderboardCard({
        title: "Weekly leaderboard",
        windowLabel: `Week of ${labelWindow(week.start, week.end, config.accountingTimezone)}`,
        rows: views,
        viewerRow: null,
        page: 1,
        pageCount: 1,
        scope: "log",
        totalMinutes: rows.reduce((sum, row) => sum + row.minutes, 0),
        participants: rows.length,
        footnote: leaderboardVisibility({
            privileged: false,
            viewerHidden: false,
            hiddenCount
        }).note
    });
}

/**
 * Post it, once per week, ever. The same receipt rule as the team recap: built
 * before the claim, because a claim is spent whether or not anything posts, and
 * a failed send is logged rather than retried, because retrying is how a week
 * gets posted twice.
 */
export async function postLeaderboardLog(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<boolean> {
    if (!config.leaderboardLogChannelId) return false;

    const channel = await staffChannel(client, config, config.leaderboardLogChannelId);
    if (!channel) {
        log.warn("leaderboardLogChannelId is set but the channel could not be fetched.");
        return false;
    }

    const card = await buildLeaderboardLog(client, config, week);
    if (!card) return false;

    if (!(await claimLeaderboardLog(week.start))) return false;

    try {
        // Names are display names, but a member with no fetchable name falls
        // back to a mention, and a record of last week should ping nobody.
        await channel.send({ ...card, allowedMentions: { parse: [] } });
    } catch (error) {
        log.error(
            `The leaderboard log for the week starting ${week.start.toISOString()} could not ` +
                "be posted. Its receipt is spent, so it will not be posted automatically later.",
            error
        );
        return false;
    }
    return true;
}
