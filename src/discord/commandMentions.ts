import { log } from "../log.js";

/**
 * Clickable slash command mentions.
 *
 * Discord renders `</name subcommand:id>` as a real, clickable command chip.
 * The id is always the ROOT command's id, even when mentioning a subcommand.
 *
 * Guild commands get a different id in every guild they are registered in, so
 * the registry is keyed by guild. A mention carrying the wrong guild's id does
 * not fail loudly, it just renders as raw text, which is worse than plain
 * backticks. So when an id cannot be resolved for the relevant guild this falls
 * back to `/command`, which is never wrong, only less pretty.
 */

/** Scope key for the global, direct-message registration. */
export const GLOBAL_SCOPE = "global";

/** scope (guild id, or GLOBAL_SCOPE) -> root command name -> command id. */
const registry = new Map<string, Map<string, string>>();

/** Used when there is no guild context, such as a DM. */
let defaultGuildId = "";

export function setDefaultMentionGuild(guildId: string): void {
    defaultGuildId = guildId;
}

/** Record the ids Discord returned from a registration. */
export function recordCommandIds(
    scope: string,
    registered: { id: string; name: string }[]
): void {
    const byName = new Map<string, string>();
    for (const command of registered) {
        if (command?.id && command?.name) byName.set(command.name, command.id);
    }
    registry.set(scope, byName);
    log.debug(`Recorded ${byName.size} command ids for scope ${scope}`);
}

function lookup(root: string, guildId: string | null | undefined): string | null {
    // In a guild, that guild's registration is the only one whose ids resolve.
    // In a DM there is no guild, so the global registration is the right one,
    // and the staff guild is a last resort for a message a member will read
    // there anyway.
    const candidates = guildId
        ? [guildId, defaultGuildId]
        : [GLOBAL_SCOPE, defaultGuildId];
    for (const candidate of candidates.filter(Boolean) as string[]) {
        const id = registry.get(candidate)?.get(root);
        if (id) return id;
    }
    return null;
}

/**
 * `cmd("timezone set")` -> `</timezone set:1234>`, or `` `/timezone set` `` when
 * the id is not known yet.
 *
 * Pass the guild the message will be READ in. Omit it for a DM, which resolves
 * against the global registration instead.
 */
export function cmd(path: string, guildId?: string | null): string {
    const root = path.trim().split(/\s+/)[0];
    const id = lookup(root, guildId);
    // Bold rather than inline code: the fallback should read as a command
    // name in a sentence, not as a snippet in a terminal.
    return id ? `</${path.trim()}:${id}>` : `**/${path.trim()}**`;
}

/** Test seam. */
export function resetCommandMentions(): void {
    registry.clear();
    defaultGuildId = "";
}
