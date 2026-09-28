import { GuildFeature, type Client, type Guild, type Role } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour, StaffDoc } from "../db/types.js";
import { roleColoursFor } from "../domain/sotwColour.js";
import { addRole, fetchMember, membersWithRole, removeRole } from "../discord/roles.js";
import { audit } from "../domain/audit.js";
import { colouredRoleAbove, type RoleOrderFacts } from "../config/configGuards.js";
import { log } from "../log.js";

/**
 * The bot owns the Staff of the Week role: who wears it and what colour it is.
 * Anyone given it by hand loses it at the next handoff or boot, and a colour
 * edited in Discord's settings is put back, because the holder's saved
 * preference is the source of truth.
 */

export async function sotwRole(
    client: Client,
    config: StaffBotConfig
): Promise<{ guild: Guild; role: Role } | null> {
    if (!config.staffOfWeekRole) return null;
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        const role = await guild.roles.fetch(config.staffOfWeekRole);
        return role ? { guild, role } : null;
    } catch (error) {
        log.warn("Could not fetch the Staff of the Week role", error);
        return null;
    }
}

export function guildHasEnhanced(guild: Guild): boolean {
    return guild.features.includes(GuildFeature.EnhancedRoleColors);
}

export interface ColourWrite {
    ok: boolean;
    downgraded: boolean;
}

export async function applyRoleColour(
    client: Client,
    config: StaffBotConfig,
    colour: SotwColour | null,
    reason: string,
    actorId: string | null = null
): Promise<ColourWrite> {
    const found = await sotwRole(client, config);
    if (!found) return { ok: false, downgraded: false };
    const { colours, downgraded } = roleColoursFor(colour, guildHasEnhanced(found.guild));
    const current = found.role.colors;
    if (
        current.primaryColor === colours.primaryColor &&
        (current.secondaryColor ?? null) === colours.secondaryColor &&
        (current.tertiaryColor ?? null) === colours.tertiaryColor
    ) {
        return { ok: true, downgraded };
    }
    try {
        // `edit` rather than `setColors`: only the edit form accepts null to
        // clear a gradient's second and third stops.
        await found.role.edit({ colors: colours, reason });
        await audit("sotw.roleColour", { actorId, detail: { roleId: found.role.id, ...colours } });
        return { ok: true, downgraded };
    } catch (error) {
        log.warn("Could not set the Staff of the Week role's colour", error);
        return { ok: false, downgraded };
    }
}

/**
 * Give the role to `holder` alone, in their colour, or to nobody. Every member
 * wearing it who is not the holder loses it, however they came by it.
 *
 * `membersWithRole` fetches the guild's members before filtering, rather than
 * reading `role.members` off discord.js's own cache: the public guild holds
 * around 110,000 members and is never fully cached, so after a restart the
 * previous holder was often missing from the cache and kept the role while
 * the new one was also given it.
 */
export async function handRoleTo(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc | null,
    reason: string
): Promise<{ granted: boolean; colour: ColourWrite }> {
    const found = await sotwRole(client, config);
    if (!found) return { granted: false, colour: { ok: false, downgraded: false } };

    const wearers = await membersWithRole(client, config, found.role.id);
    for (const member of wearers) {
        if (holder && member.id === holder.discordId) continue;
        await removeRole(member, found.role.id, reason);
    }

    const colour = await applyRoleColour(client, config, holder?.sotwColour ?? null, reason);
    if (!holder) return { granted: false, colour };

    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    const granted = member ? await addRole(member, found.role.id, reason, holder._id) : false;
    if (!granted) log.warn(`Could not give Staff of the Week to ${holder.discordId}`);
    return { granted, colour };
}

export async function takeRoleFrom(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc,
    reason: string
): Promise<void> {
    const found = await sotwRole(client, config);
    if (!found) return;
    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    if (member) await removeRole(member, found.role.id, reason, holder._id);
    await applyRoleColour(client, config, null, reason);
}

export async function staffOfWeekRoleFacts(
    client: Client,
    config: StaffBotConfig
): Promise<RoleOrderFacts | null> {
    if (!config.staffOfWeekRole) return null;
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        const role = await guild.roles.fetch(config.staffOfWeekRole);
        if (!role) {
            return { missing: true, roleName: config.staffOfWeekRole, aboveBot: false, colouredRoleAbove: null };
        }
        const me = await guild.members.fetchMe();
        const staffRoles = [
            config.moderationDepartmentRole,
            config.availabilityRole,
            config.onLeaveRole,
            ...config.staffRankRoles,
            ...config.leadRoles,
            ...config.executiveRoles
        ]
            .filter(Boolean)
            .map((id) => guild.roles.cache.get(id))
            .filter((found): found is Role => Boolean(found));
        return {
            missing: false,
            roleName: role.name,
            aboveBot: role.comparePositionTo(me.roles.highest) >= 0,
            colouredRoleAbove: colouredRoleAbove(
                role.position,
                staffRoles.map((staffRole) => ({
                    name: staffRole.name,
                    position: staffRole.position,
                    colour: staffRole.colors.primaryColor
                }))
            )
        };
    } catch (error) {
        log.debug("Could not read where the Staff of the Week role sits", error);
        return null;
    }
}
