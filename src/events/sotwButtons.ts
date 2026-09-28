import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { findStaffById } from "../domain/staff.js";
import { sotwEnabled } from "../domain/staffOfWeek.js";
import { peekSet, takeSet } from "../domain/sotwStaging.js";
import { errorCard } from "../render/cards.js";
import { FIELD_REASON } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { deferOntoOwnCard, respond } from "../discord/respond.js";
import { grantRestOfWeek, removeHolder, setNextWeek } from "../services/sotwDecisions.js";

/** Every rule re-derived on the click, never carried from the card. */
async function isExecutive(client: Client, config: StaffBotConfig, userId: string): Promise<boolean> {
    return resolveTier(userId, await fetchPublicMember(client, config, userId), config) === "executive";
}

/**
 * `rest`/`next` carry the staffId the card was drawn for. Staging is keyed by
 * the Executive alone, so a second `/sotw set` for somebody else — while the
 * first card is still sitting there — replaces what is staged; the id on the
 * button is what stops the stale card from acting on that newer pick instead
 * of refusing. Checked with `peekSet`, not `takeSet`: a stale card must not
 * consume the pick a fresher card is still waiting on.
 */
export async function handleSotwButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string,
    stagedStaffId?: string
): Promise<void> {
    if (!(await isExecutive(client, config, interaction.user.id))) {
        await respond(interaction, errorCard("Staff of the Week is decided by the Executives."));
        return;
    }
    if (!sotwEnabled(config)) {
        await respond(interaction, errorCard("Staff of the Week is not set up."));
        return;
    }
    await interaction.deferUpdate();

    if (action === "cancel") {
        takeSet(interaction.user.id);
        await respond(interaction, sotwCard("Nothing recorded", "Staff of the Week is unchanged."));
        return;
    }

    const staged = peekSet(interaction.user.id);
    if (!staged) {
        await respond(interaction, errorCard("That choice has expired. Run the set command again."));
        return;
    }
    if (staged.staffId !== stagedStaffId) {
        // Left staged: this card is the stale one, and whatever is actually
        // staged belongs to a fresher card that may still be open.
        await respond(interaction, errorCard("That card is out of date. Run the set command again."));
        return;
    }

    const pending = takeSet(interaction.user.id);
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
    if (!sotwEnabled(config)) {
        await respond(interaction, errorCard("Staff of the Week is not set up."));
        return;
    }
    await deferOntoOwnCard(interaction);
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
    await respond(interaction, await removeHolder(client, config, interaction.user.id, reason));
}
