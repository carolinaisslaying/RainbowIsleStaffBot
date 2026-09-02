import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    FileBuilder,
    MessageFlags,
    type Client
} from "discord.js";
import {
    CONFIG_KEYS,
    DEFAULT_CONFIG,
    GROUP_LABELS,
    isUnset,
    keysInGroup,
    type KeyGroup,
    type StaffBotConfig
} from "../config/guildConfig.js";
import { exportConfig, type ConfigChange, type ImportReport } from "../config/configTransfer.js";
import { configWarnings } from "../config/configGuards.js";
import {
    V2_FLAGS,
    containersMessage,
    noticeCard,
    separator,
    text,
    type RenderedMessage
} from "./cards.js";
import { COLOUR } from "./theme.js";
import { formatDuration, ts } from "../time/format.js";
import { emojiForColour } from "./emoji.js";

/**
 * The configuration viewer.
 *
 * Two rules drive the layout. Discord's subtext markup (`-#`) only applies to a
 * line it starts, so a description appended after a value renders as literal
 * "-#" characters; every description therefore gets its own line. And a raw
 * snowflake tells the reader nothing, so roles and channels render as mentions,
 * which Discord resolves to names.
 */

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
];

function mentionFor(key: keyof StaffBotConfig, id: string, guildNames: Map<string, string>): string {
    const target = CONFIG_KEYS[key].target;
    if (target === "role") return `<@&${id}>`;
    if (target === "channel") return `<#${id}>`;
    if (target === "guild") {
        const name = guildNames.get(id);
        return name ? name : id;
    }
    return `**${id}**`;
}

/** Rendered value, or an explicit marker when nothing is set. */
export function renderValue(
    key: keyof StaffBotConfig,
    config: StaffBotConfig,
    guildNames: Map<string, string>
): string {
    const spec = CONFIG_KEYS[key];
    const value = config[key];

    if (isUnset(config, key)) {
        return spec.importance === "required" ? "**not set**" : "*not set*";
    }

    if (Array.isArray(value)) {
        return value.map((id) => mentionFor(key, String(id), guildNames)).join(" ");
    }
    if (spec.kind === "boolean") return value ? "**on**" : "**off**";
    if (spec.kind === "weekday") return `**${WEEKDAYS[Number(value)]}**`;
    if (spec.kind === "isoDate") {
        const parsed = new Date(String(value));
        return Number.isNaN(parsed.getTime())
            ? `**${String(value)}**`
            : `<t:${Math.floor(parsed.getTime() / 1000)}:D>`;
    }
    if (spec.target === "plain") return `**${String(value)}**`;
    return mentionFor(key, String(value), guildNames);
}

function isDefault(config: StaffBotConfig, key: keyof StaffBotConfig): boolean {
    const current = config[key];
    const fallback = DEFAULT_CONFIG[key];
    if (Array.isArray(current) && Array.isArray(fallback)) {
        return current.length === fallback.length;
    }
    return current === fallback;
}

function groupBlock(
    group: KeyGroup,
    config: StaffBotConfig,
    guildNames: Map<string, string>
): string {
    const lines: string[] = [];
    for (const key of keysInGroup(group)) {
        const spec = CONFIG_KEYS[key];
        const changed =
            spec.importance === "optional" && !isUnset(config, key) && isDefault(config, key)
                ? " *(default)*"
                : "";

        lines.push(`**${key}** ${renderValue(key, config, guildNames)}${changed}`);
        // Own line: `-#` styles the line it begins, never a fragment after a value.
        lines.push(`-# ${spec.description}`);
    }
    return lines.join("\n");
}

export interface SetupStatus {
    requiredTotal: number;
    requiredSet: number;
    missingRequired: (keyof StaffBotConfig)[];
    missingRecommended: (keyof StaffBotConfig)[];
    ready: boolean;
}

export function setupStatus(config: StaffBotConfig): SetupStatus {
    const keys = Object.keys(CONFIG_KEYS) as (keyof StaffBotConfig)[];
    const required = keys.filter((key) => CONFIG_KEYS[key].importance === "required");
    const recommended = keys.filter((key) => CONFIG_KEYS[key].importance === "recommended");
    const missingRequired = required.filter((key) => isUnset(config, key));
    const missingRecommended = recommended.filter((key) => isUnset(config, key));

    return {
        requiredTotal: required.length,
        requiredSet: required.length - missingRequired.length,
        missingRequired,
        missingRecommended,
        ready: missingRequired.length === 0
    };
}

function statusContainer(config: StaffBotConfig, setCommand: string): ContainerBuilder {
    const status = setupStatus(config);

    const container = new ContainerBuilder().setAccentColor(
        status.ready
            ? COLOUR.approved
            : status.requiredSet === 0
              ? COLOUR.adverse
              : COLOUR.pending
    );

    if (status.ready) {
        container.addTextDisplayComponents(
            text(
                `## Configuration\n**${status.requiredSet} of ${status.requiredTotal}** ` +
                    "essentials are set. The bot has what it needs."
            )
        );
    } else {
        const blockers = status.missingRequired
            .map((key) => `**${key}**\n-# ${CONFIG_KEYS[key].consequence ?? ""}`)
            .join("\n");
        container.addTextDisplayComponents(
            text(
                `## Configuration\n**${status.requiredSet} of ${status.requiredTotal}** ` +
                    `essentials are set.\n\n**Still needed**\n${blockers}`
            )
        );
    }

    if (status.missingRecommended.length > 0) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                "**Worth setting**\n" +
                    status.missingRecommended
                        .map((key) => `**${key}**\n-# ${CONFIG_KEYS[key].consequence ?? ""}`)
                        .join("\n")
            )
        );
    }

    container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(
        text(
            `-# Change one with ${setCommand}. Roles and channels autocomplete by name.`
        )
    );
    return container;
}

/** Resolve the two guild IDs to names, so the servers block reads as names. */
export async function resolveGuildNames(
    client: Client,
    config: StaffBotConfig
): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of [config.publicGuildId, config.staffGuildId]) {
        if (!id || names.has(id)) continue;
        try {
            const guild = await client.guilds.fetch(id);
            names.set(id, guild.name);
        } catch {
            // Left unresolved; the raw ID still renders.
        }
    }
    return names;
}

export function configViewCard(
    config: StaffBotConfig,
    guildNames: Map<string, string>,
    setCommand: string
): RenderedMessage {
    // One heading per block, one divider between blocks, and nothing else
    // doing the dividing. Blank lines inside a text display look like accident;
    // a Separator is the thing Discord provides for this and it renders the
    // same width every time.
    const block = (container: ContainerBuilder, groups: KeyGroup[]): ContainerBuilder => {
        groups.forEach((group, index) => {
            if (index > 0) container.addSeparatorComponents(separator());
            container.addTextDisplayComponents(
                text(`### ${GROUP_LABELS[group]}\n${groupBlock(group, config, guildNames)}`)
            );
        });
        return container;
    };

    const wiring = block(new ContainerBuilder().setAccentColor(COLOUR.admin), [
        "servers",
        "roles",
        "channels"
    ]);

    const policy = block(new ContainerBuilder().setAccentColor(COLOUR.admin), [
        "targets",
        "timings",
        "calendar"
    ]);

    // The two transfer buttons ride on the policy block rather than on the
    // status block at the top. Someone reading down the card has seen what the
    // settings are by the time they reach a control that replaces all of them.
    policy.addSeparatorComponents(separator());
    policy.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId("config:export:now")
                .setLabel("Export as JSON")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("config:import:open")
                .setLabel("Import JSON")
                .setStyle(ButtonStyle.Secondary)
        )
    );

    // Settings that parse, validate, and still will not do what their author
    // expects: a cycle whose anchor has not arrived, a requirement nobody can
    // reach, a shift that ends before the member is marked Away. A card that
    // lists every key and none of their consequences is a card that reads as
    // healthy while the bot assesses nobody.
    const warnings = configWarnings(config, new Date());
    const containers = [statusContainer(config, setCommand), wiring, policy];

    if (warnings.length > 0) {
        const problems = new ContainerBuilder()
            .setAccentColor(COLOUR.pending)
            .addTextDisplayComponents(
                text(
                    `### ${emojiForColour(COLOUR.pending)} Worth knowing\n` +
                        warnings
                            .map((warning) => `**${String(warning.key)}**\n${warning.text}`)
                            .join("\n\n")
                )
            );
        // Second, under the setup status: what is missing matters before what
        // is set oddly, and both matter before the full listing.
        containers.splice(1, 0, problems);
    }

    return containersMessage(containers);
}

/**
 * The second click on a key that moves every boundary ever recorded.
 *
 * `weekStartDay` and `accountingTimezone` are the only two keys that reach
 * backwards. Everything else applies from now on, and applies immediately.
 */
export function configHistoryConfirmCard(input: {
    key: string;
    value: string;
    body: string;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(`### ${emojiForColour(COLOUR.pending)} This moves every week ever recorded\n${input.body}`)
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`config:setConfirm:${input.key}|${input.value}`)
                    .setLabel("Change it anyway")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId("config:setCancel:none")
                    .setLabel("Leave it alone")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS };
}

/** The export, as a file rather than as a wall of text in the channel. */
export function configExportCard(config: StaffBotConfig): RenderedMessage {
    const json = Buffer.from(exportConfig(config), "utf8");
    const fileName = `staffbot-config-${new Date().toISOString().slice(0, 10)}.json`;
    const attachment = new AttachmentBuilder(json, { name: fileName });

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.admin)
        .addTextDisplayComponents(
            text(
                "### Configuration export\n" +
                    "Every key and its current value. Paste it back through **Import JSON** to " +
                    "restore this setup, or paste part of it into another deployment to copy " +
                    "the policy without the server and role ids.\n\n" +
                    "-# Only you can see this file. It holds no tokens or secrets, only ids " +
                    "and settings, but it does name every role and channel the bot touches."
            )
        )
        .addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`));

    return {
        components: [container],
        files: [attachment],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}

function changeLine(change: ConfigChange, guildNames: Map<string, string>): string {
    const show = (value: unknown): string => {
        if (Array.isArray(value)) {
            return value.length === 0
                ? "*nothing*"
                : value.map((id) => mentionFor(change.key, String(id), guildNames)).join(" ");
        }
        if (value === "") return "*nothing*";
        return CONFIG_KEYS[change.key].target === "plain"
            ? `**${String(value)}**`
            : mentionFor(change.key, String(value), guildNames);
    };
    return (
        `**${change.key}**${change.relocating ? " *(moves the bot)*" : ""}\n` +
        `-# ${show(change.from)} to ${show(change.to)}`
    );
}

/**
 * What the paste would do, before it does any of it.
 *
 * An import can rewrite where the bot lives and which roles mean what, so the
 * whole of it is shown as a before and after list first. Keys already holding
 * the value they name are counted rather than listed: they are the bulk of a
 * full file and none of the decision.
 */
export function configImportCard(
    report: ImportReport,
    token: string,
    guildNames: Map<string, string>
): RenderedMessage {
    if (!report.ok) {
        return noticeCard(
            "Nothing was imported",
            report.problems.join("\n") +
                (report.unchanged.length > 0
                    ? `\n\n-# ${report.unchanged.length} other key(s) already match.`
                    : ""),
            { colour: COLOUR.adverse, ephemeral: true }
        );
    }

    const relocating = report.changes.filter((change) => change.relocating);

    const container = new ContainerBuilder()
        .setAccentColor(relocating.length > 0 ? COLOUR.adverse : COLOUR.pending)
        .addTextDisplayComponents(
            text(
                `### Apply ${report.changes.length} change(s)?\n` +
                    report.changes
                        .map((change) => changeLine(change, guildNames))
                        .join("\n") +
                    (report.unchanged.length > 0
                        ? `\n\n-# ${report.unchanged.length} other key(s) already match and ` +
                          "are left alone."
                        : "")
            )
        );

    if (relocating.length > 0) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                "**This moves the bot to another server.** Commands are registered per server, " +
                    "so they will disappear from this one and appear in the new one on the next " +
                    "restart. Make sure the bot is already in that server and holds a role " +
                    "above everything it manages."
            )
        );
    }

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`config:apply:${token}`)
                .setLabel(`Apply ${report.changes.length} change(s)`)
                .setStyle(relocating.length > 0 ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`config:discard:${token}`)
                .setLabel("Discard")
                .setStyle(ButtonStyle.Secondary)
        )
    );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * The operator's card: what the bot is doing, and what is stopping it.
 *
 * `/dev status` is seededOnly, which is what lets this name a deployment switch
 * at all. The rule that nothing user-facing names an environment variable holds
 * for every card a Moderator can reach; this one is reachable only by the person
 * who would have to go and change it, and telling them a switch exists without
 * naming it makes the card useless. Same exemption `/dev purge` already has.
 */
export function devStatusCard(input: {
    uptimeMs: number;
    gatewayMs: number | null;
    databaseOk: boolean;
    schedulerRunning: boolean;
    jobs: {
        name: string;
        lastRunAt: Date | null;
        lastOutcome: "ok" | "failed" | null;
        lastError: string | null;
        nextRunAt: Date | null;
        failures: number;
    }[];
    missingRequired: string[];
    warnings: { key: string; text: string }[];
    dangerousCommands: boolean;
}): RenderedMessage {
    // Red when something is actually broken, amber when something is merely
    // unset or oddly configured, green when there is nothing to say. The
    // accent is the summary; the reader should not have to find it in the text.
    const broken =
        !input.databaseOk ||
        !input.schedulerRunning ||
        input.jobs.some((job) => job.lastOutcome === "failed");
    const unsettled = input.missingRequired.length > 0 || input.warnings.length > 0;
    const colour = broken ? COLOUR.adverse : unsettled ? COLOUR.pending : COLOUR.approved;

    const health = [
        `**Up** ${formatDuration(input.uptimeMs)}`,
        `**Gateway** ${input.gatewayMs === null || input.gatewayMs < 0 ? "not measured yet" : `${Math.round(input.gatewayMs)}ms`}`,
        `**Database** ${input.databaseOk ? "reachable" : "**unreachable**"}`,
        `**Scheduler** ${input.schedulerRunning ? `${input.jobs.length} jobs armed` : "**not running**"}`
    ].join("\n");

    const jobLines = input.jobs.map((job) => {
        const last =
            job.lastRunAt === null
                ? "not yet run"
                : `${job.lastOutcome === "failed" ? "⚠️ failed " : ""}${ts(job.lastRunAt, "R")}`;
        const next = job.nextRunAt === null ? "not armed" : ts(job.nextRunAt, "R");
        const failures = job.failures > 0 ? ` · ${job.failures} failure${job.failures === 1 ? "" : "s"}` : "";
        return (
            `**${job.name}** — ran ${last}, next ${next}${failures}` +
            (job.lastError ? `\n-# ${job.lastError.slice(0, 180)}` : "")
        );
    });

    const configLines: string[] = [];
    if (input.missingRequired.length > 0) {
        configLines.push(
            `⚠️ **${input.missingRequired.length} required ${
                input.missingRequired.length === 1 ? "key is" : "keys are"
            } unset:** ${input.missingRequired.join(", ")}`
        );
    }
    for (const warning of input.warnings) configLines.push(`⚠️ **${warning.key}** — ${warning.text}`);
    if (configLines.length === 0) configLines.push("Everything required is set and nothing looks wrong.");

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(text(`### ${emojiForColour(colour)} Bot status\n${health}`))
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(text(`### Jobs\n${jobLines.join("\n")}`))
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(text(`### Configuration\n${configLines.join("\n\n")}`));

    if (input.dangerousCommands) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                "### ⚠️ Deployment\n**DEV_DANGEROUS_COMMANDS is on.** `/dev purge` can delete " +
                    "real assessment history, not just rehearsals. Unset it and restart when " +
                    "you are done."
            )
        );
    }

    return { components: [container], files: [], flags: V2_FLAGS };
}
