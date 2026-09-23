import { describe, expect, it } from "vitest";
import { EMOJI, EMOJI_FOR_COLOUR } from "../src/render/emoji.js";
import {
    describeLeaveEffect,
    WEEK_COUNTS,
    WEEK_EXEMPT,
    fortnightRequirement,
    fortnightStatus,
    leaveDaysIn,
    leaveEffect,
    leaveLength,
    weekLeave,
    type LeaveSpan
} from "../src/domain/leaveDays.js";
import { assessmentVerdict } from "../src/domain/assessments.js";
import { labelDate } from "../src/time/format.js";

/**
 * Leave, measured per week and turned into a requirement.
 *
 * The calendar here is UTC with weeks from Monday and the cycle anchored on
 * Monday 5 October 2026, so the first fortnight is the weeks of 5 and 12
 * October and the second the weeks of 19 and 26 October. Weekly target 120,
 * minimum leave 3 days: the shipped defaults.
 */

const at = (iso: string) => new Date(iso);
const span = (from: string, to: string): LeaveSpan => ({ startDate: at(from), endDate: at(to) });

const rules = { anchor: at("2026-10-05T00:00:00Z"), timeZone: "UTC", weekStartDay: 1 };
const weekOf5Oct = [at("2026-10-05T00:00:00Z"), at("2026-10-12T00:00:00Z")] as const;

function effectOf(before: LeaveSpan[], after: LeaveSpan[], changed: LeaveSpan, kind: "request" | "extension") {
    const effect = leaveEffect({
        span: changed,
        before,
        after,
        rules,
        minimumLeaveDays: 3,
        weeklyTargetMinutes: 120
    });
    return describeLeaveEffect(effect, {
        kind,
        label: (date) => labelDate(date, "UTC"),
        minimumLeaveDays: 3
    });
}

const request = (leave: LeaveSpan) => effectOf([], [leave], leave, "request");

describe("counting leave days in a week", () => {
    it("rounds hours to the nearest day: 66 hours is 3", () => {
        // Fri 15:00 to Mon 09:00, all inside one week would be 66h. Here it is
        // measured over a window wide enough to hold all of it.
        expect(
            leaveDaysIn([span("2026-10-09T15:00:00Z", "2026-10-12T09:00:00Z")], at("2026-10-05T00:00:00Z"), at("2026-10-19T00:00:00Z"))
        ).toBe(3);
    });

    it("rounds 2.4 days down", () => {
        expect(leaveDaysIn([span("2026-10-06T00:00:00Z", "2026-10-08T09:36:00Z")], ...weekOf5Oct)).toBe(2);
    });

    it("counts overlapping leave once", () => {
        expect(
            leaveDaysIn(
                [span("2026-10-06T00:00:00Z", "2026-10-09T00:00:00Z"), span("2026-10-07T00:00:00Z", "2026-10-10T00:00:00Z")],
                ...weekOf5Oct
            )
        ).toBe(4);
    });

    it("counts only the part inside the week", () => {
        expect(leaveDaysIn([span("2026-10-10T00:00:00Z", "2026-10-14T00:00:00Z")], ...weekOf5Oct)).toBe(2);
    });

    it("exempts a week at the minimum and not below it", () => {
        expect(weekLeave([span("2026-10-06T00:00:00Z", "2026-10-09T00:00:00Z")], ...weekOf5Oct, 3).exempt).toBe(true);
        expect(weekLeave([span("2026-10-06T00:00:00Z", "2026-10-08T00:00:00Z")], ...weekOf5Oct, 3).exempt).toBe(false);
    });

    it("never exempts a week holding no leave, whatever the minimum", () => {
        expect(weekLeave([], ...weekOf5Oct, 0).exempt).toBe(false);
    });
});

describe("the fortnight requirement", () => {
    it("asks for two weekly targets, pooled, when no week is exempt", () => {
        const requirement = fortnightRequirement(false, false, 120);
        expect(requirement).toEqual({ kind: "full", requiredMinutes: 240 });
        // A slow week made up in the next still passes.
        expect(fortnightStatus(40 + 210, requirement)).toBe("met");
    });

    it("asks for one weekly target when one week is exempt, counting both weeks' minutes", () => {
        const requirement = fortnightRequirement(true, false, 120);
        expect(requirement).toEqual({ kind: "reduced", requiredMinutes: 120 });
        expect(fortnightStatus(30 + 95, requirement)).toBe("met");
        expect(fortnightStatus(30 + 80, requirement)).toBe("below");
    });

    it("waives the fortnight only when both weeks are exempt", () => {
        const requirement = fortnightRequirement(true, true, 120);
        expect(requirement).toEqual({ kind: "waived", requiredMinutes: 0 });
        expect(fortnightStatus(0, requirement)).toBe("exempt");
    });
});

describe("a fortnight's verdict", () => {
    const window = {
        week1Start: at("2026-10-05T00:00:00Z"),
        week2Start: at("2026-10-12T00:00:00Z"),
        end: at("2026-10-19T00:00:00Z")
    };
    const rules3 = { weeklyTargetMinutes: 120, minimumLeaveDays: 3 };

    it("holds a row that pending leave would take off the queue", () => {
        const verdict = assessmentVerdict({
            week1Minutes: 0,
            week2Minutes: 130,
            counting: [],
            pending: [span("2026-10-06T00:00:00Z", "2026-10-10T00:00:00Z")],
            window,
            rules: rules3
        });
        expect(verdict.status).toBe("below");
        expect(verdict.requiredMinutes).toBe(240);
        expect(verdict.heldForLeave).toBe(true);
    });

    it("does not hold a row that pending leave would leave below anyway", () => {
        const verdict = assessmentVerdict({
            week1Minutes: 0,
            week2Minutes: 10,
            counting: [],
            pending: [span("2026-10-06T00:00:00Z", "2026-10-10T00:00:00Z")],
            window,
            rules: rules3
        });
        expect(verdict.status).toBe("below");
        expect(verdict.heldForLeave).toBe(false);
    });

    it("never lets pending leave change the verdict itself", () => {
        const verdict = assessmentVerdict({
            week1Minutes: 0,
            week2Minutes: 0,
            counting: [],
            pending: [span("2026-10-05T00:00:00Z", "2026-10-19T00:00:00Z")],
            window,
            rules: rules3
        });
        expect(verdict.status).toBe("below");
        expect(verdict.week1Exempt).toBe(false);
    });
});

describe("the confirmation card, scenario by scenario", () => {
    it("1. refuses a leave under the minimum", () => {
        expect(leaveLength(span("2026-10-09T15:00:00Z", "2026-10-11T20:00:00Z"))).toBe(2);
    });

    it("2. a leave inside one week exempts it and halves the fortnight", () => {
        expect(request(span("2026-10-06T00:00:00Z", "2026-10-09T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 📅 Week of 5 Oct · 3 days of leave · exempt",
            "- 💼 Week of 12 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("3. a full week is exempt, and the fortnight is not waived", () => {
        expect(request(span("2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 📅 Week of 5 Oct · 7 days of leave · exempt",
            "- 💼 Week of 12 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("4. a leave split 2 and 2 exempts nothing, and says so first", () => {
        expect(request(span("2026-10-10T00:00:00Z", "2026-10-14T00:00:00Z"))).toEqual([
            "❗ This leave doesn't exempt either week, because it's split across two.",
            "",
            "**Fortnight of 5 Oct** · 240 min required, unchanged",
            "- 💼 Week of 5 Oct · 2 days of leave · still counts",
            "- 💼 Week of 12 Oct · 2 days of leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("5. a leave split 3 and 2 exempts one week", () => {
        expect(request(span("2026-10-09T00:00:00Z", "2026-10-14T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 📅 Week of 5 Oct · 3 days of leave · exempt",
            "- 💼 Week of 12 Oct · 2 days of leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("6. a leave exempting both weeks waives the fortnight", () => {
        expect(request(span("2026-10-08T00:00:00Z", "2026-10-15T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · nothing required",
            "- 📅 Week of 5 Oct · 4 days of leave · exempt",
            "- 📅 Week of 12 Oct · 3 days of leave · exempt",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("7. a leave across a fortnight boundary reduces both fortnights", () => {
        expect(request(span("2026-10-15T00:00:00Z", "2026-10-22T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 💼 Week of 5 Oct · no leave · still counts",
            "- 📅 Week of 12 Oct · 4 days of leave · exempt",
            "",
            "**Fortnight of 19 Oct** · 120 min required, down from 240",
            "- 📅 Week of 19 Oct · 3 days of leave · exempt",
            "- 💼 Week of 26 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("8. a long leave waives one fortnight and reduces the next", () => {
        expect(request(span("2026-10-05T00:00:00Z", "2026-10-26T00:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · nothing required",
            "- 📅 Week of 5 Oct · 7 days of leave · exempt",
            "- 📅 Week of 12 Oct · 7 days of leave · exempt",
            "",
            "**Fortnight of 19 Oct** · 120 min required, down from 240",
            "- 📅 Week of 19 Oct · 7 days of leave · exempt",
            "- 💼 Week of 26 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("9. partial days add up: 68 hours rounds to 3", () => {
        expect(request(span("2026-10-07T14:00:00Z", "2026-10-10T10:00:00Z"))).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 📅 Week of 5 Oct · 3 days of leave · exempt",
            "- 💼 Week of 12 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("10. an extension says what it would change", () => {
        const booked = span("2026-10-09T00:00:00Z", "2026-10-14T00:00:00Z");
        const extended = span("2026-10-09T00:00:00Z", "2026-10-16T00:00:00Z");
        expect(
            effectOf([booked], [extended], span("2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z"), "extension")
        ).toEqual([
            "**Fortnight of 5 Oct** · would need nothing, instead of 120 min",
            "- 📅 Week of 5 Oct · 3 days of leave · exempt",
            "- 📅 Week of 12 Oct · was 2 days, now 4 days · would be exempt",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });

    it("counts the member's other leave in the same week", () => {
        const earlier = span("2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z");
        const added = span("2026-10-08T00:00:00Z", "2026-10-09T00:00:00Z");
        expect(effectOf([earlier], [earlier, added], added, "request")).toEqual([
            "**Fortnight of 5 Oct** · 120 min required, down from 240",
            "- 📅 Week of 5 Oct · 3 days of leave · exempt",
            "- 💼 Week of 12 Oct · no leave · still counts",
            "",
            "-# A week needs 3 days of leave to be exempt."
        ]);
    });
});

describe("the confirmation card groups weeks under their fortnight", () => {
    // It used to list every week and then every fortnight, which left the
    // reader to pair them up; a six-week leave read as a wall of text.
    it("shows both weeks of each fortnight, including the one leave does not touch", () => {
        const lines = request(span("2026-10-06T00:00:00Z", "2026-10-09T00:00:00Z"));
        expect(lines[0]).toMatch(/^\*\*Fortnight of 5 Oct\*\*/);
        expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(2);
    });

    it("marks each week and says its state in words, so the mark never carries it alone", () => {
        for (const line of request(span("2026-10-10T00:00:00Z", "2026-10-26T00:00:00Z"))) {
            if (!line.startsWith("- ")) continue;
            expect(
                (line.includes(WEEK_EXEMPT) && line.endsWith("exempt")) ||
                    (line.includes(WEEK_COUNTS) && line.endsWith("still counts"))
            ).toBe(true);
        }
    });

    it("uses marks nothing else in the bot uses", () => {
        expect(WEEK_EXEMPT).not.toBe(WEEK_COUNTS);
        expect(Object.values(EMOJI_FOR_COLOUR)).not.toContain(WEEK_EXEMPT);
        expect(Object.values(EMOJI_FOR_COLOUR)).not.toContain(WEEK_COUNTS);
        expect(Object.values(EMOJI)).not.toContain(WEEK_EXEMPT);
        expect(Object.values(EMOJI)).not.toContain(WEEK_COUNTS);
    });
});
