import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { getOpenShift, openPauseOf, stateOf } from "../domain/shifts.js";
import { beginShift, finishShift } from "../services/shiftService.js";
import { noticeCard } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { formatDuration, ts } from "../time/format.js";
import { publicGuildName } from "../discord/guildNames.js";
import { cmd } from "../discord/commandMentions.js";

/** When an away shift closes itself, from the moment the pause opened. */
function autoEndAt(pausedFrom: Date, config: { autoEndAfterAwayMinutes: number }): Date {
    return new Date(pausedFrom.getTime() + config.autoEndAfterAwayMinutes * 60_000);
}

export const shiftCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("shift")
        .setDescription("Start, end or check your moderation shift")
        .addSubcommand((sub) => sub.setName("start").setDescription("Go on shift"))
        .addSubcommand((sub) => sub.setName("end").setDescription("End your shift"))
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Check your current shift")
        ),

    async execute({ client, config, interaction, staff, member }) {
        const sub = interaction.options.getSubcommand();
        const displayName = member?.displayName ?? interaction.user.username;

        if (sub === "start") {
            await defer(interaction, true);
            const result = await beginShift(client, config, staff, displayName);
            await respond(interaction, result.card);
            return;
        }

        if (sub === "end") {
            await defer(interaction, true);
            const card = await finishShift(client, config, staff, displayName, "manual");
            await respond(
                interaction,
                card ?? noticeCard("No open shift", "You are not on shift right now.")
            );
            return;
        }

        const open = await getOpenShift(staff._id);
        const state = stateOf(open);

        if (!open) {
            await respond(
                interaction,
                noticeCard(
                    "Not on shift",
                    `Run ${cmd("shift start", interaction.guildId)} when you are ready.`,
                    { ephemeral: true }
                )
            );
            return;
        }

        const pause = openPauseOf(open);
        const elapsed = Date.now() - open.startedAt.getTime();

        await respond(
            interaction,
            noticeCard(
                state === "away" ? "On shift, marked away" : "On shift, available",
                `Started ${ts(open.startedAt, "t")}, ${ts(open.startedAt, "R")}.\n` +
                    `Open for ${formatDuration(elapsed)} across ${open.pauses.length} ` +
                    `${open.pauses.length === 1 ? "pause" : "pauses"}.\n` +
                    (pause
                        ? `\nAway since ${ts(pause.from, "t")}, ${ts(pause.from, "R")}. Send a ` +
                          "message in any public channel, or come back online, and you will be " +
                          "available again.\n\n" +
                          `**Your shift ends itself ${ts(autoEndAt(pause.from, config), "R")}** ` +
                          `if you are still away then, ${config.autoEndAfterAwayMinutes} ` +
                          "minutes after you went away. You do not need to do anything for that."
                        : `\nYou have ${config.autoEndAfterAwayMinutes} minutes of being away ` +
                          "before a shift ends itself, so stepping out briefly costs you " +
                          "nothing."),
                { ephemeral: true }
            )
        );
    }
};
