import { describe, expect, it } from "vitest";
import { leaveLinesFor } from "../src/services/assessmentService.js";
import { actualEnd } from "../src/domain/leave.js";
import { pingLine } from "../src/services/pings.js";

const none = {
    week1LeaveDays: 0,
    week2LeaveDays: 0,
    week1Exempt: false,
    week2Exempt: false,
    requiredMinutes: 240,
    heldForLeave: false,
    minimumLeaveDays: 3
};

describe("what a review row says about leave", () => {
    it("says nothing when there was none", () => {
        expect(leaveLinesFor(none)).toEqual([]);
    });

    it("names the exempt week and the reduced requirement", () => {
        expect(
            leaveLinesFor({ ...none, week1LeaveDays: 4, week1Exempt: true, requiredMinutes: 120 })
        ).toEqual([
            "Week one: 4 days of leave, exempt.",
            "One week counts, so this fortnight asks for 120 minutes."
        ]);
    });

    it("explains leave that fell short of exempting a week", () => {
        expect(leaveLinesFor({ ...none, week2LeaveDays: 2 })).toEqual([
            "Week two: 2 days of leave, under the 3 it takes to exempt a week."
        ]);
    });

    it("says when a pending request holds the row", () => {
        expect(leaveLinesFor({ ...none, heldForLeave: true }).at(-1)).toContain(
            "Decide it before warning"
        );
    });
});

describe("where an ended leave actually ends", () => {
    const leave = {
        startDate: new Date("2026-10-05T00:00:00Z"),
        endDate: new Date("2026-10-19T00:00:00Z")
    };

    it("keeps the booked end when it ran its course", () => {
        expect(actualEnd(leave, new Date("2026-10-19T00:05:00Z"))).toEqual(leave.endDate);
    });

    it("moves to the moment it ended when that came sooner", () => {
        const at = new Date("2026-10-07T12:00:00Z");
        expect(actualEnd(leave, at)).toEqual(at);
    });

    it("covers nothing when cancelled before it began", () => {
        expect(actualEnd(leave, new Date("2026-10-01T00:00:00Z"))).toEqual(leave.startDate);
    });
});

describe("a ping", () => {
    it("mentions the role in front of the line", () => {
        expect(pingLine("123", "Leave to review.")).toBe("<@&123> Leave to review.");
    });

    it("still posts the line when no role is configured", () => {
        expect(pingLine("", "Leave to review.")).toBe("Leave to review.");
    });
});
