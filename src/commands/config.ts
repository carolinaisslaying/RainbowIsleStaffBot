import { SlashCommandBuilder, type AutocompleteInteraction, type Client } from "discord.js";
import type { Command } from "./types.js";
import {
    CONFIG_KEYS,
    DEFAULT_CONFIG,
    cachedConfig,
    isArrayKey,
    loadConfig,
    parseConfigValue,
    setConfigValue,
    type StaffBotConfig
} from "../config/guildConfig.js";
import { isExecutive } from "../domain/permissions.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { configViewCard, renderValue, resolveGuildNames, setupStatus } from "../render/configCards.js";
import { defer, respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { audit } from "../domain/audit.js";
import { searchTimezones, describeZone } from "../time/timezones.js";
import { log } from "../log.js";

const KEY_NAMES = Object.keys(CONFIG_KEYS) as (keyof StaffBotConfig)[];

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
];

function isKey(value: string): value is keyof StaffBotConfig {
    return (KEY_NAMES as string[]).includes(value);
}

/**
 * Roles and channels live in the community server, while /config runs in the
 * staff server. Discord's role and channel pickers only ever list the guild the
 * interaction happened in, so they cannot reach across. Autocomplete can: it
 * fetches from whichever guild the key refers to and offers names, so nobody
 * has to turn on Developer Mode and copy snowflakes by hand.
 */
async function suggestRoles(
    client: Client,
    guildId: string,
    query: string
): Promise<{ name: string; value: string }[]> {
    try {
        const guild = await client.guilds.fetch(guildId);
        const roles = await guild.roles.fetch();
        const needle = query.toLowerCase().replace(/[<@&>]/g, "");
        return [...roles.values()]
            .filter((role) => role.id !== guild.id) // @everyone is never a staff role
            .filter((role) => !needle || role.name.toLowerCase().includes(needle) || role.id.includes(needle))
            .sort((left, right) => right.position - left.position)
            .slice(0, 25)
            .map((role) => ({
                name: `@${role.name}`.slice(0, 100),
                value: role.id
            }));
    } catch (error) {
        log.debug("Role autocomplete failed", error);
        return [];
    }
}

async function suggestChannels(
    client: Client,
    guildId: string,
    query: string
): Promise<{ name: string; value: string }[]> {
    try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const needle = query.toLowerCase().replace(/[<#>]/g, "");
        return [...channels.values()]
            .filter((channel) => channel?.isTextBased())
            .filter(
                (channel) =>
                    !needle ||
                    channel!.name.toLowerCase().includes(needle) ||
                    channel!.id.includes(needle)
            )
            .slice(0, 25)
            .map((channel) => ({
                name: `#${channel!.name}`.slice(0, 100),
                value: channel!.id
            }));
    } catch (error) {
        log.debug("Channel autocomplete failed", error);
        return [];
    }
}

/** Which guild a key's roles or channels belong to. */
function guildForKey(key: keyof StaffBotConfig, config: StaffBotConfig): string {
    // Review and recap channels are in the staff server; everything else,
    // including every role, is in the community server.
    if (key === "leaveChannelId" || key === "reportChannelId" || key === "recapChannelId") {
        return config.staffGuildId;
    }
    return config.publicGuildId;
}

async function suggestValues(
    interaction: AutocompleteInteraction,
    config: StaffBotConfig
): Promise<void> {
    const rawKey = interaction.options.getString("key");
    const query = interaction.options.getFocused();

    if (!rawKey || !isKey(rawKey)) {
        await interaction.respond([
            { name: "Choose a key first, then this list fills in", value: "" }
        ]);
        return;
    }

    const spec = CONFIG_KEYS[rawKey];
    const guildId = guildForKey(rawKey, config);

    if (spec.target === "role") {
        await interaction.respond(await suggestRoles(interaction.client, guildId, query));
        return;
    }
    if (spec.target === "channel") {
        await interaction.respond(await suggestChannels(interaction.client, guildId, query));
        return;
    }
    if (spec.kind === "boolean") {
        await interaction.respond([
            { name: "on", value: "true" },
            { name: "off", value: "false" }
        ]);
        return;
    }
    if (spec.kind === "weekday") {
        await interaction.respond(
            WEEKDAYS.map((day, index) => ({ name: day, value: String(index) })).filter((choice) =>
                choice.name.toLowerCase().startsWith(query.toLowerCase())
            )
        );
        return;
    }
    if (spec.kind === "timezone") {
        const now = new Date();
        await interaction.respond(
            searchTimezones(query, 25, now).map((zone) => ({
                name: describeZone(zone, now),
                value: zone
            }))
        );
        return;
    }
    if (spec.kind === "number") {
        // Offer the current value and the shipped default, so an Executive can
        // see what they are changing from and revert without looking it up.
        const current = String(config[rawKey]);
        const fallback = String(DEFAULT_CONFIG[rawKey]);
        const choices = [{ name: `${current} (current)`, value: current }];
        if (fallback !== current) choices.push({ name: `${fallback} (default)`, value: fallback });
        if (query && !Number.isNaN(Number(query))) {
            choices.unshift({ name: `${query}`, value: query });
        }
        const range =
            spec.min !== undefined && spec.max !== undefined
                ? `Allowed ${spec.min} to ${spec.max}`
                : "";
        if (range) choices.push({ name: range, value: current });
        await interaction.respond(choices.slice(0, 25));
        return;
    }
    await interaction.respond([]);
}

function keyChoices(config: StaffBotConfig, query: string) {
    const needle = query.toLowerCase();
    return KEY_NAMES.filter((key) => key.toLowerCase().includes(needle))
        .sort((left, right) => {
            // Unset essentials first: that is what an operator is looking for.
            const rank = (key: keyof StaffBotConfig) => {
                const spec = CONFIG_KEYS[key];
                const unset = Array.isArray(config[key])
                    ? (config[key] as unknown[]).length === 0
                    : !config[key];
                if (unset && spec.importance === "required") return 0;
                if (unset && spec.importance === "recommended") return 1;
                return 2;
            };
            return rank(left) - rank(right) || left.localeCompare(right);
        })
        .slice(0, 25)
        .map((key) => {
            const spec = CONFIG_KEYS[key];
            const unset = Array.isArray(config[key])
                ? (config[key] as unknown[]).length === 0
                : !config[key];
            // Plain text marker: the picker is a list, not a dashboard.
            const badge = unset
                ? spec.importance === "required"
                    ? "[needed] "
                    : "[unset] "
                : "";
            return {
                name: `${badge}${key} - ${spec.description}`.slice(0, 100),
                value: key
            };
        });
}

export const configCommand: Command = {
    tier: "executive",
    // Configuration changes how the bot behaves everywhere, including who
    // counts as an Executive, so an Executive changing it could promote
    // themselves. Limited to the deployment's own administrators, and falling
    // back to Executive only when none are named, or a fresh deployment could
    // never be configured at all.
    seededOnly: true,
    communityFallback: true,
    data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("View or change bot configuration (Executive)")
        .addSubcommand((sub) =>
            sub.setName("view").setDescription("Show the current configuration and setup progress")
        )
        .addSubcommand((sub) =>
            sub
                .setName("set")
                .setDescription("Set a key. Roles and channels autocomplete by name.")
                .addStringOption((option) =>
                    option
                        .setName("key")
                        .setDescription("Which setting")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName("value")
                        .setDescription("Pick from the list, or type a value")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("add")
                .setDescription("Add one role or channel to a list setting")
                .addStringOption((option) =>
                    option
                        .setName("key")
                        .setDescription("Which list")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName("value")
                        .setDescription("Which role or channel to add")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("remove")
                .setDescription("Remove one role or channel from a list setting")
                .addStringOption((option) =>
                    option
                        .setName("key")
                        .setDescription("Which list")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addStringOption((option) =>
                    option
                        .setName("value")
                        .setDescription("Which entry to remove")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("reset")
                .setDescription("Return a key to its shipped default")
                .addStringOption((option) =>
                    option
                        .setName("key")
                        .setDescription("Which setting")
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        ),

    async autocomplete(interaction, config) {
        const focused = interaction.options.getFocused(true);
        const sub = interaction.options.getSubcommand();

        if (focused.name === "key") {
            const listOnly = sub === "add" || sub === "remove";
            const choices = keyChoices(config, focused.value).filter((choice) =>
                listOnly ? isArrayKey(choice.value as keyof StaffBotConfig) : true
            );
            await interaction.respond(choices);
            return;
        }

        // Removing offers only what is actually in the list.
        if (focused.name === "value" && sub === "remove") {
            const rawKey = interaction.options.getString("key");
            if (!rawKey || !isKey(rawKey) || !isArrayKey(rawKey)) {
                await interaction.respond([]);
                return;
            }
            const current = (config[rawKey] as string[]) ?? [];
            const spec = CONFIG_KEYS[rawKey];
            await interaction.respond(
                current.slice(0, 25).map((id) => ({
                    name: `${spec.target === "role" ? "@" : "#"}${id}`.slice(0, 100),
                    value: id
                }))
            );
            return;
        }

        await suggestValues(interaction, config);
    },

    async execute({ client, config, interaction, staff, tier }) {
        if (!isExecutive(tier)) {
            await respond(interaction, errorCard("Configuration is Executive only."));
            return;
        }

        const sub = interaction.options.getSubcommand();
        const setCommand = cmd("config set", interaction.guildId);

        if (sub === "view") {
            await defer(interaction, true);
            const fresh = await loadConfig();
            const guildNames = await resolveGuildNames(client, fresh);
            await respond(interaction, configViewCard(fresh, guildNames, setCommand));
            return;
        }

        const rawKey = interaction.options.getString("key", true);
        if (!isKey(rawKey)) {
            await respond(interaction, errorCard(`**${rawKey}** is not a configuration key.`));
            return;
        }
        const spec = CONFIG_KEYS[rawKey];
        const previous = cachedConfig()[rawKey];

        if (sub === "reset") {
            await applyChange(rawKey, DEFAULT_CONFIG[rawKey], previous, interaction, staff, client);
            return;
        }

        const raw = interaction.options.getString("value", true);

        if (sub === "add" || sub === "remove") {
            if (!isArrayKey(rawKey)) {
                await respond(
                    interaction,
                    errorCard(
                        `**${rawKey}** holds a single value, so use ${setCommand} instead of ` +
                            `${cmd(`config ${sub}`, interaction.guildId)}.`
                    )
                );
                return;
            }
            const parsed = parseConfigValue(rawKey, raw);
            if (!parsed.ok) {
                await respond(interaction, errorCard(`**${rawKey}**: ${parsed.error}`));
                return;
            }
            const incoming = parsed.value as string[];
            const current = new Set((previous as string[]) ?? []);

            if (sub === "add") {
                for (const id of incoming) current.add(id);
            } else {
                for (const id of incoming) current.delete(id);
            }
            await applyChange(rawKey, [...current], previous, interaction, staff, client);
            return;
        }

        const parsed = parseConfigValue(rawKey, raw);
        if (!parsed.ok) {
            await respond(interaction, errorCard(`**${rawKey}**: ${parsed.error}`));
            return;
        }
        await applyChange(rawKey, parsed.value, previous, interaction, staff, client);

        if (spec.kind === "timezone" || spec.kind === "weekday" || spec.kind === "isoDate") {
            log.warn(
                `Calendar key ${rawKey} changed. Past assessments keep their snapshotted target.`
            );
        }
    }
};

async function applyChange(
    key: keyof StaffBotConfig,
    value: unknown,
    previous: unknown,
    interaction: import("discord.js").ChatInputCommandInteraction,
    staff: { _id: import("mongodb").ObjectId },
    client: Client
): Promise<void> {
    await defer(interaction, true);
    await setConfigValue(key, value);
    const fresh = await loadConfig();
    const guildNames = await resolveGuildNames(client, fresh);

    await audit("config.set", {
        actorId: interaction.user.id,
        targetStaffId: staff._id,
        detail: { key, previous, value }
    });

    const status = setupStatus(fresh);
    const before = { ...fresh, [key]: previous } as StaffBotConfig;

    const nextStep = status.ready
        ? "Every required setting now has a value."
        : `Still needed: ${status.missingRequired.map((item) => `**${item}**`).join(", ")}.`;

    await respond(
        interaction,
        noticeCard(
            "Configuration updated",
            `**${key}**\n` +
                `Was ${renderValue(key, before, guildNames)}\n` +
                `Now ${renderValue(key, fresh, guildNames)}\n\n` +
                `${nextStep}\n\n` +
                "-# Past assessments keep the target in force when an Executive made them. " +
                "Changing a threshold here leaves those outcomes alone.",
            { ephemeral: true }
        )
    );
}
