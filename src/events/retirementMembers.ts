import { Events, type Client } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { tierOf } from "../domain/permissions.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { applyLiveReading } from "../services/retirementService.js";
import { log } from "../log.js";

/**
 * Somebody leaving the community server, or their roles changing. The cached
 * staff lookup answers for the 110,000 members who are nothing to do with this,
 * and a member whose standing matches their record stops there.
 */
export function registerRetirementHandler(client: Client): void {
    client.on(Events.GuildMemberRemove, async (member) => {
        try {
            const config = await loadConfig();
            if (member.guild.id !== config.publicGuildId) return;
            const staff = await findStaffByDiscordId(member.id);
            if (staff) await applyLiveReading(client, config, member.guild, staff, null);
        } catch (error) {
            log.error(`Handling the departure of ${member.id} failed`, error);
        }
    });

    client.on(Events.GuildMemberUpdate, async (_before, after) => {
        try {
            const config = await loadConfig();
            if (after.guild.id !== config.publicGuildId) return;
            const staff = await findStaffByDiscordId(after.id);
            if (!staff) return;
            if ((tierOf(after, config) !== "none") === staff.active) return;
            await applyLiveReading(client, config, after.guild, staff, after);
        } catch (error) {
            log.error(`Handling a role change for ${after.id} failed`, error);
        }
    });
}
