import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import {
    activeWarningCount,
    reopenNotifies,
    decisionPermitted,
    priorOutcomesLine,
    queueCounts,
    queueHeadline,
    reminderDue,
    rowButtons,
    warningIsSpent,
    warningWeightLine
} from "../src/domain/review.js";

const ana = new ObjectId();
const bo = new ObjectId();
const now = new Date("2026-09-02T09:00:00Z");

describe("which buttons a row draws", () => {
    it("offers all three while undecided", () => {
        expect(rowButtons({ outcome: null, departed: false, rehearsal: false })).toEqual([
            "warn",
            "excuse",
            "dismiss"
        ]);
    });

    it("offers only reopen once decided", () => {
        // The card is the log. A decided row keeps exactly one way back and no
        // way to decide it twice.
        expect(rowButtons({ outcome: "warned", departed: false, rehearsal: false })).toEqual([
            "reopen"
        ]);
    });

    it("drops the warning button for somebody who has left", () => {
        expect(rowButtons({ outcome: null, departed: true, rehearsal: false })).toEqual([
            "excuse",
            "dismiss"
        ]);
    });
});

describe("who may decide what", () => {
    const base = {
        isExecutive: true,
        actorStaffId: ana,
        subjectStaffId: bo,
        departed: false
    } as const;

    it("lets an Executive decide somebody else's row", () => {
        for (const action of ["warn", "excuse", "dismiss", "reopen"] as const) {
            expect(decisionPermitted({ ...base, action }).ok).toBe(true);
        }
    });

    it("refuses a Lead every action", () => {
        for (const action of ["warn", "excuse", "dismiss", "reopen"] as const) {
            const seen = decisionPermitted({ ...base, action, isExecutive: false });
            expect(seen.ok).toBe(false);
            if (!seen.ok) expect(seen.reason).toContain("Executive only");
        }
    });

    it("refuses an Executive warning themselves", () => {
        const seen = decisionPermitted({ ...base, action: "warn", subjectStaffId: ana });
        expect(seen.ok).toBe(false);
        if (!seen.ok) expect(seen.reason).toContain("cannot warn yourself");
    });

    it("lets an Executive clear their own row by excusing or dismissing", () => {
        // Their rank outranks the requirement, so the assessment carries no
        // weight for them; the row still has to leave the queue somehow.
        expect(
            decisionPermitted({ ...base, action: "excuse", subjectStaffId: ana }).ok
        ).toBe(true);
        expect(
            decisionPermitted({ ...base, action: "dismiss", subjectStaffId: ana }).ok
        ).toBe(true);
    });

    it("refuses a warning for somebody who has left", () => {
        const seen = decisionPermitted({ ...base, action: "warn", departed: true });
        expect(seen.ok).toBe(false);
        if (!seen.ok) expect(seen.reason).toContain("nobody to serve");
    });
});

describe("what still counts against somebody", () => {
    const day = 86_400_000;

    it("spends a warning past the expiry window", () => {
        expect(warningIsSpent(new Date(now.getTime() - 181 * day), now, 180)).toBe(true);
        expect(warningIsSpent(new Date(now.getTime() - 179 * day), now, 180)).toBe(false);
    });

    it("counts a warning issued exactly on the boundary", () => {
        // Spent is strictly past the window, so the boundary day still counts.
        expect(warningIsSpent(new Date(now.getTime() - 180 * day), now, 180)).toBe(false);
    });

    it("ignores spent and rehearsal warnings in the total", () => {
        const warnings = [
            { issuedAt: new Date(now.getTime() - 10 * day) },
            { issuedAt: new Date(now.getTime() - 200 * day) },
            { issuedAt: new Date(now.getTime() - 1 * day), rehearsal: true }
        ];
        expect(activeWarningCount(warnings, now, 180)).toBe(1);
    });

    it("says what the next warning would be without deciding anything", () => {
        expect(warningWeightLine(0)).toContain("No warnings");
        expect(warningWeightLine(1)).toContain("their 2nd");
        expect(warningWeightLine(2)).toContain("their 3rd");
        expect(warningWeightLine(10)).toContain("their 11th");
        expect(warningWeightLine(20)).toContain("their 21st");
    });
});

describe("the header's sentence", () => {
    const rows = (decided: number, total: number) =>
        Array.from({ length: total }, (_, index) => ({
            outcome: index < decided ? ("warned" as const) : null
        }));

    it("counts what is left", () => {
        expect(queueCounts(rows(1, 3))).toEqual({ below: 3, decided: 1, remaining: 2 });
    });

    it("reads correctly with nobody below", () => {
        expect(queueHeadline(queueCounts([]), 240)).toContain("Nothing to review");
    });

    it("reads correctly with one member left", () => {
        expect(queueHeadline(queueCounts(rows(2, 3)), 240)).toContain("1 still to decide");
    });

    it("reads in the past tense once the queue is worked", () => {
        expect(queueHeadline(queueCounts(rows(3, 3)), 240)).toContain("All reviewed");
    });

    it("uses singular grammar for one member", () => {
        expect(queueHeadline(queueCounts(rows(0, 1)), 240)).toContain("1 member is below");
    });
});

describe("the one reminder", () => {
    const postedAt = new Date("2026-09-01T00:00:00Z");

    it("does not fire before the delay", () => {
        expect(
            reminderDue({
                postedAt,
                remindedAt: null,
                remaining: 2,
                now: new Date("2026-09-03T00:00:00Z"),
                afterDays: 3
            })
        ).toBe(false);
    });

    it("fires once the delay has passed", () => {
        expect(
            reminderDue({
                postedAt,
                remindedAt: null,
                remaining: 2,
                now: new Date("2026-09-04T00:00:01Z"),
                afterDays: 3
            })
        ).toBe(true);
    });

    it("never fires twice", () => {
        expect(
            reminderDue({
                postedAt,
                remindedAt: new Date("2026-09-04T00:00:01Z"),
                remaining: 2,
                now: new Date("2026-09-30T00:00:00Z"),
                afterDays: 3
            })
        ).toBe(false);
    });

    it("does not chase a queue that is finished", () => {
        expect(
            reminderDue({
                postedAt,
                remindedAt: null,
                remaining: 0,
                now: new Date("2026-09-30T00:00:00Z"),
                afterDays: 3
            })
        ).toBe(false);
    });
});

describe("the previous outcomes line", () => {
    const month = (date: Date) =>
        `${date.getUTCDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getUTCMonth()]}`;

    it("says so plainly when there is no history", () => {
        expect(priorOutcomesLine([], month)).toBe("No earlier fortnight has been reviewed.");
    });

    it("names the date and the decision instead of a fortnight index", () => {
        // The old line read "F-3 0m below, F-5 0m warned", which asks the reader
        // to know what a fortnight index is and that a negative one is possible.
        const line = priorOutcomesLine(
            [
                {
                    windowStart: new Date("2026-08-03T00:00:00Z"),
                    totalMinutes: 0,
                    requiredMinutes: 240,
                    outcome: "warned",
                    status: "below"
                },
                {
                    windowStart: new Date("2026-07-20T00:00:00Z"),
                    totalMinutes: 120,
                    requiredMinutes: 240,
                    outcome: null,
                    status: "below"
                }
            ],
            month
        );
        expect(line).toContain("3 Aug: warned");
        expect(line).toContain("20 Jul: 120 of 240 min, undecided");
        expect(line).not.toMatch(/F-?\d/);
    });

    it("says on leave rather than exempt", () => {
        const line = priorOutcomesLine(
            [
                {
                    windowStart: new Date("2026-08-03T00:00:00Z"),
                    totalMinutes: 0,
                    requiredMinutes: 240,
                    outcome: null,
                    status: "exempt"
                }
            ],
            month
        );
        expect(line).toContain("on leave");
    });
});


describe("who hears about a reopened decision", () => {
    it("tells a member whose warning has been withdrawn", () => {
        expect(reopenNotifies("warned")).toBe(true);
    });

    it("tells a member whose excusal has been withdrawn", () => {
        // They were told they were excused, so they have to be told it is back
        // open, or their own record contradicts what they were last told.
        expect(reopenNotifies("excused")).toBe(true);
    });

    it("says nothing when reopening a dismissal", () => {
        // A dismissal is never raised with the member. Announcing the reopening
        // of one would raise the issue they were deliberately never told about,
        // which is the whole thing the silence exists to prevent.
        expect(reopenNotifies("dismissed")).toBe(false);
    });

    it("says nothing when there was no decision to withdraw", () => {
        expect(reopenNotifies(null)).toBe(false);
    });
});
