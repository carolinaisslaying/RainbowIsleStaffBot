import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { sotwEnabled } from "../domain/staffOfWeek.js";
import { errorCard } from "../render/cards.js";
import { sotwRemoveModal } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { defer, respond } from "../discord/respond.js";
import { currentHolder, nameOf } from "../services/sotwContext.js";
import { offerOrSet, skipNextWeek, viewFor } from "../services/sotwDecisions.js";

/**
 * Staff of the Week, for the Executives. The discussion happens in their own
 * chat; this records what they decided. Wholly Executive, so a pending pick is
 * never shown to anybody it might be about.
 */
export const sotwCommand: Command = {
    tier: "executive",
    data: new SlashCommandBuilder()
        .setName("sotw")
        .setDescription("Staff of the Week: pick, skip, remove or view (Executive)")
        .addSubcommand((sub) =>
            sub
                .setName("set")
                .setDescription("Pick next week's Staff of the Week")
                .addUserOption((option) => option.setName("user").setDescription("Who").setRequired(true))
                .addStringOption((option) =>
                    option.setName("reason").setDescription("Why, for the other Executives").setMaxLength(500)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("skip")
                .setDescription("Nobody holds it next week, and there is no draw")
                .addStringOption((option) => option.setName("reason").setDescription("Why").setMaxLength(500))
        )
        .addSubcommand((sub) => sub.setName("remove").setDescription("Take it from this week's holder"))
        .addSubcommand((sub) => sub.setName("view").setDescription("Who holds it, who is next, who is eligible")),

    async execute({ client, config, interaction }) {
        if (!sotwEnabled(config)) {
            await respond(
                interaction,
                sotwCard(
                    "Staff of the Week is not set up",
                    "Its role has not been chosen yet, so there is nothing to pick. A deployment " +
                        "administrator sets it in the configuration.",
                    { ephemeral: true }
                )
            );
            return;
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "remove") {
            // A modal cannot follow a defer, so this checks and opens only.
            const holder = await currentHolder(config);
            if (!holder) {
                await respond(interaction, errorCard("Nobody holds Staff of the Week right now."));
                return;
            }
            await interaction.showModal(sotwRemoveModal(await nameOf(client, config, holder.staff)));
            return;
        }

        await defer(interaction, true);

        if (sub === "view") {
            await respond(interaction, await viewFor(client, config));
            return;
        }

        const reason = interaction.options.getString("reason");
        if (sub === "skip") {
            await respond(interaction, await skipNextWeek(client, config, interaction.user.id, reason));
            return;
        }

        const user = interaction.options.getUser("user", true);
        const subject = await findStaffByDiscordId(user.id);
        if (!subject) {
            await respond(interaction, errorCard(`<@${user.id}> is not tracked as Moderation staff.`));
            return;
        }
        await respond(interaction, await offerOrSet(client, config, interaction.user.id, subject, reason));
    }
};
