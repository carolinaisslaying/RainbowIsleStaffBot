import type { Client, GuildMember } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { env } from "../config/env.js";
import { log } from "../log.js";

/**
 * Three tiers, always resolved against roles in the PUBLIC guild, never the
 * staff guild. setDefaultMemberPermissions is a first filter only; every
 * handler checks here as well. Never rely on the Discord permission gate alone.
 */

export type Tier = "none" | "staff" | "lead" | "executive";

export const TIER_RANK: Record<Tier, number> = {
    none: 0,
    staff: 1,
    lead: 2,
    executive: 3
};

function hasAnyRole(member: GuildMember, roleIds: string[]): boolean {
    return roleIds.some((roleId) => roleId && member.roles.cache.has(roleId));
}

/** Fetch the member in the public guild, wherever the interaction came from. */
export async function fetchPublicMember(
    client: Client,
    config: StaffBotConfig,
    userId: string
): Promise<GuildMember | null> {
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        return await guild.members.fetch(userId);
    } catch (error) {
        log.debug(`Could not fetch public guild member ${userId}`, error);
        return null;
    }
}

/**
 * Deployment level escape hatch, from BOOTSTRAP_ADMIN_IDS. Independent of the
 * guildConfig document, so it still works when that document is empty or wrong.
 */
export function isBootstrapAdmin(userId: string): boolean {
    return env.bootstrapAdminIds.includes(userId);
}

/**
 * Whether a `seededOnly` command may run for this caller.
 *
 * Pure, and taking both facts as arguments, so the one case that matters can be
 * tested without an environment: a deployment that names **no** administrators
 * falls back to the command's tier rather than refusing everybody. Locking
 * configuration to a list nobody is on would leave the bot unconfigurable,
 * including by the person trying to name the first administrator, and the
 * config command is the only way to fix the setting that caused it.
 */
export function seededGatePermits(options: {
    seededOnly: boolean;
    anyAdminsConfigured: boolean;
    callerIsAdmin: boolean;
}): boolean {
    if (!options.seededOnly) return true;
    if (!options.anyAdminsConfigured) return true;
    return options.callerIsAdmin;
}

/**
 * Whether the deployment has any seeded admins at all.
 *
 * A permission refusal says the bot is not set up yet only when this is false.
 * The cards are read by Moderators, so they never name the environment variable
 * behind it: a configured deployment pointing a Moderator who simply lacks a
 * role at a deployment setting tells them nothing they can act on, and
 * advertises the escape hatch to everyone who mistypes a command.
 */
export function bootstrapAdminsConfigured(): boolean {
    return env.bootstrapAdminIds.length > 0;
}

/**
 * Someone whose department role is currently set aside by approved leave.
 *
 * Leave activation removes the Moderation Department role, which is exactly the
 * role `tierOf` reads. Left alone, that locks a member out of the very commands
 * they need to come back: /leave end would refuse them for not being staff.
 * Holding the on-leave role is proof enough that they were staff, and it is a
 * role only this bot grants.
 */
export function wearsOnLeaveRole(
    member: GuildMember | null,
    config: StaffBotConfig
): boolean {
    if (!member || !config.onLeaveRole) return false;
    return member.roles.cache.has(config.onLeaveRole);
}

export function tierOf(member: GuildMember | null, config: StaffBotConfig): Tier {
    if (!member) return "none";
    if (hasAnyRole(member, config.executiveRoles)) return "executive";
    if (hasAnyRole(member, config.leadRoles)) return "lead";
    if (config.moderationDepartmentRole && member.roles.cache.has(config.moderationDepartmentRole)) {
        return "staff";
    }
    return "none";
}

/**
 * Said once per admin per process, not once per interaction.
 *
 * The escape hatch is meant to be visible, and it was: a warning on every
 * command a seeded admin ran. On a deployment where the admin is also the
 * working Executive that is a warning per click, which buries every warning
 * that means something. Once is loud enough to notice and quiet enough to
 * leave the rest of the log readable.
 */
const announcedBootstrapUse = new Set<string>();

/** Test seam. The set is process-lifetime state, and a test is a process. */
export function forgetBootstrapAnnouncements(): void {
    announcedBootstrapUse.clear();
}

/**
 * The tier check every handler should use.
 *
 * Resolves roles in the public guild, then falls back to the bootstrap list.
 * A bootstrap admin is granted Executive even when they are not a member of the
 * public guild at all, because otherwise a fresh install with nobody yet in the
 * Rainbow Isle server could not be configured.
 */
export function resolveTier(
    userId: string,
    member: GuildMember | null,
    config: StaffBotConfig
): Tier {
    const fromRoles = tierOf(member, config);
    if (fromRoles === "executive") return fromRoles;
    if (isBootstrapAdmin(userId)) {
        if (!announcedBootstrapUse.has(userId)) {
            announcedBootstrapUse.add(userId);
            log.warn(
                `Granting Executive to ${userId} via BOOTSTRAP_ADMIN_IDS. Set executiveRoles ` +
                    "with /config set so this is no longer needed. Said once per restart."
            );
        }
        return "executive";
    }
    return fromRoles;
}

export async function tierOfUser(
    client: Client,
    config: StaffBotConfig,
    userId: string
): Promise<Tier> {
    return tierOf(await fetchPublicMember(client, config, userId), config);
}

export function atLeast(tier: Tier, required: Tier): boolean {
    return TIER_RANK[tier] >= TIER_RANK[required];
}

export function isExecutive(tier: Tier): boolean {
    return tier === "executive";
}

export function isLeadOrAbove(tier: Tier): boolean {
    return atLeast(tier, "lead");
}

export const TIER_LABEL: Record<Tier, string> = {
    none: "not Moderation staff",
    staff: "Moderation staff",
    lead: "Lead Moderator",
    executive: "Executive"
};
