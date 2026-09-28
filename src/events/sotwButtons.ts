import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { findStaffById } from "../domain/staff.js";
import { takeSet } from "../domain/sotwStaging.js";
import { errorCard } from "../render/cards.js";
import { FIELD_REASON } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { deferOntoOwnCard, respond } from "../discord/respond.js";
import { grantRestOfWeek, removeHolder, setNextWeek } from "../services/sotwDecisions.js";

/** Every rule re-derived on the click, never carried from the card. */
async function isExecutive(client: Client, config: StaffBotConfig, userId: string): Promise<boolean> {
    return resolveTier(userId, await fetchPublicMember(client, config, userId), config) === "executive";
}

export async function handleSotwButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string
): Promise<void> {
    if (!(await isExecutive(client, config, interaction.user.id))) {
        await respond(interaction, errorCard("Staff of the Week is decided by the Executives."));
        return;
    }
    await interaction.deferUpdate();

    const pending = takeSet(interaction.user.id);
    if (action === "cancel") {
        await respond(interaction, sotwCard("Nothing recorded", "Staff of the Week is unchanged."));
        return;
    }
    if (!pending) {
        await respond(interaction, errorCard("That choice has expired. Run the set command again."));
        return;
    }
    const subject = await findStaffById(new ObjectId(pending.staffId));
    if (!subject) {
        await respond(interaction, errorCard("That member no longer has a staff record."));
        return;
    }
    const card =
        action === "rest"
            ? await grantRestOfWeek(client, config, interaction.user.id, subject, pending.reason)
            : await setNextWeek(client, config, interaction.user.id, subject, pending.reason);
    await respond(interaction, card);
}

export async function handleSotwRemoveModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    if (!(await isExecutive(client, config, interaction.user.id))) {
        await respond(interaction, errorCard("Staff of the Week is decided by the Executives."));
        return;
    }
    await deferOntoOwnCard(interaction);
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
    await respond(interaction, await removeHolder(client, config, interaction.user.id, reason));
}
