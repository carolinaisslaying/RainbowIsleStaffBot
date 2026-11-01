import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { tryDm } from "../discord/roles.js";
import { noticeCard } from "../render/cards.js";
import { EMOJI } from "../render/emoji.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * Tell the deployment's administrators something is wrong, by DM. Named by
 * `BOOTSTRAP_ADMIN_IDS`, because those are the people who can act on a fault, and
 * a card in a channel would be read by Executives who cannot. With nobody named
 * it stays in the log, where it already is.
 */
export async function alertAdmins(client: Client, title: string, body: string): Promise<void> {
    const card = noticeCard(title, body, { colour: COLOUR.adverse, emoji: EMOJI.warning });
    for (const id of env.bootstrapAdminIds) {
        if (!(await tryDm(client, id, { ...card }))) {
            log.warn(`Could not DM administrator ${id} about: ${title}`);
        }
    }
}
