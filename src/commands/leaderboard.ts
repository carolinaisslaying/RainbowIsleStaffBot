import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import type { StaffDoc } from "../db/types.js";
import { collections } from "../db/client.js";
import { listActiveStaff } from "../domain/staff.js";
import { countMinutesBetween } from "../domain/activity.js";
import { staffFullyOnLeaveDuring } from "../domain/leave.js";
import { weekWindowFor } from "../domain/weekly.js";
import { currentFortnightIndex, windowForIndex } from "../domain/assessments.js";
import { ringStateFor } from "../domain/rings.js";
import { isLeadOrAbove } from "../domain/permissions.js";
import { leaderboardCard, type LeaderboardRowView } from "../render/cards.js";
import { describeRings, renderRings, ringsCacheKey } from "../render/rings.js";
import { currentWeekStats } from "../domain/weekly.js";
import { defer, respond } from "../discord/respond.js";
import { fetchMember } from "../discord/roles.js";
import { labelWindow } from "../time/format.js";

/** Page at 10 rows. The 40 component ceiling is not negotiable. */
const PAGE_SIZE = 10;

export type LeaderboardScope = "week" | "fortnight" | "alltime";

export interface LeaderboardEntry {
    staff: StaffDoc;
    minutes: number;
    onLeave: boolean;
}

export async function buildLeaderboard(
    scope: LeaderboardScope,
    config: import("../config/guildConfig.js").StaffBotConfig,
    now = new Date()
): Promise<{ entries: LeaderboardEntry[]; label: string; target: number }> {
    const staff = await listActiveStaff();

    if (scope === "alltime") {
        const rows = await collections
            .weeklyStats()
            .aggregate<{ _id: unknown; total: number }>([
                { $group: { _id: "$staffId", total: { $sum: "$activityMinutes" } } }
            ])
            .toArray();
        const totals = new Map(rows.map((row) => [String(row._id), row.total]));
        const entries = staff.map((member) => ({
            staff: member,
            minutes: totals.get(member._id.toHexString()) ?? 0,
            onLeave: false
        }));
        return { entries, label: "All time", target: config.weeklyTargetMinutes };
    }

    const window =
        scope === "week"
            ? weekWindowFor(now, config)
            : (() => {
                  const fortnight = windowForIndex(currentFortnightIndex(config, now), config);
                  return { start: fortnight.week1Start, end: fortnight.end };
              })();

    // Only leave covering the whole window reads as "on leave" here. Someone
    // whose leave ended mid-window worked the rest of it and is ranked on what
    // they earned, rather than being hidden behind a grey row.
    const onLeave = await staffFullyOnLeaveDuring(window.start, window.end);
    const entries: LeaderboardEntry[] = [];
    for (const member of staff) {
        entries.push({
            staff: member,
            minutes: await countMinutesBetween(member._id, window.start, window.end),
            onLeave: onLeave.has(member._id.toHexString())
        });
    }

    return {
        entries,
        label: `${scope === "week" ? "This week" : "This fortnight"}, ${labelWindow(
            window.start,
            window.end,
            config.accountingTimezone
        )}`,
        target:
            scope === "week"
                ? config.weeklyTargetMinutes
                : config.fortnightRequiredMinutes
    };
}

export const leaderboardCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Activity minutes leaderboard")
        .addStringOption((option) =>
            option
                .setName("scope")
                .setDescription("Which window. Defaults to this week.")
                .addChoices(
                    { name: "week", value: "week" },
                    { name: "fortnight", value: "fortnight" },
                    { name: "alltime", value: "alltime" }
                )
                .setRequired(false)
        )
        .addIntegerOption((option) =>
            option.setName("page").setDescription("Page number").setMinValue(1).setRequired(false)
        ),

    async execute({ client, config, interaction, staff, tier }) {
        await defer(interaction, false);

        const scope = (interaction.options.getString("scope") ?? "week") as LeaderboardScope;
        const page = interaction.options.getInteger("page") ?? 1;

        await respond(
            interaction,
            await renderLeaderboard(client, config, staff, tier, scope, page)
        );
    }
};

export async function renderLeaderboard(
    client: import("discord.js").Client,
    config: import("../config/guildConfig.js").StaffBotConfig,
    viewer: StaffDoc,
    tier: import("../domain/permissions.js").Tier,
    scope: LeaderboardScope,
    page: number
) {
    const { entries, label, target } = await buildLeaderboard(scope, config);

    // Opt-out is a display preference only, set with /staff privacy. Tracking
    // and assessment remain mandatory, and Lead and Executive views still show
    // everybody: a hidden row is marked rather than removed for them, so the
    // ranks they read are the real ranks.
    const privileged = isLeadOrAbove(tier);
    const visible = entries.filter(
        (entry) =>
            privileged ||
            !entry.staff.leaderboardOptOut ||
            entry.staff._id.equals(viewer._id)
    );

    const ranked = [...visible].sort((left, right) => right.minutes - left.minutes);

    const toView = async (
        entry: LeaderboardEntry,
        rank: number
    ): Promise<LeaderboardRowView> => {
        const member = await fetchMember(client, config.publicGuildId, entry.staff.discordId);
        return {
            rank,
            label: member?.displayName ?? `<@${entry.staff.discordId}>`,
            activityMinutes: entry.minutes,
            target,
            state: ringStateFor({
                activityMinutes: entry.minutes,
                weeklyTargetMinutes: target,
                amberThresholdPercent: config.amberThresholdPercent,
                onLeave: entry.onLeave
            }),
            isViewer: entry.staff._id.equals(viewer._id),
            onLeave: entry.onLeave,
            hidden: privileged && entry.staff.leaderboardOptOut
        };
    };

    const pageCount = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), pageCount);
    const slice = ranked.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    const rows: LeaderboardRowView[] = [];
    for (let index = 0; index < slice.length; index += 1) {
        rows.push(await toView(slice[index], (safePage - 1) * PAGE_SIZE + index + 1));
    }

    // The viewer's own row is pinned at the bottom regardless of position.
    const viewerIndex = ranked.findIndex((entry) => entry.staff._id.equals(viewer._id));
    const viewerRow =
        viewerIndex >= 0 ? await toView(ranked[viewerIndex], viewerIndex + 1) : null;

    const optedOut = entries.filter((entry) => entry.staff.leaderboardOptOut).length;
    const hiddenFromViewer = entries.length - visible.length;

    // The viewer's own rings ride along with their pinned row, so the card
    // answers "where am I" and "how am I doing" in one glance.
    const window = weekWindowFor(new Date(), config);
    const viewerStats = await currentWeekStats(viewer._id, config);
    const ringsInput = {
        activityMinutes: viewerStats.activityMinutes,
        activityTarget: config.weeklyTargetMinutes,
        shiftHours: viewerStats.shiftMs / 3_600_000,
        shiftTarget: config.weeklyShiftTargetHours,
        activeDays: viewerStats.activeDays,
        activeDaysTarget: config.weeklyActiveDaysTarget,
        state: viewerStats.ringState,
        softRingsEnabled: config.softRingsEnabled,
        cacheKey: ringsCacheKey(viewer._id.toHexString(), window.start, {
            activityMinutes: viewerStats.activityMinutes,
            shiftHours: Math.round((viewerStats.shiftMs / 3_600_000) * 100) / 100,
            activeDays: viewerStats.activeDays,
            state: viewerStats.ringState,
            softRingsEnabled: config.softRingsEnabled
        })
    };

    return leaderboardCard({
        title: "Activity leaderboard",
        windowLabel: label,
        rows,
        viewerRow,
        page: safePage,
        pageCount,
        scope,
        totalMinutes: ranked.reduce((sum, entry) => sum + entry.minutes, 0),
        participants: ranked.length,
        viewerRings: { png: renderRings(ringsInput), alt: describeRings(ringsInput) },
        footnote: privileged
            ? optedOut > 0
                ? `${optedOut} member(s) are marked hidden. You see them because you are Lead ` +
                  "or Executive; other Moderators do not."
                : undefined
            : hiddenFromViewer > 0
              ? `${hiddenFromViewer} member(s) have hidden themselves. Their minutes still ` +
                "count, and Leads and Executives still see them."
              : undefined
    });
}
