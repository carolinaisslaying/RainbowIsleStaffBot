import type { RingState } from "../db/types.js";

/**
 * The team's week, as a summary rather than as a roster.
 *
 * The personal recap already tells each member their own figures; posting the
 * same thing again in a channel would only be a leaderboard with extra steps,
 * and there is already a leaderboard. What a channel can say that a DM cannot
 * is how the week went for everyone at once, which is the thing nobody can see
 * from inside their own card.
 *
 * Members on leave for the whole week are counted separately and left out of
 * every average. Including them drags the team's figures down for a week nobody
 * was expected to work, which makes a good week look like a bad one.
 */

export interface TeamWeekRow {
    activityMinutes: number;
    shiftMs: number;
    activeDays: number;
    ringState: RingState;
    onLeave: boolean;
}

export interface TeamWeek {
    /** Members who were expected to work: everyone not on leave all week. */
    counted: number;
    /** Of those, how many closed their activity ring. */
    closed: number;
    onLeave: number;
    totalMinutes: number;
    medianMinutes: number;
    meanMinutes: number;
    /** Team totals for the two soft rings, summed the same way. */
    totalShiftMs: number;
    totalActiveDays: number;
    /** Against the previous week's total. Null when there is no previous week. */
    deltaPercent: number | null;
}

export function summariseTeamWeek(
    rows: TeamWeekRow[],
    priorTotalMinutes: number | null
): TeamWeek {
    const counted = rows.filter((row) => !row.onLeave);
    const minutes = counted.map((row) => row.activityMinutes).sort((a, b) => a - b);
    const totalMinutes = minutes.reduce((sum, value) => sum + value, 0);

    return {
        counted: counted.length,
        closed: counted.filter((row) => row.ringState === "green").length,
        onLeave: rows.length - counted.length,
        totalMinutes,
        totalShiftMs: counted.reduce((sum, row) => sum + row.shiftMs, 0),
        totalActiveDays: counted.reduce((sum, row) => sum + row.activeDays, 0),
        medianMinutes: median(minutes),
        meanMinutes: counted.length === 0 ? 0 : Math.round(totalMinutes / counted.length),
        // A previous week of zero has no percentage to be a change from, so it
        // reports as "no comparison" rather than as an infinite rise.
        deltaPercent:
            priorTotalMinutes === null || priorTotalMinutes === 0
                ? null
                : Math.round(((totalMinutes - priorTotalMinutes) / priorTotalMinutes) * 100)
    };
}

function median(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The headline sentence. Written for a week where nothing happened as carefully
 * as for one where something did, because most weeks are the former and a
 * summary that only reads well in the good case is a summary nobody trusts.
 */
export function teamRecapHeadline(week: TeamWeek): string {
    if (week.counted === 0) {
        return week.onLeave > 0
            ? `Everybody was on leave this week. Nothing was expected of anyone.`
            : "Nobody was on the roster this week.";
    }

    const closed =
        `**${week.closed} of ${week.counted}** closed their activity ring` +
        (week.onLeave > 0
            ? `, and ${week.onLeave} ${week.onLeave === 1 ? "was" : "were"} on leave.`
            : ".");

    const movement =
        week.deltaPercent === null
            ? "No previous week to compare against."
            : week.deltaPercent === 0
              ? "Level with last week."
              : `${Math.abs(week.deltaPercent)}% ${week.deltaPercent > 0 ? "up on" : "down on"} ` +
                "last week.";

    return `${closed} ${movement}`;
}
