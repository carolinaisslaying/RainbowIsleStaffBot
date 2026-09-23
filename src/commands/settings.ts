import {
    AttachmentBuilder,
    ContainerBuilder,
    FileBuilder,
    MessageFlags,
    SlashCommandBuilder
} from "discord.js";
import type { Command, CommandContext } from "./types.js";
import {
    canonicaliseTimezone,
    describeZone,
    searchTimezones,
    zoneAbbreviation,
    zoneOffsetLabel,
    zoneWallClock
} from "../time/timezones.js";
import { setLeaderboardOptOut } from "../domain/staff.js";
import { exportDays } from "../domain/activity.js";
import { shiftHistory } from "../domain/shifts.js";
import { allWeeksFor } from "../domain/weekly.js";
import { assessmentHistory, warningsFor } from "../domain/assessments.js";
import { leaveHistory } from "../domain/leave.js";
import { audit } from "../domain/audit.js";
import {
    errorCard,
    faceSetupCard,
    noticeCard,
    text,
    timezoneConfirmCard
} from "../render/cards.js";
import { FACES } from "../render/faces.js";
import { COLOUR } from "../render/theme.js";
import { defer, respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";

export const settingsCommand: Command = {
    tier: "staff",
    subcommands: {
        // The only thing an un-onboarded member may run, for obvious reasons.
        timezone: { bypassOnboarding: true }
    },
    data: new SlashCommandBuilder()
        .setName("settings")
        .setDescription("Your timezone, ring colours, leaderboard privacy and data")
        .addSubcommand((sub) =>
            sub
                .setName("timezone")
                .setDescription("Set your timezone. Display only; it never affects your totals.")
                .addStringOption((option) =>
                    option
                        .setName("zone")
                        .setDescription(
                            "Type a code (NZST), an offset (+12), or a region (Pacific)"
                        )
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("face").setDescription("Choose the colours your rings are drawn in")
        )
        .addSubcommand((sub) =>
            sub
                .setName("privacy")
                .setDescription("Choose whether other Moderators can see you on the leaderboard")
                .addBooleanOption((option) =>
                    option
                        .setName("hide-me")
                        .setDescription(
                            "True hides you from other Moderators. Leads and Executives still " +
                                "see you."
                        )
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("export").setDescription("Download everything held about you")
        ),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused();
        const now = new Date();
        // Each row carries the code, the offset and the current local time, so
        // a member recognises their own zone at a glance instead of reasoning
        // about which city they are nearest.
        await interaction.respond(
            searchTimezones(focused, 25, now).map((zone) => ({
                name: describeZone(zone, now),
                value: zone
            }))
        );
    },

    async execute(context) {
        const { interaction, staff } = context;
        const sub = interaction.options.getSubcommand();

        if (sub === "timezone") {
            await setTimezone(context);
            return;
        }

        // The same picker the onboarding gate shows, so there is one place a
        // face is chosen and one card that describes the choice.
        if (sub === "face") {
            await respond(interaction, faceSetupCard(FACES, interaction.guildId));
            return;
        }

        if (sub === "export") {
            await exportData(context);
            return;
        }

        // privacy. This sets a preference and never shows a leaderboard.
        const hide = interaction.options.getBoolean("hide-me", true);
        await setLeaderboardOptOut(staff._id, hide);
        const leaderboard = cmd("stats leaderboard", interaction.guildId);
        await respond(
            interaction,
            noticeCard(
                hide ? "Hidden from other Moderators" : "Visible to everyone",
                (hide
                    ? `Your row is gone from ${leaderboard} for ` +
                      "other Moderators. You still see your own position there, and Leads " +
                      "and Executives still see you, marked as hidden.\n\nWhile anyone " +
                      "is hidden, your copy of the leaderboard and theirs arrive privately, " +
                      "where only the reader can see them."
                    : `Your row is back on ${leaderboard} for ` +
                      "everyone, and your leaderboard goes back to posting in the channel.") +
                    "\n\n-# This is a display preference and nothing more. Your minutes " +
                    "count either way, and fortnight assessment is unchanged.",
                { ephemeral: true }
            )
        );
    }
};

async function setTimezone({ interaction }: CommandContext): Promise<void> {
    const requested = interaction.options.getString("zone", true);
    // Store the spelling this runtime canonicalises to, so an alias typed by
    // hand does not become an unmatchable value later.
    const zone = canonicaliseTimezone(requested);
    if (!zone) {
        await respond(
            interaction,
            errorCard(
                `**${requested}** is not a timezone this bot recognises.\n\n` +
                    "Pick one from the list as you type. A plain offset such as " +
                    "**UTC+13** carries no daylight saving rules, so it would drift for " +
                    "half the year. The bot rejects those on purpose."
            )
        );
        return;
    }
    // Confirm against their own clock before storing anything, so a mistake
    // shows up now rather than a fortnight later.
    const now = new Date();
    await respond(
        interaction,
        timezoneConfirmCard(zone, now, {
            abbreviation: zoneAbbreviation(zone, now),
            offset: zoneOffsetLabel(zone, now),
            zoneTime: zoneWallClock(zone, now)
        })
    );
}

/**
 * Privacy Act 2020, IPP 6: an individual may ask for the personal information
 * held about them. This returns all of it, to the person themselves, without
 * anyone having to think about it.
 */
async function exportData({ interaction, staff }: CommandContext): Promise<void> {
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
            "Everything this bot holds about you. Activity is stored as which minutes of " +
            "each day (UTC) counted; setMinutes lists them. The bot never reads or keeps " +
            "what you write.",
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
                    "-# Only you can see this. Nothing here is deleted by any command. " +
                    "Ask an Executive if you need a record removed."
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
