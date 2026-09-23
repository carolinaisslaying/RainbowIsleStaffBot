import type { AssessmentStatus } from "../db/types.js";
import {
    DAY_MS,
    fortnightIndexFor,
    fortnightWindow,
    weekStartFor,
    type FortnightWindow
} from "../time/calendar.js";

/**
 * How leave turns into a requirement, as pure functions.
 *
 * Leave is measured per accounting week, on its own. The hours of leave inside
 * a week, divided by 24 and rounded to the nearest whole number, are that
 * week's leave days. A week holding at least `minimumLeaveDays` of them is
 * exempt: the rings go grey and the week drops out of its fortnight.
 *
 * The fortnight then asks for one weekly target per week that still counts:
 * two when neither is exempt, pooled so a slow week can be made up in the next;
 * one when a single week is exempt, against minutes from both weeks; and
 * nothing when both are.
 *
 * The same number is the shortest leave anybody may book, so a leave that
 * meets the minimum can always exempt a week if it sits inside one. Split
 * across two weeks it may exempt neither, and the confirmation card says so
 * before the member commits to it.
 */

export interface LeaveSpan {
    startDate: Date;
    endDate: Date;
}

/** Milliseconds of [from, to) that the spans cover, overlaps counted once. */
export function leaveMsIn(spans: LeaveSpan[], from: Date, to: Date): number {
    const clipped = spans
        .map((span) => ({
            from: Math.max(from.getTime(), span.startDate.getTime()),
            to: Math.min(to.getTime(), span.endDate.getTime())
        }))
        .filter((span) => span.to > span.from)
        .sort((left, right) => left.from - right.from);

    let total = 0;
    let runFrom = -Infinity;
    let runTo = -Infinity;
    for (const span of clipped) {
        if (span.from > runTo) {
            if (runTo > runFrom) total += runTo - runFrom;
            runFrom = span.from;
            runTo = span.to;
        } else {
            runTo = Math.max(runTo, span.to);
        }
    }
    if (runTo > runFrom) total += runTo - runFrom;
    return total;
}

/** Hours of leave in the window, as whole days: 66 hours is 2.75, which is 3. */
export function leaveDaysIn(spans: LeaveSpan[], from: Date, to: Date): number {
    return Math.round(leaveMsIn(spans, from, to) / DAY_MS);
}

/** The length of one leave, in the same whole days the minimum is measured in. */
export function leaveLength(span: LeaveSpan): number {
    return Math.round((span.endDate.getTime() - span.startDate.getTime()) / DAY_MS);
}

export interface WeekLeave {
    days: number;
    exempt: boolean;
}

export function weekLeave(
    spans: LeaveSpan[],
    from: Date,
    to: Date,
    minimumLeaveDays: number
): WeekLeave {
    const days = leaveDaysIn(spans, from, to);
    return { days, exempt: days > 0 && days >= minimumLeaveDays };
}

export type RequirementKind = "full" | "reduced" | "waived";

export interface Requirement {
    kind: RequirementKind;
    requiredMinutes: number;
}

export function fortnightRequirement(
    week1Exempt: boolean,
    week2Exempt: boolean,
    weeklyTargetMinutes: number
): Requirement {
    const counting = (week1Exempt ? 0 : 1) + (week2Exempt ? 0 : 1);
    return {
        kind: counting === 2 ? "full" : counting === 1 ? "reduced" : "waived",
        requiredMinutes: counting * weeklyTargetMinutes
    };
}

/** Minutes from both weeks always count, whichever of them is exempt. */
export function fortnightStatus(totalMinutes: number, requirement: Requirement): AssessmentStatus {
    if (requirement.kind === "waived") return "exempt";
    return totalMinutes >= requirement.requiredMinutes ? "met" : "below";
}

export interface CalendarRules {
    anchor: Date;
    timeZone: string;
    weekStartDay: number;
}

/** Every fortnight a span touches, in order. */
export function fortnightsTouching(span: LeaveSpan, rules: CalendarRules): FortnightWindow[] {
    const first = fortnightIndexFor(
        weekStartFor(span.startDate, rules.timeZone, rules.weekStartDay),
        rules.anchor
    );
    // The end is exclusive, so a leave ending on the stroke of midnight on a
    // Monday does not drag the next fortnight in with it.
    const lastInstant = new Date(Math.max(span.startDate.getTime(), span.endDate.getTime() - 1));
    const last = fortnightIndexFor(
        weekStartFor(lastInstant, rules.timeZone, rules.weekStartDay),
        rules.anchor
    );
    const windows: FortnightWindow[] = [];
    for (let index = first; index <= last; index += 1) {
        windows.push(fortnightWindow(index, rules.anchor, rules.timeZone, rules.weekStartDay));
    }
    return windows;
}

export interface WeekEffect {
    weekStart: Date;
    daysBefore: number;
    daysAfter: number;
    exemptBefore: boolean;
    exemptAfter: boolean;
}

export interface FortnightEffect {
    index: number;
    weeks: [WeekEffect, WeekEffect];
    before: Requirement;
    after: Requirement;
}

export interface LeaveEffect {
    fortnights: FortnightEffect[];
    /** Weeks this change reaches. */
    touchedWeeks: WeekEffect[];
    /** It touches at least one week and exempts none of them. */
    exemptsNothing: boolean;
    /** The touched weeks sit either side of a week boundary. */
    split: boolean;
}

/**
 * What changing a member's leave from `before` to `after` does to the weeks and
 * fortnights `span` touches.
 *
 * A request compares the member's other leave against that leave plus the new
 * one; an extension compares the old end against the new. One function, so the
 * confirmation card and the extension card cannot describe the same rule two
 * different ways.
 */
export function leaveEffect(options: {
    span: LeaveSpan;
    before: LeaveSpan[];
    after: LeaveSpan[];
    rules: CalendarRules;
    minimumLeaveDays: number;
    weeklyTargetMinutes: number;
}): LeaveEffect {
    const fortnights = fortnightsTouching(options.span, options.rules).map((window) => {
        const bounds: [Date, Date][] = [
            [window.week1Start, window.week2Start],
            [window.week2Start, window.end]
        ];
        const weeks = bounds.map(([from, to]) => {
            const before = weekLeave(options.before, from, to, options.minimumLeaveDays);
            const after = weekLeave(options.after, from, to, options.minimumLeaveDays);
            return {
                weekStart: from,
                daysBefore: before.days,
                daysAfter: after.days,
                exemptBefore: before.exempt,
                exemptAfter: after.exempt
            };
        }) as [WeekEffect, WeekEffect];

        return {
            index: window.index,
            weeks,
            before: fortnightRequirement(
                weeks[0].exemptBefore,
                weeks[1].exemptBefore,
                options.weeklyTargetMinutes
            ),
            after: fortnightRequirement(
                weeks[0].exemptAfter,
                weeks[1].exemptAfter,
                options.weeklyTargetMinutes
            )
        };
    });

    const touchedWeeks = fortnights
        .flatMap((fortnight) => fortnight.weeks)
        // The weeks this change reaches: the ones whose leave moved, and any
        // the span crosses even when rounding leaves it at zero days. Weeks
        // holding only the member's other leave are not this change's to report.
        .filter((week) => week.daysBefore !== week.daysAfter || spansWeek(options.span, week));

    return {
        fortnights,
        touchedWeeks,
        exemptsNothing: touchedWeeks.length > 0 && touchedWeeks.every((week) => !week.exemptAfter),
        split: touchedWeeks.length > 1
    };
}

function spansWeek(span: LeaveSpan, week: WeekEffect): boolean {
    const weekEnd = week.weekStart.getTime() + 7 * DAY_MS;
    return span.startDate.getTime() < weekEnd && span.endDate.getTime() > week.weekStart.getTime();
}

/**
 * What a leave does to the member's requirements, in the lines the
 * confirmation card prints. A request states it as settled, because the
 * member is agreeing to it; an extension states it as what would happen,
 * because an Executive has yet to agree.
 *
 * `label` formats a week or fortnight start ("5 Oct"). Passed in, as
 * `priorOutcomesLine` does, so this stays free of timezone formatting.
 */
export function describeLeaveEffect(
    effect: LeaveEffect,
    options: { kind: "request" | "extension"; label: (date: Date) => string }
): string[] {
    const lines: string[] = [];
    const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

    for (const week of effect.touchedWeeks) {
        const when = `Week of ${options.label(week.weekStart)}`;
        if (options.kind === "extension" && week.daysBefore !== week.daysAfter) {
            const becomes =
                week.exemptAfter && !week.exemptBefore
                    ? "becomes exempt"
                    : week.exemptAfter
                      ? "stays exempt"
                      : "still not exempt";
            lines.push(
                `${when}: was ${days(week.daysBefore)}, now ${week.daysAfter}, ${becomes}`
            );
        } else {
            lines.push(`${when}: ${days(week.daysAfter)}, ${week.exemptAfter ? "exempt" : "not exempt"}`);
        }
    }

    if (options.kind === "request" && effect.exemptsNothing) {
        lines.push(
            effect.split
                ? "❗ This leave doesn't exempt either week, because it's split across two."
                : "❗ This leave doesn't exempt its week."
        );
    }

    for (const fortnight of effect.fortnights) {
        const touched = fortnight.weeks.some((week) => effect.touchedWeeks.includes(week));
        if (!touched) continue;
        const when = `The fortnight of ${options.label(fortnight.weeks[0].weekStart)}`;
        const { before, after } = fortnight;
        const would = options.kind === "extension" ? "would " : "";

        if (after.kind === "waived") {
            lines.push(
                before.kind === "waived"
                    ? `${when} stays waived: nothing is required.`
                    : options.kind === "extension"
                      ? `${when} would be waived, instead of requiring ${before.requiredMinutes} minutes.`
                      : `${when} is waived: nothing is required.`
            );
        } else if (after.requiredMinutes < before.requiredMinutes) {
            lines.push(
                `${when} ${would}now ${would ? "require" : "requires"} ${after.requiredMinutes} ` +
                    `minutes, down from ${before.requiredMinutes}.`
            );
        } else {
            lines.push(`${when} still requires ${after.requiredMinutes} minutes.`);
        }
    }

    return lines;
}
