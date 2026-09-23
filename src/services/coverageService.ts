import type { StaffBotConfig } from "../config/guildConfig.js";
import { allShiftsOverlapping, availableIntervals } from "../domain/shifts.js";
import { demandByHour, firstDemandHour } from "../domain/demand.js";
import { uptimeByHour, uptimeMeasuredSince } from "../domain/uptime.js";
import {
    GRID_DAYS,
    GRID_HOURS,
    gridCellFor,
    observe,
    spreadByHour
} from "../domain/observation.js";
import { HOUR_MS, WEEK_MS, wallClockIn } from "../time/calendar.js";
import { supportedTimezones } from "../time/timezones.js";

export { GRID_DAYS, GRID_HOURS };

/**
 * Coverage and demand, re-bucketed into any timezone.
 *
 * The raw store is UTC shift records and UTC hour buckets, so re-bucketing is a
 * display transform with no loss: an hour of availability is the same hour of
 * availability whichever grid you drop it into.
 *
 * The window runs from whenever counting began, or the lookback, whichever is
 * later, up to the start of the current hour. So a deployment shows something a
 * couple of hours in and sharpens from there, and every average is over the
 * hours actually heard (`domain/observation.ts`), never over weeks it has not
 * had yet.
 */

export interface CoverageGrid {
    /** [weekday][hour], weekday 0 = the configured week start day. */
    coverage: number[][];
    demand: number[][];
    ratio: number[][];
    /** How many times each cell was heard. Zero is "not yet", not "quiet". */
    observed: number[][];
    timeZone: string;
    /** Which weekday row 0 represents, so the renderer can label the axis. */
    weekStartDay: number;
    observedHours: number;
    from: Date;
    to: Date;
    maxRatio: number;
    maxDemand: number;
}

export interface GapCell {
    weekday: number;
    hour: number;
    coverage: number;
    demand: number;
    ratio: number;
}

async function buildGrid(
    config: StaffBotConfig,
    timeZone: string,
    lookbackWeeks: number,
    channelIds: readonly string[],
    withCoverage: boolean,
    now: Date
): Promise<CoverageGrid> {
    // The hour in progress is left out: half an hour of counting reads as a
    // quiet hour.
    const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    const lookbackFrom = to.getTime() - lookbackWeeks * WEEK_MS;
    const first = await firstDemandHour(channelIds);
    const from = new Date(first === null ? to.getTime() : Math.max(lookbackFrom, first.getTime()));

    const coverageByHour = new Map<number, number>();
    if (withCoverage && from < to) {
        for (const shift of await allShiftsOverlapping(from, to)) {
            for (const interval of availableIntervals(shift, now)) {
                const clampedFrom = new Date(Math.max(interval.from.getTime(), from.getTime()));
                const clampedTo = new Date(Math.min(interval.to.getTime(), to.getTime()));
                if (clampedTo > clampedFrom) spreadByHour(coverageByHour, clampedFrom, clampedTo);
            }
        }
    }

    const [messagesByHour, uptime, measuredSince] = await Promise.all([
        demandByHour(from, to, channelIds),
        uptimeByHour(from, to),
        uptimeMeasuredSince()
    ]);

    const observation = observe({
        from,
        to,
        timeZone,
        weekStartDay: config.weekStartDay,
        messagesByHour,
        coverageByHour,
        uptime,
        measuredSince
    });
    const { coverage, demand, observed } = observation;

    // Demand divided by coverage, not either alone. A quiet hour with one
    // moderator is fine. A peak hour with one moderator is the gap.
    let maxRatio = 0;
    let maxDemand = 0;
    const ratio = demand.map((row, weekday) =>
        row.map((messages, hour) => {
            if (messages > maxDemand) maxDemand = messages;
            const staff = coverage[weekday][hour];
            if (messages === 0) return 0;
            const value = staff <= 0 ? messages : messages / staff;
            if (value > maxRatio) maxRatio = value;
            return value;
        })
    );

    return {
        coverage,
        demand,
        ratio,
        observed,
        timeZone,
        weekStartDay: config.weekStartDay,
        observedHours: observation.observedHours,
        from,
        to,
        maxRatio,
        maxDemand
    };
}

/** Demand against moderators available, over every tracked channel. */
export function buildCoverageGrid(
    config: StaffBotConfig,
    timeZone: string,
    lookbackWeeks: number,
    now = new Date()
): Promise<CoverageGrid> {
    return buildGrid(config, timeZone, lookbackWeeks, config.trackedChannels, true, now);
}

/** Messages alone, over every tracked channel or just the ones named. */
export function buildActivityGrid(
    config: StaffBotConfig,
    timeZone: string,
    lookbackWeeks: number,
    channelIds: readonly string[] = config.trackedChannels,
    now = new Date()
): Promise<CoverageGrid> {
    return buildGrid(config, timeZone, lookbackWeeks, channelIds, false, now);
}

function cellsOf(grid: CoverageGrid): GapCell[] {
    const cells: GapCell[] = [];
    for (let weekday = 0; weekday < GRID_DAYS; weekday += 1) {
        for (let hour = 0; hour < GRID_HOURS; hour += 1) {
            if (grid.demand[weekday][hour] === 0) continue;
            cells.push({
                weekday,
                hour,
                coverage: grid.coverage[weekday][hour],
                demand: grid.demand[weekday][hour],
                ratio: grid.ratio[weekday][hour]
            });
        }
    }
    return cells;
}

export function worstCells(grid: CoverageGrid, count = 5): GapCell[] {
    return cellsOf(grid)
        .sort((left, right) => right.ratio - left.ratio)
        .slice(0, count);
}

export function busiestCells(grid: CoverageGrid, count = 5): GapCell[] {
    return cellsOf(grid)
        .sort((left, right) => right.demand - left.demand)
        .slice(0, count);
}

/**
 * Turn a coverage gap into a recruitment brief: which timezones are having
 * their evening, 18:00 to 23:00 local, during this gap. Someone recruited there
 * covers the hole without being asked to work through their own night.
 */
export function zonesInEveningDuring(
    gridFrom: Date,
    weekday: number,
    hour: number,
    displayZone: string,
    weekStartDay: number,
    limit = 8
): string[] {
    // Reconstruct a representative UTC instant for this cell.
    const probe = representativeInstant(gridFrom, weekday, hour, displayZone, weekStartDay);
    if (!probe) return [];

    const matches: string[] = [];
    for (const zone of supportedTimezones()) {
        const localHour = wallClockIn(probe, zone).hour;
        if (localHour >= 18 && localHour <= 23) matches.push(zone);
    }

    // One per UTC offset is enough for a brief; a list of 90 aliases is not.
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const zone of matches) {
        const region = zone.split("/")[0];
        const key = `${region}:${wallClockIn(probe, zone).hour}`;
        if (seen.has(key)) continue;
        seen.add(key);
        distinct.push(zone);
        if (distinct.length >= limit) break;
    }
    return distinct;
}

function representativeInstant(
    gridFrom: Date,
    weekday: number,
    hour: number,
    displayZone: string,
    weekStartDay: number
): Date | null {
    // Scan the last week of the window for the instant landing in this cell.
    const start = gridFrom.getTime();
    for (let offset = 0; offset < 8 * 24; offset += 1) {
        const candidate = new Date(start + offset * HOUR_MS);
        const cell = gridCellFor(candidate, displayZone, weekStartDay);
        if (cell.weekday === weekday && cell.hour === hour) return candidate;
    }
    return null;
}

export function weekdayLabels(weekStartDay: number): string[] {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return Array.from({ length: 7 }, (_, index) => names[(weekStartDay + index) % 7]);
}
