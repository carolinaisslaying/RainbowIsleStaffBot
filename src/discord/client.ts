import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { log } from "../log.js";

/**
 * Intents: Guilds, GuildMembers, GuildMessages, GuildPresences.
 *
 * MessageContent is deliberately absent. The bot never reads message text.
 * messageCreate still fires with author, channel and timestamp without it,
 * which is all the minute accounting needs. This is a privacy decision, not an
 * oversight: do not add the intent to "improve" anything.
 */
export function createClient(): Client {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildPresences
        ],
        partials: [Partials.GuildMember, Partials.User, Partials.Channel]
    });
}

/**
 * The bot's highest role must sit above every role it manages in the public
 * guild hierarchy, or role changes will fail silently at exactly the wrong
 * moment. Fatal at startup rather than at 3am during a leave activation.
 */
export async function assertRoleHierarchy(
    client: Client,
    config: StaffBotConfig
): Promise<boolean> {
    const guild = await client.guilds.fetch(config.publicGuildId);
    const me = await guild.members.fetchMe();
    const highest = me.roles.highest;

    const managed = [
        config.availabilityRole,
        config.moderationDepartmentRole,
        config.onLeaveRole,
        ...config.staffRankRoles
    ].filter(Boolean);

    const blocked: string[] = [];
    for (const roleId of managed) {
        const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
        if (!role) {
            log.error(`Managed role ${roleId} does not exist in the public guild.`);
            blocked.push(roleId);
            continue;
        }
        if (role.comparePositionTo(highest) >= 0) {
            log.error(
                `FATAL: managed role ${role.name} (${role.id}) sits at or above the bot's ` +
                    `highest role ${highest.name}. Role changes will fail.`
            );
            blocked.push(roleId);
        }
    }

    if (!me.permissions.has("ManageRoles")) {
        log.error("FATAL: the bot lacks Manage Roles in the public guild.");
        return false;
    }

    return blocked.length === 0;
}
