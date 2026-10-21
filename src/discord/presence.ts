import type { Client } from "discord.js";
import { readStatus, type SeenStatus } from "../domain/presence.js";
import { log } from "../log.js";

/**
 * Members the bot asked Discord about directly and found offline. Discord sends
 * no presence for an offline member, so the answer to a direct question is an
 * absence, and this is where it is kept. A cached presence always wins, so the
 * next PresenceUpdate overrides an entry here without it being cleared.
 */
const confirmedOffline = new Set<string>();

/** One direct question per member at a time; a burst of messages asks once. */
const inFlight = new Map<string, Promise<SeenStatus | null>>();

/**
 * A failed question is not asked again for a minute. The unknown-sender path in
 * messageCreate asks on a message, and a rate limit answered by asking again on
 * every message would only extend it.
 */
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 60_000;

/** Long enough for one chunk, short enough to answer an interaction. */
const CONFIRM_TIMEOUT_MS = 10_000;

const keyOf = (guildId: string, userId: string) => `${guildId}:${userId}`;

/**
 * A member's status in the public guild, from the gateway's presence cache,
 * without asking Discord anything.
 *
 * `null` means unknown: the guild is unavailable, or Discord has not sent this
 * member's presence since the bot connected. It used to mean offline in the
 * second case, on the belief that Discord sends every non-offline presence on
 * connect. It does not for a guild this size, so after every restart the
 * online members were all read as invisible until they next changed status.
 * See domain/presence.ts.
 */
export function presenceStatusOf(
    client: Client,
    guildId: string,
    userId: string
): SeenStatus | null {
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) return null;
    return readStatus(
        guild.presences.cache.get(userId)?.status,
        confirmedOffline.has(keyOf(guildId, userId))
    );
}

/**
 * The cache's answer when it has one, otherwise Discord's. Asks with a
 * single-member Request Guild Members carrying presences: a member who comes
 * back without one is offline. REST has no presence endpoint, so this is the
 * only way to ask. `null` when the guild is unavailable or the question fails,
 * a rate limit included, so callers treat it as unknown and act on nothing.
 */
export async function confirmPresence(
    client: Client,
    guildId: string,
    userId: string
): Promise<SeenStatus | null> {
    const known = presenceStatusOf(client, guildId, userId);
    if (known !== null) return known;

    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) return null;

    const key = keyOf(guildId, userId);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const failed = failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return null;

    const question = (async (): Promise<SeenStatus | null> => {
        try {
            await guild.members.fetch({
                user: [userId],
                withPresences: true,
                time: CONFIRM_TIMEOUT_MS
            });
            failedAt.delete(key);
            const cached = guild.presences.cache.get(userId)?.status;
            if (cached === undefined) confirmedOffline.add(key);
            return readStatus(cached, cached === undefined);
        } catch (error) {
            failedAt.set(key, Date.now());
            log.warn(`Could not confirm the presence of ${userId}`, error);
            return null;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, question);
    return question;
}
