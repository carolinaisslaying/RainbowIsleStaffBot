import {
    CONFIG_KEYS,
    DEFAULT_CONFIG,
    isArrayKey,
    parseConfigValue,
    type StaffBotConfig
} from "./guildConfig.js";

/**
 * Reading a configuration out, and reading one back in.
 *
 * Export is the whole document. Import is deliberately not: only the keys the
 * pasted JSON actually names are applied, everything else is left alone. That
 * turns one feature into two useful ones. A full export pasted back restores a
 * deployment, and a handful of keys pasted in moves the policy from a test
 * server to a live one without touching guild ids or role ids that mean nothing
 * over there. It also gets around the modal's 4000 character ceiling, which a
 * config with a long tracked-channel list can exceed: paste it in two halves.
 *
 * Every value goes through `parseConfigValue`, the same validator `/config set`
 * uses. Nothing here reimplements a rule, so nothing here can disagree with the
 * command. Values arrive from JSON already typed, so they are stringified back
 * into the form that validator expects.
 *
 * An import is all or nothing. A half applied configuration is harder to
 * diagnose than one that was refused, so a single bad key fails the batch and
 * the report names every problem at once rather than one per attempt.
 */

/** Keys whose value decides where the bot lives. Changing one relocates it. */
export const RELOCATING_KEYS: (keyof StaffBotConfig)[] = ["publicGuildId", "staffGuildId"];

export interface ConfigChange {
    key: keyof StaffBotConfig;
    from: unknown;
    to: unknown;
    /** This key moves the bot to another server. */
    relocating: boolean;
}

export interface ImportReport {
    ok: boolean;
    /** Keys that would change. Keys already holding the value are not here. */
    changes: ConfigChange[];
    /** Named keys whose value already matches. Counted, never applied. */
    unchanged: (keyof StaffBotConfig)[];
    /** Everything wrong with the paste, all of it, in one pass. */
    problems: string[];
}

export function exportConfig(config: StaffBotConfig): string {
    // Key order follows the interface rather than the document, so two exports
    // of the same settings produce the same file and a diff shows only what
    // actually moved.
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(CONFIG_KEYS) as (keyof StaffBotConfig)[]) {
        ordered[key] = config[key];
    }
    return JSON.stringify(ordered, null, 2);
}

/**
 * Whether a parsed value already matches what the document holds.
 *
 * Instants compare as instants. `parseConfigValue` normalises a date through
 * `toISOString`, which adds milliseconds, so the stored `2026-09-28T00:00:00Z`
 * and the parsed `2026-09-28T00:00:00.000Z` are the same moment written two
 * ways. Comparing the strings reported a change on every round trip of a
 * configuration nobody had touched.
 */
function sameValue(key: keyof StaffBotConfig, left: unknown, right: unknown): boolean {
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, i) => item === right[i]);
    }
    if (CONFIG_KEYS[key].kind === "isoDate" && typeof left === "string" && typeof right === "string") {
        const [a, b] = [Date.parse(left), Date.parse(right)];
        return !Number.isNaN(a) && a === b;
    }
    return left === right;
}

/**
 * An empty value, on a key whose own default is empty.
 *
 * Being unset is a real state here: a fresh deployment has no roles and no
 * channels, and `isUnset` exists to describe exactly that. `parseConfigValue`
 * refuses an empty string, correctly, because nobody types one into
 * `/config set` on purpose. An export of a half configured bot carries several
 * of them, though, and refusing to read that file back would make export
 * useless on the deployments most likely to want it.
 *
 * The default has to be empty too. That is what stops a paste blanking
 * `accountingTimezone`, which every week boundary is measured from.
 */
function isBlank(key: keyof StaffBotConfig, value: unknown): boolean {
    const blankValue = Array.isArray(value) ? value.length === 0 : value === "";
    if (!blankValue) return false;
    const fallback = DEFAULT_CONFIG[key];
    return Array.isArray(fallback) ? fallback.length === 0 : fallback === "";
}

/** The form `parseConfigValue` expects, from a value JSON already typed. */
function asRawString(key: keyof StaffBotConfig, value: unknown): string {
    return isArrayKey(key) ? (value as unknown[]).join(" ") : String(value);
}

export function readImport(raw: string, current: StaffBotConfig): ImportReport {
    const empty: ImportReport = { ok: false, changes: [], unchanged: [], problems: [] };

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {
            ...empty,
            problems: [
                "That is not valid JSON. Paste the whole file, including the opening and " +
                    "closing braces."
            ]
        };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ...empty, problems: ["Expected a JSON object of configuration keys."] };
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
        return { ...empty, problems: ["That object is empty, so there is nothing to import."] };
    }

    const problems: string[] = [];
    const changes: ConfigChange[] = [];
    const unchanged: (keyof StaffBotConfig)[] = [];

    for (const [name, value] of entries) {
        if (!(name in CONFIG_KEYS)) {
            // Named and refused rather than skipped: a typo that imports
            // silently looks exactly like a setting that did not take.
            problems.push(`**${name}** is not a configuration key.`);
            continue;
        }
        const key = name as keyof StaffBotConfig;

        // Shape before content. `parseConfigValue` reads a string, so a number
        // handed to an array key would otherwise stringify into something that
        // happens to validate.
        if (isArrayKey(key) && !Array.isArray(value)) {
            problems.push(`**${key}** expects a list, and this is not one.`);
            continue;
        }
        if (!isArrayKey(key) && Array.isArray(value)) {
            problems.push(`**${key}** expects one value, and this is a list.`);
            continue;
        }
        if (value === null || value === undefined) {
            problems.push(`**${key}** has no value. Remove the key or give it one.`);
            continue;
        }
        if (CONFIG_KEYS[key].kind === "boolean" && typeof value !== "boolean") {
            problems.push(`**${key}** expects true or false.`);
            continue;
        }

        const blank = isBlank(key, value);
        if (!blank && (value === "" || (Array.isArray(value) && value.length === 0))) {
            problems.push(
                `**${key}** cannot be emptied. Give it a value or leave the key out.`
            );
            continue;
        }

        const result = blank
            ? { ok: true as const, value: Array.isArray(value) ? [] : "" }
            : parseConfigValue(key, asRawString(key, value));
        if (!result.ok) {
            problems.push(`**${key}**: ${result.error}`);
            continue;
        }

        if (sameValue(key, result.value, current[key])) {
            unchanged.push(key);
            continue;
        }

        changes.push({
            key,
            from: current[key],
            to: result.value,
            relocating: RELOCATING_KEYS.includes(key)
        });
    }

    if (problems.length > 0) return { ok: false, changes: [], unchanged, problems };
    if (changes.length === 0) {
        return {
            ok: false,
            changes: [],
            unchanged,
            problems: ["Every key in that file already holds the value it names."]
        };
    }

    return { ok: true, changes, unchanged, problems: [] };
}
