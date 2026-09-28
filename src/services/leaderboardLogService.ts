import type { Client, SendableChannels } from "discord.js";
import { collections } from "../db/client.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc, WeeklyStatsDoc } from "../db/types.js";
import type { WeekWindow } from "../domain/weekly.js";
import { leaderboardVisibility, logStandings } from "../domain/leaderboard.js";
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
 * An Executive record, in a channel only Executives read, so it lists everybody:
 * hidden members sit in their real place, marked with the padlock, as they do
 * on a Lead's copy of `/stats leaderboard`. It used to be the public view, which
 * left them out and ranked everyone beneath them wrongly. No buttons: every row
 * is on the one card, because a record that has to be paged is a record nobody
 * scrolls back through.
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

    const { rows, hiddenCount } = logStandings<{ staff: StaffDoc; rollup: WeeklyStatsDoc }>(
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
            onLeave: row.onLeave,
            hidden: row.hidden
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
            privileged: true,
            viewerHidden: false,
            hiddenCount,
            executiveRecord: true
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
    const channel = await logChannel(client, config);
    if (!channel) return false;

    const card = await buildLeaderboardLog(client, config, week);
    if (!card) return false;

    if (!(await claimLeaderboardLog(week.start))) return false;

    try {
        await sendLog(channel, card);
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

export type ResendResult =
    | { ok: true; url: string }
    | { ok: false; reason: "unset" | "channel" | "empty" };

/**
 * `/admin leaderboard-log`: post a closed week's log again, now. The same card
 * the week close builds, and no receipt, because the Executive asking for it is
 * the deliberate act the receipt exists to stand in for. It posts beside the
 * old copy rather than replacing it: the bot keeps no record of that message.
 * A failed send throws, so the command can say so to the person who asked.
 */
export async function resendLeaderboardLog(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<ResendResult> {
    if (!config.leaderboardLogChannelId) return { ok: false, reason: "unset" };
    const channel = await logChannel(client, config);
    if (!channel) return { ok: false, reason: "channel" };

    const card = await buildLeaderboardLog(client, config, week);
    if (!card) return { ok: false, reason: "empty" };

    const message = await sendLog(channel, card);
    return { ok: true, url: message.url };
}

async function logChannel(client: Client, config: StaffBotConfig) {
    if (!config.leaderboardLogChannelId) return null;
    const channel = await staffChannel(client, config, config.leaderboardLogChannelId);
    if (!channel) {
        log.warn("leaderboardLogChannelId is set but the channel could not be fetched.");
    }
    return channel;
}

function sendLog(channel: SendableChannels, card: RenderedMessage) {
    // Names are display names, but a member with no fetchable name falls back
    // to a mention, and a record of a closed week should ping nobody.
    return channel.send({ ...card, allowedMentions: { parse: [] } });
}
