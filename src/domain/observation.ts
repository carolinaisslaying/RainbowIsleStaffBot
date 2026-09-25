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
    /**
     * Also measure each heard hour's load on the moderators on shift, and
     * whether anybody was. The coverage gap only.
     */
    judgeLoad?: boolean;
}

export interface Observation {
    /** [weekday][hour]: how many times the cell was heard. */
    observed: number[][];
    /** Mean messages per hour, over the times the cell was heard. */
    demand: number[][];
    /** Mean moderators available, over the times the cell was heard. */
    coverage: number[][];
    /** Mean messages per moderator on shift (`loadOf`). Zero unless judged. */
    load: number[][];
    /**
     * Mean share of each hour, 0 to 1, that nobody was on shift for
     * (`uncoveredShare`). Zero unless judged.
     */
    uncovered: number[][];
    /**
     * Messages in the median hour anybody spoke in, which is what the load is
     * read against. Zero unless judged, or when nobody spoke at all.
     */
    typicalHour: number;
    /** Every hour heard, across the whole grid. */
    observedHours: number;
}

/**
 * Messages per moderator on shift, never dividing by fewer than one. Dividing
 * by the moderators actually on read ninety seconds of shift as a fortieth of
 * a moderator, so a sliver of cover scored 20.2k, forty times worse than
 * nobody at all. Below one moderator the load is simply every message; what
 * the missing cover means is said by `uncoveredShare`, not by this number.
 */
export function loadOf(messages: number, moderators: number): number {
    return messages / Math.max(1, moderators);
}

/**
 * How much of an hour nobody was on shift for, 0 to 1: the part of the first
 * moderator the hour did not get. Zero for an hour nobody spoke in, which asks
 * nothing of anybody.
 */
export function uncoveredShare(messages: number, moderators: number): number {
    if (messages <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - moderators));
}

/**
 * Past this share of the hour uncovered, the cell is ringed: nobody was on for
 * most of it. The ring is a label, not the rule. The colour already follows the
 * share continuously (`gapBand`), so being a minute either side of this moves
 * the ring and never the colour.
 */
export const RING_ABOVE = 0.5;

/**
 * Where the colour steps begin, as multiples of the typical hour's messages.
 * One moderator through a typical hour is the second step, gold; amber starts
 * at a noticeably heavy load, and burgundy at more than twice a typical hour.
 * A typical hour used to sit in the middle step, so an ordinary staffed hour
 * read as an early warning. Read against the server's own typical hour rather
 * than the grid's busiest cells, where one badly covered hour took the top of
 * the scale alone and pushed every empty evening into the bottom step.
 */
export const LOAD_STEPS = [0.6, 1.1, 1.6, 2.2];

/**
 * How far up the scale a wholly uncovered hour is pushed, in steps. Nobody on
 * shift in the quietest hour lands on the fourth of five steps, so an empty
 * hour is never drawn as fine, and a busier empty hour climbs to the top with
 * its load. Part cover lifts in proportion: half an hour with nobody is half
 * the lift. It used to be all or nothing at half an hour, so a minute of cover
 * either side of that moved a cell from plain blue to red.
 */
export const UNCOVERED_LIFT = 3;

/**
 * The colour step for a cell, 0 to 4, or -1 when nobody spoke. Pure, so the
 * chart and the list of worst hours read the same answer.
 */
export function gapBand(load: number, uncovered: number, typicalHour: number): number {
    if (load <= 0) return -1;
    const ratio = typicalHour > 0 ? load / typicalHour : 1;
    const band = LOAD_STEPS.filter((edge) => ratio >= edge).length;
    return Math.min(LOAD_STEPS.length, band + Math.round(UNCOVERED_LIFT * uncovered));
}

/**
 * The median of the hours anybody spoke in. Silent hours are left out: on a
 * channel that is mostly quiet they would make the median zero, and an hour
 * with nobody in it says nothing about what a busy one asks of a moderator.
 */
export function typicalHourOf(messages: readonly number[]): number {
    const spoken = messages.filter((count) => count > 0).sort((a, b) => a - b);
    if (spoken.length === 0) return 0;
    const middle = Math.floor(spoken.length / 2);
    return spoken.length % 2 === 1 ? spoken[middle] : (spoken[middle - 1] + spoken[middle]) / 2;
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
    const loadSum = emptyGrid();
    const uncoveredSum = emptyGrid();
    const heard: { weekday: number; hour: number; messages: number; coverageMs: number }[] = [];
    let observedHours = 0;

    for (let hour = input.from.getTime(); hour < input.to.getTime(); hour += HOUR_MS) {
        if (input.excludedHours?.has(hour)) continue;
        const weight = hourWeight(hour, input.uptime, input.measuredSince);
        if (weight === null) continue;

        const cell = gridCellFor(new Date(hour), input.timeZone, input.weekStartDay);
        const messages = (input.messagesByHour.get(hour) ?? 0) / weight;
        const coverageMs = input.coverageByHour.get(hour) ?? 0;
        observed[cell.weekday][cell.hour] += 1;
        demandSum[cell.weekday][cell.hour] += messages;
        coverageSum[cell.weekday][cell.hour] += coverageMs;
        heard.push({ ...cell, messages, coverageMs });
        observedHours += 1;
    }

    // Judged hour by hour and then averaged, never from the averages: two
    // moderators one week and none the next averages to one on shift, which
    // would read as covered an hour that was empty half the time. Averaged
    // this way, a cell empty three weeks in eight carries three eighths of
    // the lift rather than none.
    const typicalHour = input.judgeLoad
        ? typicalHourOf(heard.map((reading) => reading.messages))
        : 0;
    if (input.judgeLoad) {
        for (const reading of heard) {
            const moderators = reading.coverageMs / HOUR_MS;
            loadSum[reading.weekday][reading.hour] += loadOf(reading.messages, moderators);
            uncoveredSum[reading.weekday][reading.hour] += uncoveredShare(
                reading.messages,
                moderators
            );
        }
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
        load: mean(loadSum),
        uncovered: mean(uncoveredSum),
        typicalHour,
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
export function dailyProfile(observation: Pick<Observation, "observed" | "demand">): DailyProfile {
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
