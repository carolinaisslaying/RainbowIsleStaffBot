import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import {
    computeStreak,
    currentWeekStats,
    leaveNoteFor,
    weekWindowFor
} from "../domain/weekly.js";
import { isLeadOrAbove } from "../domain/permissions.js";
import { errorCard, noticeCard, ringCard } from "../render/cards.js";
import { fetchMember } from "../discord/roles.js";
import { defer, respond } from "../discord/respond.js";

export const ringsCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("rings")
        .setDescription("Show this week's activity rings")
        .addUserOption((option) =>
            option
                .setName("user")
                .setDescription("Whose rings. Defaults to you.")
                .setRequired(false)
        ),

    async execute({ client, config, interaction, staff, member, tier }) {
        const target = interaction.options.getUser("user");
        const isSelf = !target || target.id === interaction.user.id;

        // Self is always permitted. Anyone else needs Lead or Executive.
        if (!isSelf && !isLeadOrAbove(tier)) {
            await respond(
                interaction,
                errorCard("Viewing another member's rings requires Lead or Executive.")
            );
            return;
        }

        await defer(interaction, false);

        const subject = isSelf ? staff : await findStaffByDiscordId(target.id);
        if (!subject) {
            await respond(
                interaction,
                noticeCard(
                    "No staff record",
                    `<@${target?.id}> is not tracked as Moderation staff.`
                )
            );
            return;
        }

        const subjectMember = isSelf
            ? member
            : await fetchMember(client, config.publicGuildId, subject.discordId);

        const window = weekWindowFor(new Date(), config);
        const stats = await currentWeekStats(subject._id, config);
        const streak = await computeStreak(subject._id, config);

        await respond(
            interaction,
            ringCard({
                staffId: subject._id.toHexString(),
                displayName: subjectMember?.displayName ?? interaction.user.username,
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
                footnote: leaveNoteFor(stats)
            })
        );
    }
};
