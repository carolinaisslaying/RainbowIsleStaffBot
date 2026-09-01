import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import type { ShiftDoc, ShiftPause } from "../src/db/types.js";
import {
    availableIntervals,
    computeAvailableMs,
    computePausedMs,
    openPauseOf,
    shiftMsInWindow,
    stateOf
} from "../src/domain/shifts.js";

const STAFF = new ObjectId();
const at = (iso: string) => new Date(iso);

function shift(overrides: Partial<ShiftDoc> = {}): ShiftDoc {
    return {
        _id: new ObjectId(),
        staffId: STAFF,
        startedAt: at("2026-09-28T10:00:00Z"),
        endedAt: null,
        endReason: null,
        pauses: [],
        availableMs: 0,
        activityMinutes: 0,
        ...overrides
    };
}

const pause = (from: string, to: string | null): ShiftPause => ({
    from: at(from),
    to: to ? at(to) : null,
    cause: "presence"
});

describe("derived state", () => {
    it("is ended when there is no shift", () => {
        expect(stateOf(null)).toBe("ended");
    });

    it("is ended when the shift has closed", () => {
        expect(stateOf(shift({ endedAt: at("2026-09-28T12:00:00Z"), endReason: "manual" }))).toBe(
            "ended"
        );
    });

    it("is available for a fresh shift", () => {
        expect(stateOf(shift())).toBe("available");
    });

    it("is away while a pause is open", () => {
        expect(stateOf(shift({ pauses: [pause("2026-09-28T10:30:00Z", null)] }))).toBe("away");
    });

    it("is available again once every pause has closed", () => {
        const doc = shift({
            pauses: [pause("2026-09-28T10:30:00Z", "2026-09-28T10:45:00Z")]
        });
        expect(stateOf(doc)).toBe("available");
        expect(openPauseOf(doc)).toBeNull();
    });

    it("finds the open pause even when earlier ones closed", () => {
        const doc = shift({
            pauses: [
                pause("2026-09-28T10:10:00Z", "2026-09-28T10:20:00Z"),
                pause("2026-09-28T10:40:00Z", null)
            ]
        });
        expect(stateOf(doc)).toBe("away");
        expect(openPauseOf(doc)?.from.toISOString()).toBe("2026-09-28T10:40:00.000Z");
    });
});

describe("available time", () => {
    it("counts the whole shift when it never paused", () => {
        const doc = shift({ endedAt: at("2026-09-28T12:00:00Z") });
        expect(computeAvailableMs(doc)).toBe(2 * 3_600_000);
        expect(computePausedMs(doc)).toBe(0);
    });

    it("subtracts a closed pause", () => {
        const doc = shift({
            endedAt: at("2026-09-28T12:00:00Z"),
            pauses: [pause("2026-09-28T10:30:00Z", "2026-09-28T11:00:00Z")]
        });
        expect(computeAvailableMs(doc)).toBe(90 * 60_000);
        expect(computePausedMs(doc)).toBe(30 * 60_000);
    });

    it("measures an open pause only up to now", () => {
        const doc = shift({ pauses: [pause("2026-09-28T10:30:00Z", null)] });
        const now = at("2026-09-28T11:00:00Z");
        expect(computeAvailableMs(doc, now)).toBe(30 * 60_000);
        expect(availableIntervals(doc, now)).toHaveLength(1);
    });

    it("merges overlapping pauses rather than double counting them", () => {
        const doc = shift({
            endedAt: at("2026-09-28T12:00:00Z"),
            pauses: [
                pause("2026-09-28T10:30:00Z", "2026-09-28T11:00:00Z"),
                pause("2026-09-28T10:45:00Z", "2026-09-28T11:15:00Z")
            ]
        });
        expect(computeAvailableMs(doc)).toBe(75 * 60_000);
    });

    it("clamps a pause that runs past the end of the shift", () => {
        const doc = shift({
            endedAt: at("2026-09-28T11:00:00Z"),
            pauses: [pause("2026-09-28T10:30:00Z", "2026-09-28T23:00:00Z")]
        });
        expect(computeAvailableMs(doc)).toBe(30 * 60_000);
    });

    it("returns nothing for a zero length shift", () => {
        const doc = shift({ endedAt: at("2026-09-28T10:00:00Z") });
        expect(availableIntervals(doc)).toEqual([]);
        expect(computeAvailableMs(doc)).toBe(0);
    });
});

describe("pause spanning a UTC day boundary", () => {
    const doc = shift({
        startedAt: at("2026-09-28T22:00:00Z"),
        endedAt: at("2026-09-29T04:00:00Z"),
        pauses: [pause("2026-09-28T23:30:00Z", "2026-09-29T01:30:00Z")]
    });

    it("subtracts the whole pause across midnight", () => {
        expect(computeAvailableMs(doc)).toBe(4 * 3_600_000);
        expect(computePausedMs(doc)).toBe(2 * 3_600_000);
    });

    it("splits into two available intervals either side of the pause", () => {
        const intervals = availableIntervals(doc);
        expect(intervals).toHaveLength(2);
        expect(intervals[0].from.toISOString()).toBe("2026-09-28T22:00:00.000Z");
        expect(intervals[0].to.toISOString()).toBe("2026-09-28T23:30:00.000Z");
        expect(intervals[1].from.toISOString()).toBe("2026-09-29T01:30:00.000Z");
        expect(intervals[1].to.toISOString()).toBe("2026-09-29T04:00:00.000Z");
    });

    it("attributes each side of midnight to the right accounting week", () => {
        // Week boundary at Monday 2026-09-28T00:00Z: the whole shift is one week.
        const weekStart = at("2026-09-28T00:00:00Z");
        const weekEnd = at("2026-10-05T00:00:00Z");
        expect(shiftMsInWindow(doc, weekStart, weekEnd)).toBe(4 * 3_600_000);

        // A window ending at midnight sees only the first available stretch.
        expect(shiftMsInWindow(doc, weekStart, at("2026-09-29T00:00:00Z"))).toBe(
            90 * 60_000
        );
        // And the following window sees only the second.
        expect(shiftMsInWindow(doc, at("2026-09-29T00:00:00Z"), weekEnd)).toBe(
            150 * 60_000
        );
    });
});

describe("windowing", () => {
    it("counts only the overlap with the window", () => {
        const doc = shift({
            startedAt: at("2026-09-27T23:00:00Z"),
            endedAt: at("2026-09-28T01:00:00Z")
        });
        expect(
            shiftMsInWindow(doc, at("2026-09-28T00:00:00Z"), at("2026-10-05T00:00:00Z"))
        ).toBe(3_600_000);
    });

    it("counts an open shift up to now", () => {
        const doc = shift({ startedAt: at("2026-09-28T10:00:00Z") });
        expect(
            shiftMsInWindow(
                doc,
                at("2026-09-28T00:00:00Z"),
                at("2026-10-05T00:00:00Z"),
                at("2026-09-28T11:30:00Z")
            )
        ).toBe(90 * 60_000);
    });
});
