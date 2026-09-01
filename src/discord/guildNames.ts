import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { log } from "../log.js";

/**
 * Server names for user-facing prose.
 *
 * Fetched from Discord at startup so the bot always calls each server whatever
 * it is actually called, including after a rename. The constants below are only
 * a fallback for the window before the first fetch, and for the rare case where
 * a guild cannot be fetched at all.
 *
 * These are display strings. Nothing routes on them: guild resolution is always
 * by ID, from publicGuildId and staffGuildId.
 */

const FALLBACK_PUBLIC = "Rainbow Isle";
const FALLBACK_STAFF = "Rainbow Isle: Offices";

let publicName = FALLBACK_PUBLIC;
let staffName = FALLBACK_STAFF;

/** Rainbow Isle: where roles, tracked channels and message events live. */
export function publicGuildName(): string {
    return publicName;
}

/** Rainbow Isle: Offices: review cards, leave approvals, Executive reports. */
export function staffGuildName(): string {
    return staffName;
}

/** Called once at ready, and again after a config change to the guild IDs. */
export async function cacheGuildNames(client: Client, config: StaffBotConfig): Promise<void> {
    publicName = (await fetchName(client, config.publicGuildId)) ?? FALLBACK_PUBLIC;
    staffName = (await fetchName(client, config.staffGuildId)) ?? FALLBACK_STAFF;
    log.info(`Server names resolved: public "${publicName}", staff "${staffName}"`);
}

async function fetchName(client: Client, guildId: string): Promise<string | null> {
    if (!guildId) return null;
    try {
        const guild = await client.guilds.fetch(guildId);
        return guild.name;
    } catch (error) {
        log.warn(`Could not resolve the name of guild ${guildId}; using the fallback.`, error);
        return null;
    }
}

/** Test seam, and the reset used when guild IDs change. */
export function setGuildNamesForTest(publicValue: string, staffValue: string): void {
    publicName = publicValue;
    staffName = staffValue;
}

export { FALLBACK_PUBLIC, FALLBACK_STAFF };
