import {
    MessageFlags,
    type ChatInputCommandInteraction,
    type ButtonInteraction,
    type ModalSubmitInteraction,
    type InteractionEditReplyOptions,
    type InteractionReplyOptions
} from "discord.js";
import type { RenderedMessage } from "../render/cards.js";

/**
 * Sending a Components V2 message differs between reply and editReply: a reply
 * may carry Ephemeral, an edit may not, and both must keep IsComponentsV2.
 * Getting that wrong is a runtime 400, so it is centralised here rather than
 * repeated with casts at every call site.
 */

type Repliable =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction;

function replyOptions(message: RenderedMessage): InteractionReplyOptions {
    return {
        components: message.components,
        files: message.files,
        flags: message.flags
    } as InteractionReplyOptions;
}

function editOptions(message: RenderedMessage): InteractionEditReplyOptions {
    // Ephemeral is fixed at defer time and must not be repeated on the edit.
    return {
        components: message.components,
        files: message.files,
        flags: MessageFlags.IsComponentsV2
    } as InteractionEditReplyOptions;
}

/** Reply, or edit the deferred reply, whichever this interaction needs. */
export async function respond(
    interaction: Repliable,
    message: RenderedMessage
): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(editOptions(message));
        return;
    }
    await interaction.reply(replyOptions(message));
}

/** Defer with the right ephemerality for the card that is coming. */
export async function defer(
    interaction: Repliable,
    isEphemeral: boolean
): Promise<void> {
    if (interaction.deferred || interaction.replied) return;
    await interaction.deferReply(
        isEphemeral ? { flags: MessageFlags.Ephemeral } : {}
    );
}

/**
 * Answer on the card the modal was opened from.
 *
 * A modal submitted from a button is its own interaction, so deferring a *reply*
 * opens a second ephemeral message and leaves the card that asked sitting above
 * it — with its buttons still live, so the same run could be started again over
 * rows the first had just decided. Deferring an *update* edits that card
 * instead, which is the rule every other card here follows.
 *
 * Guarded rather than assumed: a modal that arrived without a message, or from a
 * public one, must not have that message overwritten with somebody's ephemeral
 * progress card.
 */
export async function deferOntoOwnCard(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.deferUpdate();
        return;
    }
    await defer(interaction, true);
}

export async function followUp(
    interaction: Repliable,
    message: RenderedMessage
): Promise<void> {
    await interaction.followUp(replyOptions(message));
}

export function sendOptions(message: RenderedMessage): Record<string, unknown> {
    return {
        components: message.components,
        files: message.files,
        flags: MessageFlags.IsComponentsV2
    };
}
