import { MessageFlags, type ButtonInteraction, type Client, type ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { findStaffById, findStaffByDiscordId } from "../domain/staff.js";
import { sotwEnabled } from "../domain/staffOfWeek.js";
import { formatColourCode, parseColourCode } from "../domain/sotwColour.js";
import { clearStaged, peekSet, stageColour, stagedColour, takeSet } from "../domain/sotwStaging.js";
import { errorCard, type RenderedMessage } from "../render/cards.js";
import { FIELD_CODE, FIELD_REASON, sotwCodeModal } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { deferOntoOwnCard, respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { grantRestOfWeek, removeHolder, setNextWeek } from "../services/sotwDecisions.js";
import { colourCardFor, saveStagedColour } from "../services/sotwColourService.js";

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
        await respond(interaction, errorCard(`That choice has expired. Run ${cmd("sotw set", interaction.guildId)} again.`));
        return;
    }
    if (staged.staffId !== stagedStaffId) {
        // Left staged: this card is the stale one, and whatever is actually
        // staged belongs to a fresher card that may still be open.
        await respond(interaction, errorCard(`That card is out of date. Run ${cmd("sotw set", interaction.guildId)} again.`));
        return;
    }

    const pending = takeSet(interaction.user.id);
    if (!pending) {
        await respond(interaction, errorCard(`That choice has expired. Run ${cmd("sotw set", interaction.guildId)} again.`));
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

/** `expectedStaffId` is the holder the modal was opened for, from its id. */
export async function handleSotwRemoveModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction,
    expectedStaffId: string
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
    await respond(
        interaction,
        await removeHolder(client, config, interaction.user.id, reason, expectedStaffId, interaction.guildId)
    );
}

/** Replace the card and its image, rather than stacking a second attachment. */
async function redraw(interaction: ButtonInteraction | ModalSubmitInteraction, card: RenderedMessage): Promise<void> {
    await interaction.editReply({
        components: card.components,
        files: card.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
    } as never);
}

/**
 * A member's own colour, holder or not: nothing here checks tier beyond
 * having a staff record at all, because `/settings sotw-colour` is open to
 * every member. Every gate that matters — whether saving would touch the
 * role — is re-derived inside `saveStagedColour` at the click, never carried
 * from the card that was drawn.
 */
export async function handleSotwColourButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string
): Promise<void> {
    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return;

    if (action === "code") {
        const staged = stagedColour(staff.discordId);
        const current = staged ? staged.colour : (staff.sotwColour ?? null);
        await interaction.showModal(sotwCodeModal(current ? formatColourCode(current) : null));
        return;
    }

    await interaction.deferUpdate();
    if (action === "clear") {
        stageColour(staff.discordId, null);
        await redraw(interaction, await colourCardFor(client, config, staff, { staged: { colour: null } }));
        return;
    }
    if (action === "cancel") {
        clearStaged(staff.discordId);
        await redraw(interaction, await colourCardFor(client, config, staff));
        return;
    }
    if (action === "save") {
        const message = await saveStagedColour(client, config, staff);
        const fresh = (await findStaffByDiscordId(staff.discordId)) ?? staff;
        const still = stagedColour(staff.discordId);
        await redraw(interaction, await colourCardFor(client, config, fresh, { staged: still, message }));
    }
}

export async function handleSotwCodeModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return;
    await deferOntoOwnCard(interaction);

    const parsed = parseColourCode(interaction.fields.getTextInputValue(FIELD_CODE));
    if (!parsed.ok) {
        await redraw(interaction, await colourCardFor(client, config, staff, { staged: stagedColour(staff.discordId), message: parsed.error }));
        return;
    }
    stageColour(staff.discordId, parsed.colour);
    await redraw(interaction, await colourCardFor(client, config, staff, { staged: { colour: parsed.colour } }));
}
