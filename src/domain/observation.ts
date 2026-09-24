import { HOUR_MS, WEEK_MS, dayKeyToDate, wallClockIn } from "../time/calendar.js";
import { hourHistogram } from "./bitmap.js";
import type { LeaveSpan } from "./leaveDays.js";

/**
 * Which hours the bot actually saw, and what each one is worth.
 *
 * A demand bucket only exists for an hour somebody spoke in, so a missing
 * bucket used to mean two opposite things: a quiet hour, or an hour the bot was
 * not connected to hear anything. `uptimeHours` separates them. An hour the bot
 * listened to for most of is a real reading, zero included; an hour it mostly
 * missed is no reading at all, and is left out of every average rather than
 * dragging it down.
 *
 * Every average here is divided by how many times that cell was observed, never
 * by the number of weeks asked for. Dividing by the lookback read eight weeks
 * into a deployment that had two, so every figure came out at a quarter of its
 * real size until the window filled.
 *
 * Pure: the service loads the rows and this folds them.
 */

export const GRID_DAYS = 7;
export const GRID_HOURS = 24;

/**
 * Below this many minutes online an hour is no data at all. Above it the count
 * is scaled up to the full hour: a five minute deploy should cost a twelfth of
 * a reading, not the whole hour.
 */
export const MIN_ONLINE_MINUTES = 30;

export function emptyGrid(): number[][] {
    return Array.from({ length: GRID_DAYS }, () => new Array<number>(GRID_HOURS).fill(0));
}

/** Which grid cell an instant lands in, for a given display zone. */
export function gridCellFor(
    instant: Date,
    timeZone: string,
    weekStartDay: number
): { weekday: number; hour: number } {
    const wall = wallClockIn(instant, timeZone);
    return {
        weekday: (wall.weekday - weekStartDay + 7) % 7,
        hour: wall.hour
    };
}

/**
 * The share of an hour the bot was listening to, or null when it counts as no
 * data.
 *
 * Hours before uptime was first measured are assumed heard, which is what every
 * hour was assumed before this existed: it keeps the counts already collected
 * usable without inventing a history for them.
 */
export function hourWeight(
    hourStart: number,
    uptime: ReadonlyMap<number, number>,
    measuredSince: number | null
): number | null {
    if (measuredSince === null || hourStart < measuredSince) return 1;
    const minutes = uptime.get(hourStart) ?? 0;
    if (minutes < MIN_ONLINE_MINUTES) return null;
    return Math.min(60, minutes) / 60;
}

export interface ObservationInput {
    /** Hour aligned, inclusive. */
    from: Date;
    /** Hour aligned, exclusive. The hour in progress is never included. */
    to: Date;
    timeZone: string;
    weekStartDay: number;
    /** Messages per UTC hour start. */
    messagesByHour: ReadonlyMap<number, number>;
    /** Milliseconds of moderator availability per UTC hour start. */
    coverageByHour: ReadonlyMap<number, number>;
    /** Distinct minutes online per UTC hour start. */
    uptime: ReadonlyMap<number, number>;
    measuredSince: number | null;
    /**
     * UTC hour starts that are no reading at all, whatever the bot heard: a
     * member's hours on leave. Left out of every average, the same way an hour
     * the bot missed is, rather than read as a quiet hour.
     */
    excludedHours?: ReadonlySet<number>;
}

export interface Observation {
    /** [weekday][hour]: how many times the cell was heard. */
    observed: number[][];
    /** Mean messages per hour, over the times the cell was heard. */
    demand: number[][];
    /** Mean moderators available, over the times the cell was heard. */
    coverage: number[][];
    /** Every hour heard, across the whole grid. */
    observedHours: number;
}

/**
 * Walk the window an hour at a time. Walking rather than assuming each weekday
 * came round a fixed number of times is what keeps this right across a DST
 * change in the display zone, and for a window that is five hours long.
 *
 * Coverage is not scaled by the hour's weight: shift intervals are a continuous
 * record rather than something the bot sampled, so a partial hour's coverage is
 * already complete. It is dropped with the hour when the hour is no data, so
 * the two sides of the ratio always cover the same hours.
 */
export function observe(input: ObservationInput): Observation {
    const observed = emptyGrid();
    const demandSum = emptyGrid();
    const coverageSum = emptyGrid();
    let observedHours = 0;

    for (let hour = input.from.getTime(); hour < input.to.getTime(); hour += HOUR_MS) {
        if (input.excludedHours?.has(hour)) continue;
        const weight = hourWeight(hour, input.uptime, input.measuredSince);
        if (weight === null) continue;

        const cell = gridCellFor(new Date(hour), input.timeZone, input.weekStartDay);
        observed[cell.weekday][cell.hour] += 1;
        demandSum[cell.weekday][cell.hour] += (input.messagesByHour.get(hour) ?? 0) / weight;
        coverageSum[cell.weekday][cell.hour] += input.coverageByHour.get(hour) ?? 0;
        observedHours += 1;
    }

    const mean = (sums: number[][], scale = 1) =>
        sums.map((row, weekday) =>
            row.map((sum, hour) => {
                const times = observed[weekday][hour];
                return times === 0 ? 0 : sum / scale / times;
            })
        );

    return {
        observed,
        demand: mean(demandSum),
        coverage: mean(coverageSum, HOUR_MS),
        observedHours
    };
}

/** Split an interval's milliseconds across the UTC hours it touches. */
export function spreadByHour(into: Map<number, number>, from: Date, to: Date): void {
    let cursor = from.getTime();
    const end = to.getTime();
    while (cursor < end) {
        const hourStart = Math.floor(cursor / HOUR_MS) * HOUR_MS;
        const sliceEnd = Math.min(hourStart + HOUR_MS, end);
        into.set(hourStart, (into.get(hourStart) ?? 0) + (sliceEnd - cursor));
        cursor = sliceEnd;
    }
}

/**
 * Activity minutes per UTC hour start, from a member's day bitmaps keyed by
 * UTC day. An hour with no minutes is absent, as a demand bucket is.
 */
export function minutesByUtcHour(days: ReadonlyMap<string, Buffer>): Map<number, number> {
    const totals = new Map<number, number>();
    for (const [date, bitmap] of days) {
        const dayStart = dayKeyToDate(date).getTime();
        hourHistogram(bitmap).forEach((minutes, hour) => {
            if (minutes > 0) totals.set(dayStart + hour * HOUR_MS, minutes);
        });
    }
    return totals;
}

/**
 * Where a member's grid begins: the lookback, or the first whole hour after
 * they joined, whichever is later. Rounded up, not down: the hour somebody
 * joined partway through is not an hour they could fill, and counting it read
 * as a quiet sample, which in a first week is the only sample that cell has.
 * The same rule as leave, whose part hours are dropped rather than weighed.
 */
export function memberWindowStart(to: Date, lookbackWeeks: number, joinedTeamAt: Date): Date {
    const lookbackFrom = to.getTime() - lookbackWeeks * WEEK_MS;
    const joined = Math.ceil(joinedTeamAt.getTime() / HOUR_MS) * HOUR_MS;
    return new Date(Math.min(to.getTime(), Math.max(lookbackFrom, joined)));
}

/**
 * Every UTC hour start in [from, to) that any span touches, however briefly.
 * An hour half on leave is no fairer a reading than one wholly on it, and the
 * cost is at most an hour either end of a leave.
 */
export function hoursTouchedBy(spans: readonly LeaveSpan[], from: Date, to: Date): Set<number> {
    const hours = new Set<number>();
    for (const span of spans) {
        const start = Math.max(from.getTime(), span.startDate.getTime());
        const end = Math.min(to.getTime(), span.endDate.getTime());
        for (let hour = Math.floor(start / HOUR_MS) * HOUR_MS; hour < end; hour += HOUR_MS) {
            hours.add(hour);
        }
    }
    return hours;
}

export interface DailyProfile {
    /** Mean messages for each hour of the day, all weekdays pooled. Null if never heard. */
    mean: (number | null)[];
    /** How many readings each hour of the day rests on. */
    samples: number[];
}

/**
 * The day's shape with every weekday pooled. The weekly grid needs a week before
 * every cell has a reading; this has a full day after one day.
 */
export function dailyProfile(observation: Observation): DailyProfile {
    const mean: (number | null)[] = [];
    const samples: number[] = [];
    for (let hour = 0; hour < GRID_HOURS; hour += 1) {
        let total = 0;
        let times = 0;
        for (let weekday = 0; weekday < GRID_DAYS; weekday += 1) {
            const seen = observation.observed[weekday][hour];
            total += observation.demand[weekday][hour] * seen;
            times += seen;
        }
        mean.push(times === 0 ? null : total / times);
        samples.push(times);
    }
    return { mean, samples };
}

export interface HourRun {
    /** First hour of the run. */
    start: number;
    /** Hours in the run, at least one. */
    length: number;
    /** Mean messages per hour across the run. */
    mean: number;
}

/**
 * The busiest stretch of the day: the peak hour, widened to its neighbours
 * while they stay within 85% of it. Wraps past midnight, because an evening
 * peak that runs 22:00 to 01:00 is one peak and not two.
 */
export function busiestRun(profile: DailyProfile, share = 0.85): HourRun | null {
    let peak = -1;
    for (let hour = 0; hour < GRID_HOURS; hour += 1) {
        const value = profile.mean[hour];
        if (value === null || value <= 0) continue;
        if (peak < 0 || value > (profile.mean[peak] ?? 0)) peak = hour;
    }
    if (peak < 0) return null;

    const floor = (profile.mean[peak] ?? 0) * share;
    const qualifies = (hour: number) => {
        const value = profile.mean[(hour + GRID_HOURS) % GRID_HOURS];
        return value !== null && value >= floor;
    };

    let start = peak;
    let length = 1;
    while (length < GRID_HOURS && qualifies(start - 1)) {
        start -= 1;
        length += 1;
    }
    while (length < GRID_HOURS && qualifies(start + length)) length += 1;

    start = (start + GRID_HOURS) % GRID_HOURS;
    let total = 0;
    for (let offset = 0; offset < length; offset += 1) {
        total += profile.mean[(start + offset) % GRID_HOURS] ?? 0;
    }
    return { start, length, mean: total / length };
}

/** The quietest hour of the day that has actually been heard. */
export function quietestHour(profile: DailyProfile): { hour: number; mean: number } | null {
    let best: { hour: number; mean: number } | null = null;
    for (let hour = 0; hour < GRID_HOURS; hour += 1) {
        const value = profile.mean[hour];
        if (value === null) continue;
        if (best === null || value < best.mean) best = { hour, mean: value };
    }
    return best;
}

/**
 * Minutes the bot was listening across a window, against the minutes it could
 * have been. Minutes before uptime was first measured are not counted against
 * it, because nothing was measuring them.
 */
export function listeningOver(
    hours: readonly { hourStart: number; minutes: readonly number[] }[],
    measuredSince: number | null,
    from: Date,
    to: Date
): { online: number; possible: number } {
    const start = Math.max(from.getTime(), measuredSince ?? to.getTime());
    const possible = Math.max(0, Math.floor((to.getTime() - start) / 60_000));
    let online = 0;
    for (const hour of hours) {
        for (const minute of hour.minutes) {
            const at = hour.hourStart + minute * 60_000;
            if (at >= start && at < to.getTime()) online += 1;
        }
    }
    return { online: Math.min(online, possible), possible };
}
