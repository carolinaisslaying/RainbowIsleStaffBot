import { GuildFeature, type Client, type Guild, type Role } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour, StaffDoc } from "../db/types.js";
import { roleColoursFor, type RoleColourWrite } from "../domain/sotwColour.js";
import type { GuildMember } from "discord.js";
import { addRole, fetchMember, removeRole } from "../discord/roles.js";
import { findStaffById } from "../domain/staff.js";
import { recentRoleHolderIds } from "../domain/staffOfWeekStore.js";
import { audit } from "../domain/audit.js";
import { colouredRoleAbove, type RoleOrderFacts } from "../config/configGuards.js";
import { log } from "../log.js";

/**
 * The bot owns the Staff of the Week role: who wears it and what colour it is.
 * Anyone given it by hand loses it at the next handoff or boot once Discord
 * has shown them to the bot, and a colour
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
    /** What was actually applied (or would have been), for callers that log it. */
    colours: RoleColourWrite | null;
}

export async function applyRoleColour(
    client: Client,
    config: StaffBotConfig,
    colour: SotwColour | null,
    reason: string,
    actorId: string | null = null
): Promise<ColourWrite> {
    const found = await sotwRole(client, config);
    if (!found) return { ok: false, downgraded: false, colours: null };
    const { colours, downgraded } = roleColoursFor(colour, guildHasEnhanced(found.guild));
    const current = found.role.colors;
    if (
        current.primaryColor === colours.primaryColor &&
        (current.secondaryColor ?? null) === colours.secondaryColor &&
        (current.tertiaryColor ?? null) === colours.tertiaryColor
    ) {
        return { ok: true, downgraded, colours };
    }
    try {
        // `edit` rather than `setColors`: only the edit form accepts null to
        // clear a gradient's second and third stops.
        await found.role.edit({ colors: colours, reason });
        await audit("sotw.roleColour", { actorId, detail: { roleId: found.role.id, ...colours } });
        return { ok: true, downgraded, colours };
    } catch (error) {
        log.warn("Could not set the Staff of the Week role's colour", error);
        return { ok: false, downgraded, colours };
    }
}

/**
 * Who might be wearing the role: everybody the bot recorded on it in recent
 * weeks, fetched one by one, plus whoever discord.js already has cached with
 * it (somebody given it by hand, once they have been seen).
 *
 * Never a fetch of the whole community server. That is a gateway request
 * Discord rate-limits per guild, and boot's own reconciliation spends it
 * seconds earlier, so the handoff after a restart was refused and gave the
 * role to nobody. Reading `role.members` alone is not enough either: the
 * guild is never fully cached, so after a restart the previous holder was
 * often missing and kept the role. The bot's own record is what closes that.
 */
async function possibleWearers(client: Client, config: StaffBotConfig, role: Role): Promise<GuildMember[]> {
    const wearers = new Map<string, GuildMember>(role.members.map((member) => [member.id, member]));
    for (const staffId of await recentRoleHolderIds()) {
        const staff = await findStaffById(staffId);
        if (!staff || wearers.has(staff.discordId)) continue;
        const member = await fetchMember(client, config.publicGuildId, staff.discordId);
        if (member?.roles.cache.has(role.id)) wearers.set(member.id, member);
    }
    return [...wearers.values()];
}

/**
 * Give the role to `holder` alone, in their colour, or to nobody. Every member
 * the bot can find wearing it who is not the holder loses it. A failure taking
 * it off somebody else never stops the holder being given it.
 */
export async function handRoleTo(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc | null,
    reason: string
): Promise<{ granted: boolean; colour: ColourWrite }> {
    const found = await sotwRole(client, config);
    if (!found) return { granted: false, colour: { ok: false, downgraded: false, colours: null } };

    try {
        for (const member of await possibleWearers(client, config, found.role)) {
            if (holder && member.id === holder.discordId) continue;
            await removeRole(member, found.role.id, reason);
        }
    } catch (error) {
        log.warn("Could not check who else wears the Staff of the Week role", error);
    }

    const colour = await applyRoleColour(client, config, holder?.sotwColour ?? null, reason);
    if (!holder) return { granted: false, colour };

    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    const granted = member ? await addRole(member, found.role.id, reason, holder._id) : false;
    if (!granted) log.warn(`Could not give Staff of the Week to ${holder.discordId}`);
    return { granted, colour };
}

/**
 * True once the role is confirmed off: the member no longer holds it, or they
 * were never found to hold it in the first place. False only when the role
 * could not be fetched, or Discord refused the removal — the caller has
 * something to warn about either way.
 */
export async function takeRoleFrom(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc,
    reason: string
): Promise<boolean> {
    const found = await sotwRole(client, config);
    if (!found) return false;
    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    const removed = member ? await removeRole(member, found.role.id, reason, holder._id) : true;
    await applyRoleColour(client, config, null, reason);
    return removed;
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
