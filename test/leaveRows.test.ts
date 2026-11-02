import { describe, expect, it } from "vitest";
import { actualEnd } from "../src/domain/leave.js";
import { pingLine } from "../src/services/pings.js";

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
