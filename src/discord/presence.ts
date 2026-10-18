import type { Client } from "discord.js";
import type { SeenStatus } from "../domain/presence.js";

/**
 * A member's status in the public guild, from the gateway's presence cache.
 *
 * Discord sends a large guild's presences for its non-offline members only, so
 * a member with no cached presence is offline. `null` means the guild itself
 * is missing or unavailable, the one case where the cache says nothing about
 * the member.
 *
 * REST has no presence endpoint. The gateway keeps this cache current through
 * PresenceUpdate.
 */
export function presenceStatusOf(
    client: Client,
    guildId: string,
    userId: string
): SeenStatus | null {
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) return null;
    return guild.presences.cache.get(userId)?.status ?? "offline";
}
