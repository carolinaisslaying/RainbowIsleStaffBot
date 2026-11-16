import { Client, GatewayIntentBits, Partials, type MessageMentionOptions } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { log } from "../log.js";

/**
 * The bot pings nobody unless a send says exactly who.
 *
 * This is the client default, so it covers every send, reply, follow-up, edit
 * and DM, including ones nobody has written yet. A send that passes its own
 * `allowedMentions` replaces this outright rather than merging with it, so the
 * only sends allowed to do that are the two that exist to ping, each naming one
 * role: Executive pings (`services/pings.ts`) and `/callmod`
 * (`commands/callmod.ts`). `test/allowedMentions.test.ts` fails if anything
 * else sets its own.
 */
export const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: false };

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
        partials: [Partials.GuildMember, Partials.User, Partials.Channel],
        allowedMentions: NO_MENTIONS
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
