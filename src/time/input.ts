import { wallClockIn, zonedToUtc } from "./calendar.js";
import { parsePhrase, type PhraseConstraints } from "./naturalDate.js";

/**
 * Parsing what a person typed into a text box.
 *
 * Leave arrives through a modal rather than through slash command options,
 * which means free text and therefore a real parser. Two rules keep this
 * predictable: a date is read in the member's own clock, because that is the
 * clock they were looking at when they decided to be away, and an
 * underspecified phrase always resolves forward, because leave is an
 * arrangement about the future.
 *
 * ISO dates keep working exactly as they did, and keep their old behaviour of
 * meaning what they say, a date in the past included. Those are refused later
 * by name rather than moved without saying so.
 */

export interface WallClockInput {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

/** `2026-10-06`, `2026-10-06 09:00`, `2026-10-06T09:00`, `2026-10-06 9:00 am`. */
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i;

/** How far forward a search will go before giving up. */
const SEARCH_LIMIT_DAYS = 1830;

/** Reference point for resolving a phrase that does not pin its own date. */
export interface Reference {
    now: Date;
    timeZone: string;
}

function isRealDate(parts: WallClockInput): boolean {
    // Round tripping through UTC is what rejects a day that does not exist:
    // Date.UTC rolls 2026-02-31 forward to 3 March rather than failing.
    const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    return (
        probe.getUTCFullYear() === parts.year &&
        probe.getUTCMonth() === parts.month - 1 &&
        probe.getUTCDate() === parts.day &&
        parts.hour <= 23 &&
        parts.minute <= 59
    );
}

function parseIso(raw: string): WallClockInput | null {
    const match = ISO.exec(raw.trim());
    if (!match) return null;

    const [, year, month, day, hour, minute, meridiem] = match;
    let hours = hour === undefined ? 0 : Number(hour);
    const minutes = minute === undefined ? 0 : Number(minute);

    if (meridiem) {
        if (hours < 1 || hours > 12) return null;
        const lower = meridiem.toLowerCase();
        if (lower === "pm" && hours !== 12) hours += 12;
        if (lower === "am" && hours === 12) hours = 0;
    }

    const parts: WallClockInput = {
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: hours,
        minute: minutes
    };

    return isRealDate(parts) ? parts : null;
}

interface CalendarDate {
    year: number;
    month: number;
    day: number;
}

const DAY_MS = 86_400_000;

function addDays(date: CalendarDate, days: number): CalendarDate {
    const moved = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
    return {
        year: moved.getUTCFullYear(),
        month: moved.getUTCMonth() + 1,
        day: moved.getUTCDate()
    };
}

/** Month arithmetic that clamps: 31 January plus a month is 28 February. */
function addMonths(date: CalendarDate, months: number): CalendarDate {
    const total = date.year * 12 + (date.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { year, month, day: Math.min(date.day, lastDay) };
}

function weekdayOf(date: CalendarDate): number {
    return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function satisfies(date: CalendarDate, wanted: PhraseConstraints): boolean {
    if (wanted.year !== undefined && date.year !== wanted.year) return false;
    if (wanted.month !== undefined && date.month !== wanted.month) return false;
    if (wanted.day !== undefined && date.day !== wanted.day) return false;
    if (wanted.weekday !== undefined && weekdayOf(date) !== wanted.weekday) return false;
    return true;
}

/**
 * Turn constraints into the one date they describe.
 *
 * An exact phrase is taken at its word: a full calendar date, or a count of
 * days from today. Everything else is a forward search from today, stopping
 * at the first date that satisfies every constraint *and* has not already gone.
 * That second condition is what makes "Tuesday at 9am", typed on a Tuesday
 * afternoon, mean next Tuesday rather than a moment this morning.
 */
function resolve(wanted: PhraseConstraints, reference: Reference): WallClockInput | null {
    const today = wallClockIn(reference.now, reference.timeZone);
    let base: CalendarDate = { year: today.year, month: today.month, day: today.day };

    if (wanted.offsetMonths !== undefined) base = addMonths(base, wanted.offsetMonths);
    if (wanted.offsetDays !== undefined) base = addDays(base, wanted.offsetDays);

    if (wanted.exact) {
        const date: CalendarDate =
            wanted.year !== undefined &&
            wanted.month !== undefined &&
            wanted.day !== undefined
                ? { year: wanted.year, month: wanted.month, day: wanted.day }
                : base;
        const parts = { ...date, hour: wanted.hour, minute: wanted.minute };
        return isRealDate(parts) ? parts : null;
    }

    for (let step = 0; step <= SEARCH_LIMIT_DAYS; step += 1) {
        const candidate = addDays(base, step);
        if (step === 0 && wanted.skipToday) continue;
        if (!satisfies(candidate, wanted)) continue;

        const parts = { ...candidate, hour: wanted.hour, minute: wanted.minute };
        if (!isRealDate(parts)) continue;

        // A match whose moment has already passed is not the one they meant.
        const instant = zonedToUtc(parts, reference.timeZone);
        if (instant.getTime() <= reference.now.getTime()) continue;

        return parts;
    }

    return null;
}

/**
 * Parse a date, optionally with a time, into a wall clock reading.
 *
 * Without a reference point only the ISO forms can be read: "Tuesday" has no
 * meaning without a today to count from, and inventing one from the server's
 * clock is how a member in Auckland gets a date a day out.
 */
export function parseWallClockInput(
    raw: string,
    reference?: Reference
): WallClockInput | null {
    const iso = parseIso(raw);
    if (iso) return iso;
    if (!reference) return null;

    const wanted = parsePhrase(raw);
    return wanted ? resolve(wanted, reference) : null;
}

/** The instant a typed wall clock reading denotes, read in the member's zone. */
export function instantFromInput(parts: WallClockInput, timeZone: string): Date {
    return zonedToUtc(parts, timeZone);
}

/** Parse and convert in one step. Null when the text is not a date. */
export function parseInstant(raw: string, timeZone: string, now?: Date): Date | null {
    const parts = parseWallClockInput(
        raw,
        now ? { now, timeZone } : undefined
    );
    return parts ? instantFromInput(parts, timeZone) : null;
}

/** `2026-10-06 09:00` for an instant, in the given zone. Prefills the modal. */
export function formatForInput(instant: Date, timeZone: string): string {
    const wall = wallClockIn(instant, timeZone);
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ` +
        `${pad(wall.hour)}:${pad(wall.minute)}`
    );
}

/**
 * The example text every leave field shows.
 *
 * It names a weekday rather than an ISO date now, because the placeholder is
 * the only place a member learns that plain English is accepted at all. The
 * weekday is a real one from their own near future, so following the example
 * literally produces a date that works.
 */
export function inputExample(now: Date, timeZone: string): string {
    const wall = wallClockIn(new Date(now.getTime() + 4 * DAY_MS), timeZone);
    const names = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
    ];
    return `${names[wall.weekday]} at 9am`;
}
