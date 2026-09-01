import {
    ApplicationIntegrationType,
    InteractionContextType,
    PermissionFlagsBits,
    REST,
    Routes
} from "discord.js";
import type { Command } from "./types.js";
import { timezoneCommand } from "./timezone.js";
import { shiftCommand } from "./shift.js";
import { ringsCommand } from "./rings.js";
import { leaderboardCommand } from "./leaderboard.js";
import { leaveCommand } from "./leave.js";
import { configCommand } from "./config.js";
import { coverageCommand } from "./coverage.js";
import { staffCommand } from "./staff.js";
import { mydataCommand } from "./mydata.js";
import { adminCommand } from "./admin.js";
import { env } from "../config/env.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    GLOBAL_SCOPE,
    recordCommandIds,
    setDefaultMentionGuild
} from "../discord/commandMentions.js";
import { log } from "../log.js";

export const commands: Command[] = [
    timezoneCommand,
    shiftCommand,
    ringsCommand,
    leaderboardCommand,
    leaveCommand,
    staffCommand,
    mydataCommand,
    configCommand,
    coverageCommand,
    adminCommand
];

export const commandsByName = new Map(
    commands.map((command) => [command.data.name, command])
);

/**
 * Where commands are registered, and why, and who can see each one.
 *
 * Three surfaces, and none of them is a free-for-all:
 *
 * - The staff server gets every command, guild scoped, each carrying the
 *   permission gate its tier deserves. Discord hides a command from anyone who
 *   does not hold that permission, so a Moderator's picker no longer lists
 *   /config or /admin at all.
 * - The direct message registration is global, and Discord offers a global
 *   command to everyone who can DM the bot. There is no per-user filter and no
 *   per-role filter: `default_member_permissions` is meaningless outside a
 *   guild, and Discord cannot gate on a role held in a DIFFERENT guild anyway.
 *   So the DM surface carries the baseline (Staff tier) commands only. Lead and
 *   Executive work happens in the staff server, where the gate is real.
 * - The community server gets configuration alone, behind a permission gate of
 *   zero, runnable only by an ID in BOOTSTRAP_ADMIN_IDS. That is the recovery
 *   hatch, and it is also where a seeded admin still reaches /config when the
 *   staff server is misconfigured.
 *
 * Visibility remains a filter, never the check. `interactionCreate` resolves
 * the caller's tier against community server roles and refuses anyone who does
 * not hold them, whichever surface the command was typed on.
 */

/**
 * The permission a tier maps to in the staff server.
 *
 * These are gates, not grants: they decide whose picker lists the command, and
 * nothing more. Staff tier carries none, because every department member is
 * meant to see /shift and /rings.
 */
export function permissionGateFor(command: Command): string | null {
    if (command.tier === "executive") return String(PermissionFlagsBits.ManageGuild);
    if (command.tier === "lead") return String(PermissionFlagsBits.ModerateMembers);
    return null;
}

/** Commands offered in a direct message: the baseline tier, and nothing above it. */
export function visibleInDirectMessages(command: Command): boolean {
    return command.tier === "staff";
}

export async function registerCommands(config: StaffBotConfig): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(env.discordToken);

    const forStaffGuild = commands.map((command) => {
        const json = command.data.toJSON() as Record<string, unknown>;
        const gate = permissionGateFor(command);
        if (gate) json.default_member_permissions = gate;
        return json;
    });

    const forDirectMessages = commands.filter(visibleInDirectMessages).map((command) => {
        const json = command.data.toJSON() as Record<string, unknown>;
        // BotDM only. Omitting Guild here is what keeps these out of every
        // guild picker while still making them typeable in a DM.
        json.contexts = [InteractionContextType.BotDM];
        json.integration_types = [ApplicationIntegrationType.GuildInstall];
        // A permission gate is meaningless in a DM and would only confuse.
        delete json.default_member_permissions;
        return json;
    });

    await putGuildCommands(rest, config.staffGuildId, forStaffGuild, "staff");

    // The community server gets configuration alone, and only as a recovery
    // hatch. A permission gate of zero hides a command from everyone without
    // Administrator, and the handler then admits only a seeded admin. Anything
    // else that a previous version registered there is removed by this write.
    const forCommunityGuild = commands
        .filter((command) => command.communityFallback)
        .map((command) => {
            const json = command.data.toJSON() as Record<string, unknown>;
            json.default_member_permissions = "0";
            return json;
        });
    await putGuildCommands(rest, config.publicGuildId, forCommunityGuild, "community");

    setDefaultMentionGuild(config.staffGuildId);

    try {
        const registered = (await rest.put(Routes.applicationCommands(env.applicationId), {
            body: forDirectMessages
        })) as { id: string; name: string }[];
        recordCommandIds(GLOBAL_SCOPE, registered);
        log.info(
            `Registered ${registered.length} commands for direct messages: ` +
                forDirectMessages.map((json) => json.name).join(", ")
        );
    } catch (error) {
        log.error(
            "FAILED to register direct message commands. Slash commands will work in the " +
                "staff server but not in a DM with the bot.",
            error
        );
    }
}

async function putGuildCommands(
    rest: REST,
    guildId: string,
    body: unknown[],
    label: string
): Promise<void> {
    if (!guildId) {
        log.error(
            `No ${label} guild ID configured, so no commands were registered there. ` +
                `Set ${label === "community" ? "PUBLIC_GUILD_ID" : "STAFF_GUILD_ID"} in .env.`
        );
        return;
    }

    try {
        const registered = (await rest.put(
            Routes.applicationGuildCommands(env.applicationId, guildId),
            { body }
        )) as { id: string; name: string }[];

        recordCommandIds(guildId, registered);

        if (body.length === 0) {
            log.info(`Cleared commands from the ${label} guild (${guildId})`);
            return;
        }
        const names = (body as { name: string }[]).map((command) => command.name).join(", ");
        log.info(`Registered ${body.length} commands in the ${label} guild (${guildId}): ${names}`);
    } catch (error) {
        const status = (error as { status?: number }).status;
        const hint =
            status === 403
                ? "The bot is missing the applications.commands scope in this guild. Re-invite " +
                  "it with both the bot and applications.commands scopes; adding the bot with " +
                  "the bot scope alone lets it log in but never register commands."
                : status === 401
                  ? "DISCORD_TOKEN is wrong or revoked."
                  : status === 404
                    ? "DISCORD_APPLICATION_ID does not match this token's application, or the " +
                      "bot is not in this guild. The application ID is on the General " +
                      "Information page, and is not always the same as the bot user ID."
                    : "Check the guild ID is correct and the bot is a member of that guild.";

        log.error(
            `FAILED to register commands in the ${label} guild (${guildId}). ${hint} ` +
                "Underlying error:",
            error
        );
    }
}
