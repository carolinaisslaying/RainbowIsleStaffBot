import { Events, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { tierOf, wearsOnLeaveRole } from "../domain/permissions.js";
import { lateCauseFor } from "../domain/staffOfWeek.js";
import { checkHolderStanding } from "../services/sotwWatch.js";

/**
 * The holder leaving the community server, or their roles changing so they can
 * no longer hold it. Scoped to the holder alone: every other member change in
 * a server of 110,000 is none of this feature's business.
 */
export function registerSotwMemberHandler(client: Client): void {
    client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
        const config = await loadConfig();
        if (member.guild.id !== config.publicGuildId) return;
        await checkHolderStanding(client, config, member.id, "left");
    });

    client.on(Events.GuildMemberUpdate, async (before, after) => {
        const config = await loadConfig();
        if (after.guild.id !== config.publicGuildId) return;
        // Leave takes the department role, which reads here as losing Staff
        // tier. That is leave's to report, through the leave path, not this one.
        if (wearsOnLeaveRole(after, config)) return;
        const was = before.partial ? null : tierOf(before as GuildMember, config);
        const now = tierOf(after, config);
        if (was === now) return;
        const cause = lateCauseFor({ present: true, tier: now });
        if (cause) await checkHolderStanding(client, config, after.id, cause);
    });
}
