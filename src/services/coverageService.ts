import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { allShiftsOverlapping, availableIntervals } from "../domain/shifts.js";
import { dayBitmapsBetween } from "../domain/activity.js";
import { leaveOverlapping } from "../domain/leave.js";
import { demandByHour, firstDemandHour } from "../domain/demand.js";
import { uptimeByHour, uptimeMeasuredSince } from "../domain/uptime.js";
import {
    GRID_DAYS,
    GRID_HOURS,
    gridCellFor,
    hoursTouchedBy,
    memberWindowStart,
    minutesByUtcHour,
    gapBand,
    observe,
    RING_ABOVE,
    spreadByHour
} from "../domain/observation.js";
import { HOUR_MS, WEEK_MS } from "../time/calendar.js";
import { regionsInEvening, type EveningRegion } from "../time/regions.js";

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
    /** Mean messages per moderator on shift. Zero off the coverage grid. */
    load: number[][];
    /** Mean share of each hour, 0 to 1, with nobody on shift. */
    uncovered: number[][];
    /** Whether nobody was on for most of the hour, which the chart rings. */
    unstaffed: boolean[][];
    /** The colour step, 0 to 4, or -1 for nothing to draw (`gapBand`). */
    severity: number[][];
    /** Messages in the median hour, which the load is read against. */
    typicalHour: number;
    /** How many times each cell was heard. Zero is "not yet", not "quiet". */
    observed: number[][];
    timeZone: string;
    /** Which weekday row 0 represents, so the renderer can label the axis. */
    weekStartDay: number;
    observedHours: number;
    from: Date;
    to: Date;
    maxDemand: number;
}

export interface GapCell {
    weekday: number;
    hour: number;
    coverage: number;
    demand: number;
    load: number;
    uncovered: number;
    unstaffed: boolean;
    severity: number;
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
        measuredSince,
        judgeLoad: withCoverage
    });
    const { coverage, demand, load, observed, typicalHour } = observation;

    // Messages per moderator on shift, which is what this chart always meant,
    // with the two ways it went wrong taken out: it never divides by less than
    // one moderator (`loadOf`), and an hour with nobody on is a state of its
    // own that lifts the colour rather than a number that pretends somebody
    // was there. The rules are in `domain/observation.ts`.
    const { uncovered } = observation;
    const unstaffed = uncovered.map((row) => row.map((share) => share > RING_ABOVE));
    const severity = load.map((row, weekday) =>
        row.map((value, hour) => gapBand(value, uncovered[weekday][hour], typicalHour))
    );
    const maxDemand = Math.max(0, ...demand.flat());

    return {
        coverage,
        demand,
        load,
        uncovered,
        unstaffed,
        severity,
        typicalHour,
        observed,
        timeZone,
        weekStartDay: config.weekStartDay,
        observedHours: observation.observedHours,
        from,
        to,
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

export interface MemberActivityGrid extends CoverageGrid {
    /** Hours in the window left out because the member was on leave. */
    leaveHours: number;
}

/**
 * One member's activity minutes, averaged per hour of the week. The grid's
 * `demand` holds minutes rather than messages, so everything that reads a grid
 * (the renderer, `busiestCells`) works unchanged.
 *
 * The window starts at the lookback or the first whole hour after they joined
 * the team, whichever is later: weeks before somebody was staff are not weeks
 * they were quiet. Hours
 * on leave are no reading at all, like an hour the bot missed.
 */
export async function buildMemberActivityGrid(
    config: StaffBotConfig,
    member: Pick<StaffDoc, "_id" | "joinedTeamAt">,
    timeZone: string,
    lookbackWeeks: number,
    now = new Date()
): Promise<MemberActivityGrid> {
    const to = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    const from = memberWindowStart(to, lookbackWeeks, member.joinedTeamAt);

    const [days, leave, uptime, measuredSince] = await Promise.all([
        dayBitmapsBetween(member._id, from, to),
        leaveOverlapping(member._id, from, to),
        uptimeByHour(from, to),
        uptimeMeasuredSince()
    ]);
    const excludedHours = hoursTouchedBy(leave, from, to);

    const observation = observe({
        from,
        to,
        timeZone,
        weekStartDay: config.weekStartDay,
        messagesByHour: minutesByUtcHour(days),
        coverageByHour: new Map(),
        uptime,
        measuredSince,
        excludedHours
    });

    // Scaling a partly heard hour up to a full one can carry a busy hour past
    // sixty minutes, which an hour does not have.
    let maxDemand = 0;
    const demand = observation.demand.map((row) =>
        row.map((minutes) => {
            const capped = Math.min(60, minutes);
            if (capped > maxDemand) maxDemand = capped;
            return capped;
        })
    );

    return {
        coverage: observation.coverage,
        demand,
        load: observation.load,
        uncovered: observation.uncovered.map((row) => row.map(() => 0)),
        unstaffed: observation.uncovered.map((row) => row.map(() => false)),
        severity: observation.load.map((row) => row.map(() => -1)),
        typicalHour: 0,
        observed: observation.observed,
        timeZone,
        weekStartDay: config.weekStartDay,
        observedHours: observation.observedHours,
        from,
        to,
        maxDemand,
        leaveHours: excludedHours.size
    };
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
                load: grid.load[weekday][hour],
                uncovered: grid.uncovered[weekday][hour],
                unstaffed: grid.unstaffed[weekday][hour],
                severity: grid.severity[weekday][hour]
            });
        }
    }
    return cells;
}

/**
 * The hours furthest up the chart's own scale, busiest first within a step, so
 * the list and the colours cannot disagree about what is worst.
 */
export function worstCells(grid: CoverageGrid, count = 5): GapCell[] {
    return cellsOf(grid)
        .sort((left, right) => right.severity - left.severity || right.load - left.load)
        .slice(0, count);
}

export function busiestCells(grid: CoverageGrid, count = 5): GapCell[] {
    return cellsOf(grid)
        .sort((left, right) => right.demand - left.demand)
        .slice(0, count);
}

/**
 * Turn a coverage gap into a recruitment brief: which regions are having their
 * evening, 18:00 to 23:00 local, during this gap. The list and its ordering
 * live in `time/regions.ts`.
 */
export function regionsInEveningDuring(
    gridFrom: Date,
    weekday: number,
    hour: number,
    displayZone: string,
    weekStartDay: number
): EveningRegion[] {
    // Reconstruct a representative UTC instant for this cell.
    const probe = representativeInstant(gridFrom, weekday, hour, displayZone, weekStartDay);
    return probe ? regionsInEvening(probe) : [];
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
