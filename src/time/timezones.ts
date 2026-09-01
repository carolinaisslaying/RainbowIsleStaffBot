import { wallClockIn } from "./calendar.js";

/**
 * Member timezones are display only. They never affect totals, ring state,
 * leaderboard position or assessment outcome.
 */

let cachedZones: string[] | null = null;

/**
 * Abbreviations, cached with a short TTL.
 *
 * They are display and search aids only, never storage: "CST" is Central,
 * China and Cuba Standard Time, "IST" is India, Ireland and Israel, and every
 * one of them flips with daylight saving (NZST becomes NZDT). Only the IANA
 * identifier is unambiguous, so that is what is stored, and the abbreviation is
 * shown beside it so a member recognises their own zone without having to think
 * about which city they are nearest.
 */
const ABBREVIATION_TTL_MS = 15 * 60 * 1000;
let abbreviationIndex: Map<string, string> | null = null;
let abbreviationBuiltAt = 0;

/**
 * No single locale carries abbreviations for every zone: en-NZ knows NZST and
 * AEST but calls New York "GMT-4", while en-US knows EDT but calls Auckland
 * "GMT+12". So each zone is asked of several locales in turn and the first
 * lettered answer wins. NZ English leads, being the house style.
 *
 * Plenty of zones have no abbreviation in any locale (Tokyo, Singapore, Sao
 * Paulo). Those legitimately have none in common use, and fall back to the
 * offset, which is what people call them anyway.
 */
const ABBREVIATION_LOCALES = ["en-NZ", "en-US", "en-GB", "en-IN", "en-ZA", "en"];

function lettered(value: string): boolean {
    return /^[A-Za-z]{2,6}$/.test(value);
}

function abbreviationIn(zone: string, locale: string, at: Date): string {
    try {
        const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
            .formatToParts(at)
            .find((candidate) => candidate.type === "timeZoneName");
        return part?.value ?? "";
    } catch {
        return "";
    }
}

/** "NZST", or "" for a zone with no abbreviation in common use. */
export function zoneAbbreviation(zone: string, at = new Date()): string {
    for (const locale of ABBREVIATION_LOCALES) {
        const value = abbreviationIn(zone, locale, at);
        if (lettered(value)) return value;
    }
    return "";
}

function abbreviations(at = new Date()): Map<string, string> {
    const now = at.getTime();
    if (abbreviationIndex && now - abbreviationBuiltAt < ABBREVIATION_TTL_MS) {
        return abbreviationIndex;
    }
    const index = new Map<string, string>();
    for (const zone of supportedTimezones()) {
        index.set(zone, zoneAbbreviation(zone, at));
    }
    abbreviationIndex = index;
    abbreviationBuiltAt = now;
    return index;
}

let altAbbreviationIndex: Map<string, string> | null = null;
let altAbbreviationBuiltAt = 0;

/**
 * The same zones half a year away, so the other half of a daylight saving pair
 * is searchable too. Someone typing NZDT in July means Auckland, and finding
 * nothing because it is currently NZST would be a poor answer.
 */
function altAbbreviations(at = new Date()): Map<string, string> {
    const now = at.getTime();
    if (altAbbreviationIndex && now - altAbbreviationBuiltAt < ABBREVIATION_TTL_MS) {
        return altAbbreviationIndex;
    }
    const halfYearAway = new Date(now + 182 * 86_400_000);
    const index = new Map<string, string>();
    for (const zone of supportedTimezones()) {
        index.set(zone, zoneAbbreviation(zone, halfYearAway));
    }
    altAbbreviationIndex = index;
    altAbbreviationBuiltAt = now;
    return index;
}

/** "UTC+13:00". Signed, padded, and never used as a stored value. */
export function zoneOffsetLabel(zone: string, at = new Date()): string {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "longOffset"
    });
    const part = formatter
        .formatToParts(at)
        .find((candidate) => candidate.type === "timeZoneName");
    return part?.value?.replace(/^GMT/, "UTC") || "UTC+00:00";
}

/**
 * The full wall clock reading in a given zone: "Tuesday, 1 September 2026 at
 * 3:19 pm".
 *
 * Hand formatted on purpose, and one of only two places in the bot that is.
 * Discord timestamp markup always renders in the READER's timezone, so it can
 * show an instant but never an instant as seen from a chosen zone. Verifying a
 * zone choice needs exactly that, so there is no primitive to use here.
 */
export function zoneWallClock(zone: string, at = new Date()): string {
    return new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "short"
    }).format(at);
}

/** Current local clock in a zone, for the picker. Not an instant in prose. */
export function zoneLocalTime(zone: string, at = new Date()): string {
    return new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    }).format(at);
}

/**
 * One picker row: "Pacific/Auckland - NZDT, UTC+13:00, 1:45 pm".
 * Capped to Discord's 100 character choice name limit.
 */
export function describeZone(zone: string, at = new Date()): string {
    const abbreviation = zoneAbbreviation(zone, at);
    const parts = [abbreviation, zoneOffsetLabel(zone, at), zoneLocalTime(zone, at)].filter(
        Boolean
    );
    return `${zone} - ${parts.join(", ")}`.slice(0, 100);
}

export function supportedTimezones(): string[] {
    if (!cachedZones) {
        cachedZones = Intl.supportedValuesOf("timeZone").slice().sort();
    }
    return cachedZones;
}

/**
 * Resolve a zone to the canonical spelling this runtime actually uses, or null
 * if it is not a real zone.
 *
 * The IANA database carries aliases, and which side of an alias pair
 * `Intl.supportedValuesOf` reports depends on the ICU build: older ones list
 * `Asia/Calcutta`, newer ones `Asia/Kolkata`. Checking list membership alone
 * would therefore reject a perfectly valid zone on half of all runtimes, so an
 * unlisted name is given a second chance through the formatter, which resolves
 * aliases and is case insensitive.
 *
 * Fixed offsets like "UTC+13" are still rejected: they carry no daylight saving
 * rules, so a member who set one would silently drift for half the year.
 */
export function canonicaliseTimezone(zone: string): string | null {
    if (!zone || typeof zone !== "string") return null;
    const trimmed = zone.trim();
    if (!trimmed) return null;
    if (/^(?:UTC|GMT)[+-]/i.test(trimmed)) return null;
    if (/^[+-]\d/.test(trimmed)) return null;

    if (supportedTimezones().includes(trimmed)) return trimmed;

    try {
        const resolved = new Intl.DateTimeFormat("en-US", {
            timeZone: trimmed
        }).resolvedOptions().timeZone;
        return resolved ?? null;
    } catch {
        return null; // RangeError: not a zone this runtime knows
    }
}

export function isValidTimezone(zone: string): boolean {
    return canonicaliseTimezone(zone) !== null;
}

/**
 * Autocomplete search.
 *
 * Matches the IANA identifier, the current abbreviation, or the UTC offset, so
 * "NZST", "auckland", "pacific" and "+12" all lead to Pacific/Auckland. Nobody
 * should have to work out which city they are nearest.
 *
 * Results are ranked by how the query matched, then by whether the zone is one
 * people actually live in: several dozen zones report NZST, but a member typing
 * it means Auckland, not Antarctica/McMurdo.
 */
export function searchTimezones(query: string, limit = 25, at = new Date()): string[] {
    const raw = query.trim().toLowerCase();
    const needle = raw.replace(/\s+/g, "_");
    const zones = supportedTimezones();
    if (!needle) return commonZones().slice(0, limit);

    const codes = abbreviations(at);
    const altCodes = altAbbreviations(at);
    const offsets = offsetLabels(at);

    // Lower is better.
    const RANK_NAME_PREFIX = 0;
    const RANK_CODE_EXACT = 1;
    const RANK_OFFSET = 2;
    const RANK_NAME_CONTAINS = 3;
    const RANK_CODE_PARTIAL = 4;

    const scored: { zone: string; rank: number; common: number }[] = [];

    for (const zone of zones) {
        const haystack = zone.toLowerCase();
        const code = (codes.get(zone) ?? "").toLowerCase();
        const altCode = (altCodes.get(zone) ?? "").toLowerCase();
        const offset = (offsets.get(zone) ?? "").toLowerCase();

        let rank: number | null = null;
        if (haystack.startsWith(needle)) rank = RANK_NAME_PREFIX;
        else if (code && code === raw) rank = RANK_CODE_EXACT;
        else if (altCode && altCode === raw) rank = RANK_CODE_EXACT;
        else if (raw.length >= 2 && offset.includes(raw)) rank = RANK_OFFSET;
        else if (haystack.includes(needle)) rank = RANK_NAME_CONTAINS;
        else if (code && code.includes(raw)) rank = RANK_CODE_PARTIAL;

        if (rank === null) continue;
        const common = commonZones().indexOf(zone);
        scored.push({ zone, rank, common: common === -1 ? Number.MAX_SAFE_INTEGER : common });
    }

    scored.sort(
        (left, right) =>
            left.rank - right.rank ||
            left.common - right.common ||
            left.zone.localeCompare(right.zone)
    );

    return scored.slice(0, limit).map((entry) => entry.zone);
}

let offsetIndex: Map<string, string> | null = null;
let offsetBuiltAt = 0;

function offsetLabels(at = new Date()): Map<string, string> {
    const now = at.getTime();
    if (offsetIndex && now - offsetBuiltAt < ABBREVIATION_TTL_MS) return offsetIndex;
    const index = new Map<string, string>();
    for (const zone of supportedTimezones()) index.set(zone, zoneOffsetLabel(zone, at));
    offsetIndex = index;
    offsetBuiltAt = now;
    return index;
}

/**
 * Build both indexes ahead of the first autocomplete, so no member pays the
 * one-off cost as latency inside a 3 second interaction window.
 */
export function warmTimezoneIndexes(at = new Date()): void {
    abbreviations(at);
    altAbbreviations(at);
    offsetLabels(at);
}

/**
 * Resolved through canonicaliseTimezone so an entry spelled the modern way
 * still appears on a runtime whose ICU reports the legacy alias, and vice versa.
 */
let commonZonesCache: string[] | null = null;

function commonZones(): string[] {
    if (commonZonesCache) return commonZonesCache;
    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const zone of COMMON_ZONES) {
        const canonical = canonicaliseTimezone(zone);
        if (canonical && !seen.has(canonical)) {
            seen.add(canonical);
            resolved.push(canonical);
        }
    }
    commonZonesCache = resolved;
    return resolved;
}

/** Offered first when a member has typed nothing yet. */
const COMMON_ZONES = [
    "Pacific/Auckland",
    "Australia/Sydney",
    "Australia/Perth",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Warsaw",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Africa/Johannesburg",
    "UTC"
];

/** Current local hour in a zone, for recap delivery windows. */
export function localHourIn(instant: Date, timeZone: string): number {
    return wallClockIn(instant, timeZone).hour;
}
