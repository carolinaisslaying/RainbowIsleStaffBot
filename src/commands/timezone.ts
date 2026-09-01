import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import {
    canonicaliseTimezone,
    describeZone,
    searchTimezones,
    zoneAbbreviation,
    zoneOffsetLabel,
    zoneWallClock
} from "../time/timezones.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { EMOJI } from "../render/emoji.js";
import { errorCard, noticeCard, timezoneConfirmCard } from "../render/cards.js";
import { isLeadOrAbove } from "../domain/permissions.js";
import { ts } from "../time/format.js";
import { respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";

export const timezoneCommand: Command = {
    tier: "staff",
    // The only command an un-onboarded member may run, for obvious reasons.
    bypassTimezoneGate: true,
    data: new SlashCommandBuilder()
        .setName("timezone")
        .setDescription("Set or view a display timezone")
        .addSubcommand((sub) =>
            sub
                .setName("set")
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
            sub
                .setName("view")
                .setDescription("View a timezone and current local time")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Whose timezone. Defaults to you.")
                        .setRequired(false)
                )
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

    async execute({ interaction, staff, tier }) {
        const sub = interaction.options.getSubcommand();

        if (sub === "set") {
            const requested = interaction.options.getString("zone", true);
            // Store the spelling this runtime canonicalises to, so an alias
            // typed by hand does not become an unmatchable value later.
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
            // Confirm against their own clock before storing anything, so a
            // mistake shows up now rather than a fortnight later.
            const now = new Date();
            await respond(
                interaction,
                timezoneConfirmCard(zone, now, {
                    abbreviation: zoneAbbreviation(zone, now),
                    offset: zoneOffsetLabel(zone, now),
                    zoneTime: zoneWallClock(zone, now)
                })
            );
            return;
        }

        const target = interaction.options.getUser("user");
        if (target && target.id !== interaction.user.id && !isLeadOrAbove(tier)) {
            await respond(
                interaction,
                errorCard("Viewing another member's timezone requires Lead or Executive.")
            );
            return;
        }

        const subject = target ? await findStaffByDiscordId(target.id) : staff;

        if (!subject || !subject.timezone) {
            await respond(
                interaction,
                noticeCard(
                    "No timezone on file",
                    target
                        ? `<@${target.id}> has not set a timezone yet.`
                        : `You have not set a timezone yet. Run ${cmd(
                              "timezone set",
                              interaction.guildId
                          )}.`,
                    { ephemeral: true }
                )
            );
            return;
        }

        await respond(
            interaction,
            noticeCard(
                "Timezone",
                `${target ? `<@${target.id}>` : "You"}: **${subject.timezone}**\n` +
                    `Current local time there is ${ts(new Date(), "F")}.\n\n` +
                    "-# Timezone changes what you see and nothing more. Totals, rings, " +
                    "leaderboard position and compliance run on the same UTC weeks for everyone.",
                { ephemeral: true, emoji: EMOJI.clock }
            )
        );
    }
};
