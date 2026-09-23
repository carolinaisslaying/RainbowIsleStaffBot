import { TextDisplayBuilder, type Client } from "discord.js";
import { collections } from "../db/client.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { V2_FLAGS } from "../render/cards.js";
import { log } from "../log.js";

/**
 * Telling the Executives that a card needs them.
 *
 * Discord never pings on an edit, and every card in this bot is edited in
 * place for its whole life, so a ping is a short reply to the card it is about.
 * The reply is deleted once the card no longer needs anyone, which keeps each
 * channel reading as one card per thing rather than a card and a trail of
 * stale pings beneath it.
 *
 * Keyed by what the ping is about: `leave:<id>`, `extension:<id>`,
 * `row:<assessmentId>`, `warning:<id>`, `review:<index>`, `restore:<leaveId>`.
 * A newer ping about the same thing replaces the older one.
 */

export interface MessageRef {
    channelId: string;
    messageId: string;
}

export const pingKey = {
    leave: (id: { toHexString(): string }) => `leave:${id.toHexString()}`,
    extension: (id: { toHexString(): string }) => `extension:${id.toHexString()}`,
    row: (id: { toHexString(): string }) => `row:${id.toHexString()}`,
    warning: (id: { toHexString(): string }) => `warning:${id.toHexString()}`,
    review: (index: number) => `review:${index}`,
    restore: (id: { toHexString(): string }) => `restore:${id.toHexString()}`
};

/**
 * The words of a ping, with the role in front. Without a role configured the
 * line still posts: a reminder nobody is pinged for is better than no
 * reminder, and `/config view` already says the role is unset.
 */
export function pingLine(roleId: string, line: string): string {
    return roleId ? `<@&${roleId}> ${line}` : line;
}

/**
 * Reply to a card, pinging the Executive role. Best effort throughout: the
 * card is the record, and a ping that fails to post must never undo the thing
 * it was announcing.
 */
export async function pingExecutives(
    client: Client,
    config: StaffBotConfig,
    key: string,
    target: MessageRef,
    line: string
): Promise<void> {
    await resolvePing(client, key);
    try {
        const channel = await client.channels.fetch(target.channelId);
        if (!channel?.isSendable()) return;
        const posted = await channel.send({
            components: [new TextDisplayBuilder().setContent(pingLine(config.staffExecutivePingRole, line))],
            flags: V2_FLAGS,
            reply: { messageReference: target.messageId, failIfNotExists: false },
            allowedMentions: {
                roles: config.staffExecutivePingRole ? [config.staffExecutivePingRole] : [],
                repliedUser: false
            }
        });
        await collections.pings().updateOne(
            { _id: key },
            { $set: { channelId: posted.channelId, messageId: posted.id, at: new Date() } },
            { upsert: true }
        );
    } catch (error) {
        log.warn(`Could not post the ping for ${key}`, error);
    }
}

/** Delete the outstanding ping about this thing, if there is one. */
export async function resolvePing(client: Client, key: string): Promise<void> {
    const ping = await collections.pings().findOneAndDelete({ _id: key });
    if (!ping) return;
    try {
        const channel = await client.channels.fetch(ping.channelId);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(ping.messageId);
        await message.delete();
    } catch (error) {
        // Deleted by hand already, or the channel is gone. Either way it is not
        // pinging anybody any more.
        log.debug(`Could not delete the ping for ${key}`, error);
    }
}
