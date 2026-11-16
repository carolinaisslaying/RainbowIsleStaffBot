import { ContainerBuilder, MessageFlags } from "discord.js";
import { V2_FLAGS, separator, text, type RenderedMessage } from "./cards.js";
import { COLOUR } from "./theme.js";
import { emojiForColour } from "./emoji.js";

/**
 * The card `/callmod` posts in the channel it was run in, read by the whole
 * community. Its wording is the community team's, kept as it was given.
 *
 * The ping sits as subtext under the footnotes so it reads with them rather
 * than as a line of its own. A role mention in subtext still pings; whether it
 * does is decided by `allowedMentions` on the send, not by the markdown.
 */
export function callModCard(pingRoleId: string): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.callMod)
        .addTextDisplayComponents(
            text(
                `# ${emojiForColour(COLOUR.callMod)} Moderators Called\n` +
                    "Moderators have been called to this channel and will be here shortly.\n\n" +
                    "**Please wait for moderators to arrive.** Do not re-call moderators if no " +
                    "moderators respond. They will attend the situation and decide if anyone " +
                    "needs to be punished."
            )
        )
        .addSeparatorComponents(separator(true))
        .addTextDisplayComponents(
            text(
                "-# The `/callmod` command should only be used in the event of discriminatory " +
                    "behaviour, slurs, raider, or other serious rule breach."
            ),
            text(
                "-# You can report an individual message by reacting to it with " +
                    "<:reportmessage:917858551223967775> at any time."
            )
        );

    if (pingRoleId) container.addTextDisplayComponents(text(`-# <@&${pingRoleId}>`));

    return { components: [container], files: [], flags: V2_FLAGS };
}

/** A cooldown refusal: one line, seen only by whoever ran it. */
export function callModRefusalCard(body: string): RenderedMessage {
    return {
        components: [new ContainerBuilder().setAccentColor(COLOUR.callMod).addTextDisplayComponents(text(body))],
        files: [],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}
