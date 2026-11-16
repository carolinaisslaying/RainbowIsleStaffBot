import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { trackedChannelIds } from "../domain/trackedChannels.js";
import { log } from "../log.js";

/**
 * The concrete channels `trackedChannels` covers right now, with each tracked
 * category opened up into the channels inside it. Demand is stored per
 * channel, so this is what the coverage cards read by.
 *
 * If the community server cannot be read, the list is used as it stands:
 * directly tracked channels still show, and only a category's channels drop out.
 */
export async function resolveTrackedChannelIds(
    client: Client,
    config: StaffBotConfig
): Promise<string[]> {
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        const channels = await guild.channels.fetch();
        return trackedChannelIds(
            config.trackedChannels,
            [...channels.values()].flatMap((channel) =>
                channel ? [{ id: channel.id, parentId: channel.parentId }] : []
            )
        );
    } catch (error) {
        log.warn("Could not list community channels to expand tracked categories", error);
        return [...config.trackedChannels];
    }
}
