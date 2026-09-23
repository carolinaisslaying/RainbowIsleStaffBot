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

/** Marks a week the leave sets aside. The calendar: it is a week of leave. */
export const WEEK_SET_ASIDE = "📅";
/** Marks a week that still counts: a working week. */
export const WEEK_COUNTS = "💼";

/**
 * What a leave does to the member's requirements, in the lines the
 * confirmation card prints. A request states it as settled, because the
 * member is agreeing to it; an extension states it as what would happen,
 * because an Executive has yet to agree.
 *
 * Grouped by fortnight, each with both of its weeks beneath it, because that
 * is how the rule works: a fortnight asks one weekly target per week that
 * still counts. It used to list every week and then every fortnight, which
 * left the reader to pair them up, and in a long leave read as a wall.
 * Each week leads with a mark and ends with its state in words, so neither
 * carries the meaning alone.
 *
 * `label` formats a week or fortnight start ("5 Oct"). Passed in, as
 * `priorOutcomesLine` does, so this stays free of timezone formatting.
 */
export function describeLeaveEffect(
    effect: LeaveEffect,
    options: {
        kind: "request" | "extension";
        label: (date: Date) => string;
        minimumLeaveDays: number;
    }
): string[] {
    const extension = options.kind === "extension";
    const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;
    const lines: string[] = [];

    // First, because it is the one thing a member most needs to see before
    // agreeing: the leave they are booking changes nothing.
    if (!extension && effect.exemptsNothing) {
        lines.push(
            effect.split
                ? "❗ This leave doesn't set aside either week, because it's split across two."
                : "❗ This leave doesn't set aside its week.",
            ""
        );
    }

    const fortnights = effect.fortnights.filter((fortnight) =>
        fortnight.weeks.some((week) => effect.touchedWeeks.includes(week))
    );
    fortnights.forEach((fortnight, position) => {
        if (position > 0) lines.push("");
        lines.push(
            `**Fortnight of ${options.label(fortnight.weeks[0].weekStart)}** · ` +
                requirementPhrase(fortnight.before, fortnight.after, extension)
        );
        for (const week of fortnight.weeks) {
            const moved = extension && week.daysBefore !== week.daysAfter;
            const leave = moved
                ? `was ${days(week.daysBefore)}, now ${days(week.daysAfter)}`
                : week.daysAfter === 0
                  ? "no leave"
                  : `${days(week.daysAfter)} of leave`;
            const state = !moved
                ? week.exemptAfter
                    ? "set aside"
                    : "still counts"
                : week.exemptAfter && !week.exemptBefore
                  ? "would be set aside"
                  : week.exemptAfter
                    ? "stays set aside"
                    : "would still count";
            lines.push(
                `- ${week.exemptAfter ? WEEK_SET_ASIDE : WEEK_COUNTS} ` +
                    `Week of ${options.label(week.weekStart)} · ${leave} · ${state}`
            );
        }
    });

    if (fortnights.length > 0) {
        lines.push(
            "",
            `-# A week needs ${days(options.minimumLeaveDays)} of leave to be set aside.`
        );
    }
    return lines;
}

/** What a fortnight asks for once the change applies, against what it asked before. */
function requirementPhrase(before: Requirement, after: Requirement, extension: boolean): string {
    if (after.kind === "waived") {
        if (before.kind === "waived") return "nothing required, unchanged";
        return extension
            ? `would need nothing, instead of ${before.requiredMinutes} min`
            : "nothing required";
    }
    const was = before.kind === "waived" ? 0 : before.requiredMinutes;
    if (before.kind !== "waived" && after.requiredMinutes < was) {
        return extension
            ? `would need ${after.requiredMinutes} min, down from ${was}`
            : `${after.requiredMinutes} min required, down from ${was}`;
    }
    return `${after.requiredMinutes} min required, unchanged`;
}
