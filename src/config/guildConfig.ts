import { collections } from "../db/client.js";
import { env } from "../config/env.js";
import { isValidTimezone } from "../time/timezones.js";
import { log } from "../log.js";

/**
 * Policy lives here, not in constants. Everything the spec calls "configurable"
 * is a key in this single document with the stated default.
 */

export interface StaffBotConfig {
    publicGuildId: string;
    staffGuildId: string;

    availabilityRole: string;
    moderationDepartmentRole: string;
    onLeaveRole: string;
    staffRankRoles: string[];
    leadRoles: string[];
    executiveRoles: string[];

    trackedChannels: string[];
    leaveChannelId: string;
    reportChannelId: string;
    recapChannelId: string;

    accountingTimezone: string;
    weekStartDay: number;
    fortnightAnchor: string;

    weeklyTargetMinutes: number;
    fortnightRequiredMinutes: number;
    weeklyShiftTargetHours: number;
    weeklyActiveDaysTarget: number;
    amberThresholdPercent: number;
    softRingsEnabled: boolean;

    awayAfterMinutes: number;
    autoEndAfterAwayMinutes: number;
    maxShiftHours: number;
    heatmapLookbackWeeks: number;
}

type KeyKind = "string" | "number" | "boolean" | "stringArray" | "timezone" | "isoDate" | "weekday";

/** What a value points at, so the UI can render and autocomplete it properly. */
export type KeyTarget = "guild" | "role" | "channel" | "plain";

/** How badly the bot needs this before it can do its job. */
export type KeyImportance = "required" | "recommended" | "optional";

export type KeyGroup = "servers" | "roles" | "channels" | "targets" | "timings" | "calendar";

interface KeySpec {
    kind: KeyKind;
    description: string;
    target: KeyTarget;
    importance: KeyImportance;
    group: KeyGroup;
    /** What breaks while this is unset. Shown in the setup checklist. */
    consequence?: string;
    min?: number;
    max?: number;
}

export const CONFIG_KEYS: Record<keyof StaffBotConfig, KeySpec> = {
    publicGuildId: {
        kind: "string",
        description: "The community server",
        target: "guild",
        importance: "required",
        group: "servers",
        consequence: "Nothing resolves at all"
    },
    staffGuildId: {
        kind: "string",
        description: "The staff server",
        target: "guild",
        importance: "required",
        group: "servers",
        consequence: "Executive commands have nowhere to live"
    },
    moderationDepartmentRole: {
        kind: "string",
        description: "Marks someone as Moderation staff",
        target: "role",
        importance: "required",
        group: "roles",
        consequence: "Nobody resolves as staff and every command is refused"
    },
    executiveRoles: {
        kind: "stringArray",
        description: "Decide leave, review assessments, change config",
        target: "role",
        importance: "required",
        group: "roles",
        consequence: "Nobody can configure the bot or decide anything"
    },
    availabilityRole: {
        kind: "string",
        description: "Worn while on shift and available",
        target: "role",
        importance: "required",
        group: "roles",
        consequence: "Shifts open, but nothing shows who is available"
    },
    leadRoles: {
        kind: "stringArray",
        description: "See team totals and shift history",
        target: "role",
        importance: "recommended",
        group: "roles",
        consequence: "Lead tier is unreachable"
    },
    onLeaveRole: {
        kind: "string",
        description: "Worn while on approved leave",
        target: "role",
        importance: "recommended",
        group: "roles",
        consequence: "Leave activates, but nobody can see who is away"
    },
    staffRankRoles: {
        kind: "stringArray",
        description: "Individual ranks, set aside during leave",
        target: "role",
        importance: "recommended",
        group: "roles",
        consequence: "Leave strips the department role only, not ranks"
    },
    trackedChannels: {
        kind: "stringArray",
        description: "Where participation counts, in the community server",
        target: "channel",
        importance: "required",
        group: "channels",
        consequence: "No activity minutes are ever credited"
    },
    leaveChannelId: {
        kind: "string",
        description: "Leave requests awaiting an Executive decision",
        target: "channel",
        importance: "required",
        group: "channels",
        consequence: "Leave requests have nowhere to post and nobody can approve one"
    },
    reportChannelId: {
        kind: "string",
        description: "Fortnight report cards and assessment outcomes",
        target: "channel",
        importance: "required",
        group: "channels",
        consequence: "Fortnight report cards have nowhere to post"
    },
    recapChannelId: {
        kind: "string",
        description: "Weekly recap postings",
        target: "channel",
        importance: "optional",
        group: "channels",
        consequence: "Recaps still arrive by DM"
    },
    weeklyTargetMinutes: {
        kind: "number",
        description: "Outer ring target",
        target: "plain",
        importance: "optional",
        group: "targets",
        min: 1,
        max: 10080
    },
    fortnightRequiredMinutes: {
        kind: "number",
        description: "Compliance threshold",
        target: "plain",
        importance: "optional",
        group: "targets",
        min: 0,
        max: 20160
    },
    weeklyShiftTargetHours: {
        kind: "number",
        description: "Middle ring target",
        target: "plain",
        importance: "optional",
        group: "targets",
        min: 1,
        max: 168
    },
    weeklyActiveDaysTarget: {
        kind: "number",
        description: "Inner ring target",
        target: "plain",
        importance: "optional",
        group: "targets",
        min: 1,
        max: 7
    },
    amberThresholdPercent: {
        kind: "number",
        description: "Amber floor, percent of target",
        target: "plain",
        importance: "optional",
        group: "targets",
        min: 1,
        max: 99
    },
    softRingsEnabled: {
        kind: "boolean",
        description: "Render the two soft rings",
        target: "plain",
        importance: "optional",
        group: "targets"
    },
    awayAfterMinutes: {
        kind: "number",
        description: "Silence duration before marking as Away",
        target: "plain",
        importance: "optional",
        group: "timings",
        min: 1,
        max: 240
    },
    autoEndAfterAwayMinutes: {
        kind: "number",
        description: "Away duration before the shift auto-ends",
        target: "plain",
        importance: "optional",
        group: "timings",
        min: 1,
        max: 1440
    },
    maxShiftHours: {
        kind: "number",
        description: "Hard ceiling for a shift length",
        target: "plain",
        importance: "optional",
        group: "timings",
        min: 1,
        max: 24
    },
    heatmapLookbackWeeks: {
        kind: "number",
        description: "Lookback period for coverage heatmap",
        target: "plain",
        importance: "optional",
        group: "timings",
        min: 1,
        max: 52
    },
    accountingTimezone: {
        kind: "timezone",
        description: "Timezone used for measuring weekly boundaries",
        target: "plain",
        importance: "optional",
        group: "calendar"
    },
    weekStartDay: {
        kind: "weekday",
        description: "The day a new week begins",
        target: "plain",
        importance: "optional",
        group: "calendar"
    },
    fortnightAnchor: {
        kind: "isoDate",
        description: "Origin date the fortnight cycle counts from",
        target: "plain",
        importance: "optional",
        group: "calendar"
    }
};

export const GROUP_LABELS: Record<KeyGroup, string> = {
    servers: "Servers",
    roles: "Roles",
    channels: "Channels",
    targets: "Targets",
    timings: "Timings",
    calendar: "Calendar"
};

export function keysInGroup(group: KeyGroup): (keyof StaffBotConfig)[] {
    return (Object.keys(CONFIG_KEYS) as (keyof StaffBotConfig)[]).filter(
        (key) => CONFIG_KEYS[key].group === group
    );
}

export function isArrayKey(key: keyof StaffBotConfig): boolean {
    return CONFIG_KEYS[key].kind === "stringArray";
}

/** True when the key still holds nothing usable. */
export function isUnset(config: StaffBotConfig, key: keyof StaffBotConfig): boolean {
    const value = config[key];
    if (Array.isArray(value)) return value.length === 0;
    return value === "" || value === null || value === undefined;
}

export const DEFAULT_CONFIG: StaffBotConfig = {
    publicGuildId: "",
    staffGuildId: "",
    availabilityRole: "",
    moderationDepartmentRole: "",
    onLeaveRole: "",
    staffRankRoles: [],
    leadRoles: [],
    executiveRoles: [],
    trackedChannels: [],
    leaveChannelId: "",
    reportChannelId: "",
    recapChannelId: "",
    accountingTimezone: "UTC",
    weekStartDay: 1,
    fortnightAnchor: "2026-09-28T00:00:00Z",
    weeklyTargetMinutes: 120,
    fortnightRequiredMinutes: 240,
    weeklyShiftTargetHours: 4,
    weeklyActiveDaysTarget: 3,
    amberThresholdPercent: 75,
    softRingsEnabled: true,
    awayAfterMinutes: 20,
    autoEndAfterAwayMinutes: 30,
    maxShiftHours: 12,
    heatmapLookbackWeeks: 8
};

/**
 * Carry a pre-split deployment forward.
 *
 * `reviewChannelId` used to carry both leave requests and fortnight report
 * cards. It is two keys now, and an install configured before the split would
 * otherwise wake up with both of them empty and post nothing at all, silently.
 * The old value seeds whichever new key is still unset, so such an install
 * behaves exactly as it did until an Executive separates the two channels.
 *
 * Anything already set wins: this only ever fills a gap.
 */
export function adoptLegacyReviewChannel(
    config: StaffBotConfig,
    legacy: unknown
): StaffBotConfig {
    if (typeof legacy !== "string" || !legacy) return config;
    if (!config.leaveChannelId) config.leaveChannelId = legacy;
    if (!config.reportChannelId) config.reportChannelId = legacy;
    return config;
}

const CONFIG_ID = "guild";

let cache: StaffBotConfig | null = null;

/** Load once, then serve from memory. /config set invalidates. */
export async function loadConfig(): Promise<StaffBotConfig> {
    if (cache) return cache;
    const stored = await collections.guildConfig().findOne({ _id: CONFIG_ID });
    const merged: StaffBotConfig = { ...DEFAULT_CONFIG };
    if (stored) {
        for (const key of Object.keys(CONFIG_KEYS) as (keyof StaffBotConfig)[]) {
            const value = stored[key];
            if (value !== undefined && value !== null) {
                (merged as unknown as Record<string, unknown>)[key] = value;
            }
        }
    }
    // Environment bootstraps the guild IDs on first run so the bot can start
    // before anyone has run /config set.
    if (!merged.publicGuildId) merged.publicGuildId = env.publicGuildId;
    if (!merged.staffGuildId) merged.staffGuildId = env.staffGuildId;

    adoptLegacyReviewChannel(merged, stored?.reviewChannelId);

    cache = merged;
    return merged;
}

export function cachedConfig(): StaffBotConfig {
    if (!cache) throw new Error("Config not loaded. Call loadConfig() first.");
    return cache;
}

export function invalidateConfigCache(): void {
    cache = null;
}

export async function ensureConfigDocument(): Promise<void> {
    await collections.guildConfig().updateOne(
        { _id: CONFIG_ID },
        {
            $setOnInsert: {
                ...DEFAULT_CONFIG,
                publicGuildId: env.publicGuildId,
                staffGuildId: env.staffGuildId,
                createdAt: new Date()
            }
        },
        { upsert: true }
    );
}

export interface ParseResult {
    ok: boolean;
    value?: unknown;
    error?: string;
}

/** Everything arrives from Discord as a string. Coerce and validate here. */
export function parseConfigValue(key: keyof StaffBotConfig, raw: string): ParseResult {
    const spec = CONFIG_KEYS[key];
    if (!spec) return { ok: false, error: `Unknown key ${key}.` };
    const trimmed = raw.trim();

    switch (spec.kind) {
        case "string": {
            if (!trimmed) return { ok: false, error: "Value cannot be empty." };
            // Every single-value string key is a snowflake: a guild, a channel
            // or a role. Strip the decoration so a pasted <@&123> or <#456>
            // mention works, then insist on the ID underneath.
            const bare = trimmed.replace(/[<>@&#]/g, "");
            if (!/^\d{15,25}$/.test(bare)) {
                return {
                    ok: false,
                    error: "Expected a Discord ID. Paste the role or channel mention, or turn " +
                        "on Developer Mode and copy the ID."
                };
            }
            return { ok: true, value: bare };
        }
        case "stringArray": {
            const items = trimmed
                .split(/[\s,]+/)
                .map((item) => item.replace(/[<>@&#]/g, "").trim())
                .filter(Boolean);
            const bad = items.find((item) => !/^\d{15,25}$/.test(item));
            if (bad) return { ok: false, error: `**${bad}** is not a Discord ID.` };
            return { ok: true, value: items };
        }
        case "number": {
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed)) return { ok: false, error: "Expected a number." };
            if (spec.min !== undefined && parsed < spec.min) {
                return { ok: false, error: `Minimum is ${spec.min}.` };
            }
            if (spec.max !== undefined && parsed > spec.max) {
                return { ok: false, error: `Maximum is ${spec.max}.` };
            }
            return { ok: true, value: parsed };
        }
        case "boolean": {
            if (/^(true|yes|on|1|enabled)$/i.test(trimmed)) return { ok: true, value: true };
            if (/^(false|no|off|0|disabled)$/i.test(trimmed)) return { ok: true, value: false };
            return { ok: false, error: "Expected true or false." };
        }
        case "timezone": {
            if (!isValidTimezone(trimmed)) {
                return { ok: false, error: "Not a recognised IANA timezone identifier." };
            }
            return { ok: true, value: trimmed };
        }
        case "weekday": {
            const parsed = Number(trimmed);
            if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
                return { ok: false, error: "Expected 0 (Sunday) through 6 (Saturday)." };
            }
            return { ok: true, value: parsed };
        }
        case "isoDate": {
            const parsed = new Date(trimmed);
            if (Number.isNaN(parsed.getTime())) {
                return { ok: false, error: "Expected an ISO 8601 instant." };
            }
            return { ok: true, value: parsed.toISOString() };
        }
        default:
            return { ok: false, error: "Unsupported key kind." };
    }
}

export async function setConfigValue(
    key: keyof StaffBotConfig,
    value: unknown
): Promise<void> {
    await collections.guildConfig().updateOne(
        { _id: CONFIG_ID },
        { $set: { [key]: value, updatedAt: new Date() } },
        { upsert: true }
    );
    invalidateConfigCache();
    log.info(`Config key ${key} updated`);
}

export function fortnightAnchorDate(config: StaffBotConfig): Date {
    const anchor = new Date(config.fortnightAnchor);
    if (Number.isNaN(anchor.getTime())) {
        return new Date(DEFAULT_CONFIG.fortnightAnchor);
    }
    return anchor;
}
