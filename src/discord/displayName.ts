import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchMember } from "./roles.js";

/**
 * The one place a person's name is resolved for display.
 *
 * Roles live in the public guild, so every permission check fetches the member
 * there, and that member object was already to hand at each call site. Printing
 * its `displayName` was therefore the path of least resistance, and it is the
 * member's *community* nickname. A moderator the staff room knows as one name
 * was appearing under an unrelated community one on the leaderboard, in their
 * own weekly recap, and on the leave request an Executive was deciding.
 *
 * Every card the bot sends is read in the staff server or DMed to someone whose
 * frame of reference is the staff server, so the staff guild's nickname is the
 * name that gets printed. The public guild is the fallback, for someone who is
 * not in the staff server at all: still a name, and better than a raw handle.
 * `fallback` is the last resort, for someone in neither guild. That is usually
 * a departed member on a historical record.
 *
 * Neither fetch is a round trip in the normal case. discord.js serves both from
 * its member cache and keeps that cache current from GUILD_MEMBER_UPDATE, so a
 * nickname change in the staff server shows up on the next card without the bot
 * doing anything.
 */
/**
 * Which of the candidate names wins, in order, given the last resort.
 *
 * Pure, and separated from the fetching so the precedence rule can be tested
 * without a Discord fixture. A name that is blank or only whitespace is not a
 * name: it falls through rather than rendering a card with an empty bold line
 * where the member should be.
 */
export function preferredName(
    candidates: (string | null | undefined)[],
    fallback: string
): string {
    for (const candidate of candidates) {
        const trimmed = candidate?.trim();
        if (trimmed) return trimmed;
    }
    return fallback;
}

export async function staffDisplayName(
    client: Client,
    config: StaffBotConfig,
    userId: string,
    fallback: string
): Promise<string> {
    const candidates: (string | null)[] = [];
    for (const guildId of [config.staffGuildId, config.publicGuildId]) {
        if (!guildId) continue;
        const member = await fetchMember(client, guildId, userId);
        candidates.push(member?.displayName ?? null);
    }
    return preferredName(candidates, fallback);
}
