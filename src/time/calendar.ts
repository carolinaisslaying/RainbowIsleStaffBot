/**
 * Canonical accounting calendar.
 *
 * Weeks run from weekStartDay 00:00:00 to the following weekStartDay minus one
 * millisecond, measured in `accountingTimezone`. The default is UTC, but the
 * boundary code never assumes that: someone will change that key later, so all
 * arithmetic goes through Intl.DateTimeFormat parts against the configured zone.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const FORTNIGHT_MS = 14 * DAY_MS;

export interface WallClock {
    year: number;
    month: number; // 1-12
    day: number; // 1-31
    hour: number;
    minute: number;
    second: number;
    /** 0 = Sunday .. 6 = Saturday, matching Date#getUTCDay. */
    weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            weekday: "short"
        });
        formatterCache.set(timeZone, formatter);
    }
    return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
};

/** Decompose an instant into wall clock parts in the given zone. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
    const parts = partsFormatter(timeZone).formatToParts(instant);
    const lookup: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== "literal") lookup[part.type] = part.value;
    }
    return {
        year: Number(lookup.year),
        month: Number(lookup.month),
        day: Number(lookup.day),
        hour: Number(lookup.hour),
        minute: Number(lookup.minute),
        second: Number(lookup.second),
        weekday: WEEKDAY_INDEX[lookup.weekday] ?? 0
    };
}

/**
 * Offset of the zone from UTC at a given instant, in milliseconds.
 * Positive east of Greenwich.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
    const wall = wallClockIn(instant, timeZone);
    const asUtc = Date.UTC(
        wall.year,
        wall.month - 1,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second
    );
    // Discard sub-second: formatToParts has no millisecond field.
    return asUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

/**
 * Convert a wall clock reading in `timeZone` to the UTC instant it denotes.
 *
 * Two passes, because the offset we need depends on the instant we are trying
 * to find. The first guess uses the offset at the naive UTC interpretation; the
 * second corrects it. That converges for every real zone, including the ones
 * that shift at local midnight.
 *
 * Ambiguous local times (the repeated hour when clocks go back) resolve to the
 * first, pre-transition occurrence. Non-existent local times (the skipped hour
 * when clocks go forward) resolve forward past the gap. Both are stable and
 * documented rather than accidental.
 */
export function zonedToUtc(
    parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
    timeZone: string
): Date {
    const naive = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour ?? 0,
        parts.minute ?? 0,
        parts.second ?? 0
    );
    let offset = zoneOffsetMs(new Date(naive), timeZone);
    let instant = naive - offset;
    offset = zoneOffsetMs(new Date(instant), timeZone);
    instant = naive - offset;
    return new Date(instant);
}

/** Local midnight starting the day that `instant` falls on, as a UTC instant. */
export function startOfDayIn(instant: Date, timeZone: string): Date {
    const wall = wallClockIn(instant, timeZone);
    return zonedToUtc({ year: wall.year, month: wall.month, day: wall.day }, timeZone);
}

/** Shift a calendar date by whole days, without touching the clock. */
function addCalendarDays(
    date: { year: number; month: number; day: number },
    days: number
): { year: number; month: number; day: number } {
    const moved = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
    return {
        year: moved.getUTCFullYear(),
        month: moved.getUTCMonth() + 1,
        day: moved.getUTCDate()
    };
}

/**
 * Start of the accounting week containing `instant`.
 * weekStartDay follows Date#getUTCDay: 0 Sunday, 1 Monday.
 */
export function weekStartFor(
    instant: Date,
    timeZone: string,
    weekStartDay: number
): Date {
    const wall = wallClockIn(instant, timeZone);
    const back = (wall.weekday - weekStartDay + 7) % 7;
    const target = addCalendarDays(wall, -back);
    return zonedToUtc(target, timeZone);
}

/** Start of the week following the one containing `instant`. */
export function nextWeekStart(
    instant: Date,
    timeZone: string,
    weekStartDay: number
): Date {
    const current = weekStartFor(instant, timeZone, weekStartDay);
    const wall = wallClockIn(current, timeZone);
    // Step by calendar days, not by adding 7 * DAY_MS: a DST transition inside
    // the week makes those two different by an hour.
    return zonedToUtc(addCalendarDays(wall, 7), timeZone);
}

/** Exclusive end of the accounting week containing `instant`. */
export function weekEndFor(
    instant: Date,
    timeZone: string,
    weekStartDay: number
): Date {
    return nextWeekStart(instant, timeZone, weekStartDay);
}

/**
 * How many whole accounting weeks separate a week start from the anchor.
 * Rounded, because a DST transition between them makes the raw millisecond
 * difference an hour short of, or long of, an exact multiple of seven days.
 */
export function weekIndexFrom(weekStart: Date, anchor: Date): number {
    return Math.round((weekStart.getTime() - anchor.getTime()) / WEEK_MS);
}

/** Fortnight index of the fortnight containing `weekStart`. Negative before the anchor. */
export function fortnightIndexFor(weekStart: Date, anchor: Date): number {
    return Math.floor(weekIndexFrom(weekStart, anchor) / 2);
}

/**
 * True when `weekStart` is the second week of its fortnight, which is to say
 * that the week closing at its end completes a fortnight and triggers assessment.
 */
export function completesFortnight(weekStart: Date, anchor: Date): boolean {
    const weeks = weekIndexFrom(weekStart, anchor);
    return ((weeks % 2) + 2) % 2 === 1;
}

export interface FortnightWindow {
    index: number;
    week1Start: Date;
    week2Start: Date;
    /** Exclusive. */
    end: Date;
}

/** The two week starts and exclusive end of a fortnight, by index. */
export function fortnightWindow(
    index: number,
    anchor: Date,
    timeZone: string,
    weekStartDay: number
): FortnightWindow {
    // Land inside the target fortnight by millisecond arithmetic, then snap to
    // canonical week boundaries so DST cannot drift the result.
    const approximate = new Date(anchor.getTime() + index * FORTNIGHT_MS + HOUR_MS * 12);
    const week1Start = weekStartFor(approximate, timeZone, weekStartDay);
    const week2Start = nextWeekStart(week1Start, timeZone, weekStartDay);
    const end = nextWeekStart(week2Start, timeZone, weekStartDay);
    return { index, week1Start, week2Start, end };
}

/** "2026-09-28" for the UTC day containing the instant. Keys activityDays. */
export function utcDayKey(instant: Date): string {
    return instant.toISOString().slice(0, 10);
}

/** Inverse of utcDayKey: midnight UTC starting that day. */
export function dayKeyToDate(key: string): Date {
    return new Date(`${key}T00:00:00.000Z`);
}

/** Every UTC day key touched by [from, to). */
export function utcDayKeysBetween(from: Date, to: Date): string[] {
    const keys: string[] = [];
    let cursor = Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate()
    );
    const limit = to.getTime();
    while (cursor < limit) {
        keys.push(new Date(cursor).toISOString().slice(0, 10));
        cursor += DAY_MS;
    }
    return keys;
}
