import type { Client, GuildMember } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { audit } from "../domain/audit.js";
import { log } from "../log.js";

/** Every role change goes through here, so every role change is audited. */

export async function fetchMember(
    client: Client,
    guildId: string,
    userId: string
): Promise<GuildMember | null> {
    try {
        const guild = await client.guilds.fetch(guildId);
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

export async function addRole(
    member: GuildMember,
    roleId: string,
    reason: string,
    staffId?: ObjectId
): Promise<boolean> {
    if (!roleId) return false;
    if (member.roles.cache.has(roleId)) return true;
    try {
        await member.roles.add(roleId, reason);
        await audit("role.add", {
            actorId: member.client.user?.id ?? null,
            targetStaffId: staffId ?? null,
            detail: { roleId, discordId: member.id, reason }
        });
        return true;
    } catch (error) {
        log.warn(`Failed to add role ${roleId} to ${member.id}`, error);
        return false;
    }
}

export async function removeRole(
    member: GuildMember,
    roleId: string,
    reason: string,
    staffId?: ObjectId
): Promise<boolean> {
    if (!roleId) return false;
    if (!member.roles.cache.has(roleId)) return true;
    try {
        await member.roles.remove(roleId, reason);
        await audit("role.remove", {
            actorId: member.client.user?.id ?? null,
            targetStaffId: staffId ?? null,
            detail: { roleId, discordId: member.id, reason }
        });
        return true;
    } catch (error) {
        log.warn(`Failed to remove role ${roleId} from ${member.id}`, error);
        return false;
    }
}

/** Members currently holding a role in the public guild. */
export async function membersWithRole(
    client: Client,
    config: StaffBotConfig,
    roleId: string
): Promise<GuildMember[]> {
    if (!roleId) return [];
    const guild = await client.guilds.fetch(config.publicGuildId);
    const members = await guild.members.fetch();
    return [...members.filter((member) => member.roles.cache.has(roleId)).values()];
}

export async function existingRoleIds(
    client: Client,
    guildId: string
): Promise<Set<string>> {
    const guild = await client.guilds.fetch(guildId);
    const roles = await guild.roles.fetch();
    return new Set(roles.map((role) => role.id));
}

/** Best effort DM. A member with DMs closed must never break an action. */
export async function tryDm(
    client: Client,
    userId: string,
    payload: Record<string, unknown>
): Promise<boolean> {
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload as never);
        return true;
    } catch (error) {
        log.debug(`Could not DM ${userId}`, error);
        return false;
    }
}
