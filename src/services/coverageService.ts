import type { StaffBotConfig } from "../config/guildConfig.js";
import { allShiftsOverlapping, availableIntervals } from "../domain/shifts.js";
import { demandBetween } from "../domain/demand.js";
import {
    DAY_MS,
    HOUR_MS,
    nextWeekStart,
    wallClockIn,
    weekStartFor
} from "../time/calendar.js";
import { supportedTimezones } from "../time/timezones.js";

/**
 * Coverage and demand, re-bucketed into any timezone.
 *
 * The raw store is UTC shift records and UTC hour buckets, so re-bucketing is a
 * display transform with no loss: an hour of availability is the same hour of
 * availability whichever grid you drop it into.
 */

export const GRID_DAYS = 7;
export const GRID_HOURS = 24;

export interface CoverageGrid {
    /** [weekday][hour], weekday 0 = the configured week start day. */
    coverage: number[][];
    demand: number[][];
    ratio: number[][];
    timeZone: string;
    /** Which weekday row 0 represents, so the renderer can label the axis. */
    weekStartDay: number;
    weeks: number;
    from: Date;
    to: Date;
    maxRatio: number;
}

export interface GapCell {
    weekday: number;
    hour: number;
    coverage: number;
    demand: number;
    ratio: number;
}

function emptyGrid(): number[][] {
    return Array.from({ length: GRID_DAYS }, () => new Array<number>(GRID_HOURS).fill(0));
}

/** Which grid cell an instant lands in, for a given display zone. */
function cellFor(
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
 * Spread an interval's milliseconds across the hour cells it touches. Walking
 * hour by hour rather than assuming 24 equal hours per day is what keeps this
 * correct across a DST transition in the display zone.
 */
function addInterval(
    grid: number[][],
    from: Date,
    to: Date,
    timeZone: string,
    weekStartDay: number
): void {
    let cursor = from.getTime();
    const end = to.getTime();

    while (cursor < end) {
        const nextHour = Math.floor(cursor / HOUR_MS) * HOUR_MS + HOUR_MS;
        const sliceEnd = Math.min(nextHour, end);
        const cell = cellFor(new Date(cursor), timeZone, weekStartDay);
        grid[cell.weekday][cell.hour] += sliceEnd - cursor;
        cursor = sliceEnd;
    }
}

export async function buildCoverageGrid(
    config: StaffBotConfig,
    timeZone: string,
    lookbackWeeks: number,
    now = new Date()
): Promise<CoverageGrid> {
    // Whole completed weeks only, so the grid is not skewed by a part week.
    const to = weekStartFor(now, config.accountingTimezone, config.weekStartDay);
    let from = to;
    for (let step = 0; step < lookbackWeeks; step += 1) {
        from = weekStartFor(
            new Date(from.getTime() - DAY_MS),
            config.accountingTimezone,
            config.weekStartDay
        );
    }
    const weeks = Math.max(1, Math.round((to.getTime() - from.getTime()) / (7 * DAY_MS)));

    const coverageMs = emptyGrid();
    const demandCounts = emptyGrid();

    const shifts = await allShiftsOverlapping(from, to);
    for (const shift of shifts) {
        for (const interval of availableIntervals(shift, now)) {
            const clampedFrom = new Date(Math.max(interval.from.getTime(), from.getTime()));
            const clampedTo = new Date(Math.min(interval.to.getTime(), to.getTime()));
            if (clampedTo > clampedFrom) {
                addInterval(coverageMs, clampedFrom, clampedTo, timeZone, config.weekStartDay);
            }
        }
    }

    for (const bucket of await demandBetween(from, to)) {
        const cell = cellFor(bucket.hourStart, timeZone, config.weekStartDay);
        demandCounts[cell.weekday][cell.hour] += bucket.messages;
    }

    // Mean staff Available during the hour, and mean messages in the hour.
    const coverage = coverageMs.map((row) => row.map((ms) => ms / HOUR_MS / weeks));
    const demand = demandCounts.map((row) => row.map((count) => count / weeks));

    // Demand divided by coverage, not either alone. A quiet hour with one
    // moderator is fine. A peak hour with one moderator is the gap.
    let maxRatio = 0;
    const ratio = demand.map((row, weekday) =>
        row.map((messages, hour) => {
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
        timeZone,
        weekStartDay: config.weekStartDay,
        weeks,
        from,
        to,
        maxRatio
    };
}

export function worstCells(grid: CoverageGrid, count = 5): GapCell[] {
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
    return cells.sort((left, right) => right.ratio - left.ratio).slice(0, count);
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
        const cell = cellFor(candidate, displayZone, weekStartDay);
        if (cell.weekday === weekday && cell.hour === hour) return candidate;
    }
    return null;
}

export function weekdayLabels(weekStartDay: number): string[] {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return Array.from({ length: 7 }, (_, index) => names[(weekStartDay + index) % 7]);
}
