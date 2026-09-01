import { describe, expect, it } from "vitest";
import {
    completesFortnight,
    fortnightIndexFor,
    fortnightWindow,
    nextWeekStart,
    utcDayKeysBetween,
    wallClockIn,
    weekIndexFrom,
    weekStartFor,
    zoneOffsetMs,
    zonedToUtc
} from "../src/time/calendar.js";

const ANCHOR = new Date("2026-09-28T00:00:00Z");

describe("week boundaries in UTC", () => {
    it("snaps a mid-week instant back to Monday 00:00", () => {
        const start = weekStartFor(new Date("2026-10-01T13:45:00Z"), "UTC", 1);
        expect(start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    });

    it("treats Monday 00:00 as the start of its own week, not the previous one", () => {
        const start = weekStartFor(new Date("2026-09-28T00:00:00Z"), "UTC", 1);
        expect(start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    });

    it("treats Sunday 23:59:59 as the last instant of the week", () => {
        const start = weekStartFor(new Date("2026-10-04T23:59:59Z"), "UTC", 1);
        expect(start.toISOString()).toBe("2026-09-28T00:00:00.000Z");
        const end = nextWeekStart(start, "UTC", 1);
        expect(end.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    });

    it("honours a configured Sunday week start", () => {
        const start = weekStartFor(new Date("2026-10-01T13:45:00Z"), "UTC", 0);
        expect(start.toISOString()).toBe("2026-09-27T00:00:00.000Z");
    });
});

describe("DST transitions in a non-UTC accounting timezone", () => {
    // Pacific/Auckland moves forward on 27 September 2026 (2am to 3am) and back
    // on 5 April 2026 (3am to 2am).
    const NZ = "Pacific/Auckland";

    it("spring forward: the week is 167 hours, not 168", () => {
        const start = weekStartFor(new Date("2026-09-23T00:00:00Z"), NZ, 1);
        const end = nextWeekStart(start, NZ, 1);
        const hours = (end.getTime() - start.getTime()) / 3_600_000;
        expect(hours).toBe(167);
    });

    it("autumn back: the week is 169 hours, not 168", () => {
        const start = weekStartFor(new Date("2026-04-01T00:00:00Z"), NZ, 1);
        const end = nextWeekStart(start, NZ, 1);
        const hours = (end.getTime() - start.getTime()) / 3_600_000;
        expect(hours).toBe(169);
    });

    it("every week boundary is local midnight regardless of the offset change", () => {
        for (const instant of ["2026-09-23T00:00:00Z", "2026-04-01T00:00:00Z"]) {
            const start = weekStartFor(new Date(instant), NZ, 1);
            const wall = wallClockIn(start, NZ);
            expect(wall.hour).toBe(0);
            expect(wall.minute).toBe(0);
            expect(wall.weekday).toBe(1);
        }
    });

    it("reports the offset either side of a transition", () => {
        expect(zoneOffsetMs(new Date("2026-09-26T00:00:00Z"), NZ)).toBe(12 * 3_600_000);
        expect(zoneOffsetMs(new Date("2026-09-28T00:00:00Z"), NZ)).toBe(13 * 3_600_000);
    });

    it("round-trips a wall clock reading through the zone", () => {
        const instant = zonedToUtc({ year: 2026, month: 6, day: 15, hour: 9 }, NZ);
        const wall = wallClockIn(instant, NZ);
        expect(wall).toMatchObject({ year: 2026, month: 6, day: 15, hour: 9 });
    });

    it("handles a northern hemisphere zone in both directions too", () => {
        const NY = "America/New_York";
        // Clocks go forward on Sunday 8 March, the last day of the week
        // starting Monday 2 March.
        const springStart = weekStartFor(new Date("2026-03-04T12:00:00Z"), NY, 1);
        const springHours =
            (nextWeekStart(springStart, NY, 1).getTime() - springStart.getTime()) / 3_600_000;
        expect(springHours).toBe(167);

        // Clocks go back on Sunday 1 November, closing the week that started
        // Monday 26 October.
        const autumnStart = weekStartFor(new Date("2026-10-28T12:00:00Z"), NY, 1);
        const autumnHours =
            (nextWeekStart(autumnStart, NY, 1).getTime() - autumnStart.getTime()) / 3_600_000;
        expect(autumnHours).toBe(169);
    });
});

describe("fortnight index derivation", () => {
    it("puts the anchor week in fortnight 0", () => {
        expect(fortnightIndexFor(new Date("2026-09-28T00:00:00Z"), ANCHOR)).toBe(0);
    });

    it("puts the week after the anchor in fortnight 0 as well", () => {
        expect(fortnightIndexFor(new Date("2026-10-05T00:00:00Z"), ANCHOR)).toBe(0);
    });

    it("advances at the third week", () => {
        expect(fortnightIndexFor(new Date("2026-10-12T00:00:00Z"), ANCHOR)).toBe(1);
        expect(fortnightIndexFor(new Date("2026-10-19T00:00:00Z"), ANCHOR)).toBe(1);
        expect(fortnightIndexFor(new Date("2026-10-26T00:00:00Z"), ANCHOR)).toBe(2);
    });

    it("goes negative before the anchor, without rounding toward zero", () => {
        expect(fortnightIndexFor(new Date("2026-09-21T00:00:00Z"), ANCHOR)).toBe(-1);
        expect(fortnightIndexFor(new Date("2026-09-14T00:00:00Z"), ANCHOR)).toBe(-1);
        expect(fortnightIndexFor(new Date("2026-09-07T00:00:00Z"), ANCHOR)).toBe(-2);
    });

    it("identifies which weeks close a fortnight", () => {
        expect(completesFortnight(new Date("2026-09-28T00:00:00Z"), ANCHOR)).toBe(false);
        expect(completesFortnight(new Date("2026-10-05T00:00:00Z"), ANCHOR)).toBe(true);
        expect(completesFortnight(new Date("2026-10-12T00:00:00Z"), ANCHOR)).toBe(false);
        expect(completesFortnight(new Date("2026-10-19T00:00:00Z"), ANCHOR)).toBe(true);
    });

    it("identifies closing weeks before the anchor too", () => {
        expect(completesFortnight(new Date("2026-09-21T00:00:00Z"), ANCHOR)).toBe(true);
        expect(completesFortnight(new Date("2026-09-14T00:00:00Z"), ANCHOR)).toBe(false);
    });

    it("survives a DST transition between the anchor and the week", () => {
        // A raw millisecond division would be an hour short here and floor down.
        const weekStart = weekStartFor(new Date("2026-04-08T00:00:00Z"), "Pacific/Auckland", 1);
        const nzAnchor = weekStartFor(new Date("2026-03-11T00:00:00Z"), "Pacific/Auckland", 1);
        expect(weekIndexFrom(weekStart, nzAnchor)).toBe(4);
        expect(fortnightIndexFor(weekStart, nzAnchor)).toBe(2);
    });

    it("builds a window whose two weeks are contiguous", () => {
        const window = fortnightWindow(3, ANCHOR, "UTC", 1);
        expect(window.week1Start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
        expect(window.week2Start.toISOString()).toBe("2026-11-16T00:00:00.000Z");
        expect(window.end.toISOString()).toBe("2026-11-23T00:00:00.000Z");
        expect(fortnightIndexFor(window.week1Start, ANCHOR)).toBe(3);
        expect(fortnightIndexFor(window.week2Start, ANCHOR)).toBe(3);
    });

    it("builds windows either side of a DST change without drifting", () => {
        const nzAnchor = new Date("2026-03-08T11:00:00Z");
        for (let index = -2; index <= 4; index += 1) {
            const window = fortnightWindow(index, nzAnchor, "Pacific/Auckland", 1);
            expect(fortnightIndexFor(window.week1Start, nzAnchor)).toBe(index);
            expect(fortnightIndexFor(window.week2Start, nzAnchor)).toBe(index);
            expect(wallClockIn(window.week1Start, "Pacific/Auckland").hour).toBe(0);
        }
    });
});

describe("UTC day keys", () => {
    it("lists every day a window touches, half open", () => {
        const keys = utcDayKeysBetween(
            new Date("2026-09-28T13:00:00Z"),
            new Date("2026-10-01T02:00:00Z")
        );
        expect(keys).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    });

    it("excludes a day the window ends exactly at the start of", () => {
        const keys = utcDayKeysBetween(
            new Date("2026-09-28T00:00:00Z"),
            new Date("2026-09-29T00:00:00Z")
        );
        expect(keys).toEqual(["2026-09-28"]);
    });
});
