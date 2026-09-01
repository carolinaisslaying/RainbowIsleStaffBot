import { AttachmentBuilder, ContainerBuilder, FileBuilder, SlashCommandBuilder, MessageFlags } from "discord.js";
import type { Command } from "./types.js";
import { exportDays } from "../domain/activity.js";
import { shiftHistory } from "../domain/shifts.js";
import { allWeeksFor } from "../domain/weekly.js";
import { assessmentHistory, warningsFor } from "../domain/assessments.js";
import { leaveHistory } from "../domain/leave.js";
import { collections } from "../db/client.js";
import { text } from "../render/cards.js";
import { defer } from "../discord/respond.js";
import { COLOUR } from "../render/theme.js";
import { audit } from "../domain/audit.js";

/**
 * Privacy Act 2020, IPP 6: an individual may ask for the personal information
 * held about them. This returns all of it, to the person themselves, without
 * anyone having to think about it.
 */
export const mydataCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("mydata")
        .setDescription("Your own data")
        .addSubcommand((sub) =>
            sub.setName("export").setDescription("Download everything held about you")
        ),

    async execute({ interaction, staff }) {
        await defer(interaction, true);

        const [days, shifts, weeks, assessments, warnings, leave] = await Promise.all([
            exportDays(staff._id),
            shiftHistory(staff._id, 10_000),
            allWeeksFor(staff._id),
            assessmentHistory(staff._id, 1000),
            warningsFor(staff._id),
            leaveHistory(staff._id)
        ]);

        const payload = {
            exportedAt: new Date().toISOString(),
            note:
                "Everything this bot holds about you. Activity minutes live as a bitmap of " +
                "UTC minutes per day, and setMinutes lists the credited minute-of-day indices. " +
                "The bot stores no message content and never asks Discord for the " +
                "MessageContent intent.",
            profile: {
                staffId: staff._id.toHexString(),
                discordId: staff.discordId,
                previousDiscordIds: staff.previousDiscordIds,
                timezone: staff.timezone,
                timezoneSetAt: staff.timezoneSetAt,
                joinedTeamAt: staff.joinedTeamAt,
                active: staff.active,
                leaderboardOptOut: staff.leaderboardOptOut,
                createdAt: staff.createdAt,
                updatedAt: staff.updatedAt
            },
            activityDays: days,
            shifts,
            weeklyStats: weeks,
            fortnightAssessments: assessments,
            warnings,
            leave
        };

        const json = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
        const fileName = `staffbot-export-${staff._id.toHexString()}.json`;
        const attachment = new AttachmentBuilder(json, { name: fileName });

        const container = new ContainerBuilder()
            .setAccentColor(COLOUR.personal)
            .addTextDisplayComponents(
                text(
                    `## Your data\n` +
                        `${days.length} recorded days, ${shifts.length} shifts, ` +
                        `${weeks.length} weekly rollups, ${assessments.length} assessments, ` +
                        `${warnings.length} warnings, ${leave.length} leave records.\n\n` +
                        "-# Only you can see this. No command deletes any of it. See " +
                        "DELETION.md in the repository for the purge procedure."
                )
            )
            .addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));

        await audit("mydata.export", { actorId: staff.discordId, targetStaffId: staff._id });

        await interaction.editReply({
            components: [container],
            files: [attachment],
            flags: MessageFlags.IsComponentsV2
        });
    }
};

export { collections };
