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
 * Whether a path can be rendered as a mention at all.
 *
 * A mention is `</name group subcommand:id>`: one to three name segments and
 * nothing else. The colon before the id is the syntax, so a path carrying its
 * own colon produces two and Discord parses neither — `dev purge fortnight:1`
 * rendered as the literal text `</dev purge fortnight:1:1544…>` on a card an
 * Executive was meant to click.
 *
 * That is the same failure the guild-id mismatch has, and it is silent in the
 * same way: raw text where a chip should be, with nothing logged. So the shape
 * is checked rather than assumed, and an option value pasted into a path falls
 * back to bold like any other unresolvable mention.
 *
 * Discord's own rule for a command name: 1-32 characters, letters, digits,
 * hyphen and underscore.
 */
export function isMentionablePath(path: string): boolean {
    const segments = path.trim().split(/\s+/);
    if (segments.length < 1 || segments.length > 3) return false;
    return segments.every((segment) => /^[-_\p{L}\p{N}]{1,32}$/u.test(segment));
}

/**
 * `cmd("timezone set")` -> `</timezone set:1234>`, or `` **\/timezone set** ``
 * when the id is not known yet.
 *
 * Pass the guild the message will be READ in. Omit it for a DM, which resolves
 * against the global registration instead.
 *
 * The path is the command only. Arguments belong in the sentence around it:
 * there is no syntax for a mention that carries one.
 */
export function cmd(path: string, guildId?: string | null): string {
    const trimmed = path.trim();

    // Bold rather than inline code: the fallback should read as a command
    // name in a sentence, not as a snippet in a terminal.
    const fallback = `**/${trimmed}**`;

    if (!isMentionablePath(trimmed)) {
        log.warn(
            `Refusing to build a command mention for "${trimmed}": a mention carries the ` +
                "command path only, and anything else renders as raw text on the card. " +
                "Put the argument in the sentence instead."
        );
        return fallback;
    }

    const id = lookup(trimmed.split(/\s+/)[0], guildId);
    return id ? `</${trimmed}:${id}>` : fallback;
}

/** Test seam. */
export function resetCommandMentions(): void {
    registry.clear();
    defaultGuildId = "";
}
