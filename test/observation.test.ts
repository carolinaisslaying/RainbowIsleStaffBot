import { describe, expect, it } from "vitest";
import {
    busiestRun,
    dailyProfile,
    gapBand,
    hourWeight,
    hoursTouchedBy,
    listeningOver,
    memberWindowStart,
    minutesByUtcHour,
    observe,
    quietestHour,
    spreadByHour,
    type ObservationInput
} from "../src/domain/observation.js";
import { reliabilityNote, sampleLabel } from "../src/render/heatmap.js";
import { emptyBitmap, setMinute } from "../src/domain/bitmap.js";

/**
 * The heatmaps average each cell over the hours the bot actually heard, so a
 * deployment a few hours old shows those hours at their real size and the grid
 * fills in from there. Everything here is pure; the dates are fixed and the
 * zone is Pacific/Auckland, whose DST change catches 24-hour-day assumptions.
 */

const HOUR = 3_600_000;
const ZONE = "Pacific/Auckland";
/** Monday. */
const WEEK_START = 1;

function input(overrides: Partial<ObservationInput>): ObservationInput {
    return {
        from: new Date("2026-08-03T00:00:00Z"),
        to: new Date("2026-08-03T02:00:00Z"),
        timeZone: ZONE,
        weekStartDay: WEEK_START,
        messagesByHour: new Map(),
        coverageByHour: new Map(),
        uptime: new Map(),
        measuredSince: null,
        ...overrides
    };
}

const sum = (grid: number[][]) => grid.flat().reduce((total, value) => total + value, 0);

describe("which hours count", () => {
    const hour = Date.parse("2026-08-03T05:00:00Z");
    const since = Date.parse("2026-08-01T00:00:00Z");

    it("assumes every hour before uptime was measured was heard", () => {
        expect(hourWeight(hour, new Map(), null)).toBe(1);
        expect(hourWeight(since - HOUR, new Map(), since)).toBe(1);
    });

    it("reads an hour with no uptime record as no data, not as quiet", () => {
        expect(hourWeight(hour, new Map(), since)).toBeNull();
    });

    it("reads an hour heard in full as a whole reading, zero messages included", () => {
        expect(hourWeight(hour, new Map([[hour, 60]]), since)).toBe(1);
    });

    it("scales a partly heard hour, and drops one heard for under half of it", () => {
        expect(hourWeight(hour, new Map([[hour, 45]]), since)).toBe(0.75);
        expect(hourWeight(hour, new Map([[hour, 30]]), since)).toBe(0.5);
        expect(hourWeight(hour, new Map([[hour, 29]]), since)).toBeNull();
    });
});

describe("averaging over what was heard", () => {
    it("shows two hours of data as two cells at their real size, and nothing else", () => {
        const from = Date.parse("2026-08-03T00:00:00Z");
        const result = observe(
            input({
                messagesByHour: new Map([
                    [from, 120],
                    [from + HOUR, 90]
                ])
            })
        );

        expect(result.observedHours).toBe(2);
        expect(sum(result.observed)).toBe(2);
        // Monday 12:00 and 13:00 in Auckland (UTC+12 in August).
        expect(result.demand[0][12]).toBe(120);
        expect(result.demand[0][13]).toBe(90);
        expect(sum(result.demand)).toBe(210);
    });

    it("divides by the times a cell came round, not by the weeks asked for", () => {
        const first = Date.parse("2026-08-03T00:00:00Z");
        const second = first + 7 * 24 * HOUR;
        const result = observe(
            input({
                from: new Date(first),
                to: new Date(second + HOUR),
                messagesByHour: new Map([
                    [first, 100],
                    [second, 200]
                ])
            })
        );
        expect(result.observed[0][12]).toBe(2);
        expect(result.demand[0][12]).toBe(150);
        // Every other hour of the week came round once, and was quiet.
        expect(result.observed[0][13]).toBe(1);
        expect(result.demand[0][13]).toBe(0);
    });

    it("leaves an hour the bot missed out of the average entirely", () => {
        const first = Date.parse("2026-08-03T00:00:00Z");
        const second = first + 7 * 24 * HOUR;
        const result = observe(
            input({
                from: new Date(first),
                to: new Date(second + HOUR),
                messagesByHour: new Map([[first, 100]]),
                uptime: new Map([[first, 60]]),
                measuredSince: first
            })
        );
        // The second Monday 12:00 has no uptime, so it is not a zero dragging
        // the first one down.
        expect(result.observed[0][12]).toBe(1);
        expect(result.demand[0][12]).toBe(100);
        expect(result.observedHours).toBe(1);
    });

    it("scales a partly heard hour up to a full one", () => {
        const from = Date.parse("2026-08-03T00:00:00Z");
        const result = observe(
            input({
                to: new Date(from + HOUR),
                messagesByHour: new Map([[from, 40]]),
                uptime: new Map([[from, 48]]),
                measuredSince: from
            })
        );
        expect(result.demand[0][12]).toBe(50);
    });

    it("drops a missed hour's coverage with it, so both sides of the ratio match", () => {
        const from = Date.parse("2026-08-03T00:00:00Z");
        const result = observe(
            input({
                messagesByHour: new Map([[from, 10]]),
                coverageByHour: new Map([
                    [from, HOUR],
                    [from + HOUR, 2 * HOUR]
                ]),
                uptime: new Map([[from, 60]]),
                measuredSince: from
            })
        );
        expect(result.coverage[0][12]).toBe(1);
        expect(result.coverage[0][13]).toBe(0);
        expect(result.observed[0][13]).toBe(0);
    });

    it("walks a DST change in the display zone without inventing the missing hour", () => {
        // Auckland springs forward at 02:00 on Sunday 27 September 2026. Local
        // midnight to midnight that day is 23 hours long.
        const result = observe(
            input({
                from: new Date("2026-09-26T12:00:00Z"),
                to: new Date("2026-09-27T11:00:00Z")
            })
        );
        const sunday = 6;
        expect(result.observedHours).toBe(23);
        expect(result.observed[sunday][2]).toBe(0);
        expect(result.observed[sunday][1]).toBe(1);
        expect(result.observed[sunday][3]).toBe(1);
        expect(sum(result.observed)).toBe(23);
    });
});

describe("spreading coverage across hours", () => {
    it("splits an interval at every hour boundary it crosses", () => {
        const into = new Map<number, number>();
        const start = Date.parse("2026-08-03T00:30:00Z");
        spreadByHour(into, new Date(start), new Date(start + 2 * HOUR));
        expect([...into.values()]).toEqual([HOUR / 2, HOUR, HOUR / 2]);
    });
});

describe("the daily summary", () => {
    function profileOf(means: (number | null)[]) {
        return {
            mean: means,
            samples: means.map((value) => (value === null ? 0 : 1))
        };
    }

    it("pools every weekday into one day", () => {
        const from = Date.parse("2026-08-03T00:00:00Z");
        const result = observe(
            input({
                to: new Date(from + 2 * 24 * HOUR),
                messagesByHour: new Map([
                    [from, 100],
                    [from + 24 * HOUR, 300]
                ])
            })
        );
        const profile = dailyProfile(result);
        expect(profile.samples[12]).toBe(2);
        expect(profile.mean[12]).toBe(200);
    });

    it("widens the peak to neighbours within 85% of it", () => {
        const means = Array<number | null>(24).fill(10);
        means[20] = 100;
        means[21] = 90;
        means[19] = 80;
        const run = busiestRun(profileOf(means));
        expect(run).toEqual({ start: 20, length: 2, mean: 95 });
    });

    it("carries a late peak past midnight as one run", () => {
        const means = Array<number | null>(24).fill(5);
        means[23] = 100;
        means[0] = 95;
        const run = busiestRun(profileOf(means));
        expect(run?.start).toBe(23);
        expect(run?.length).toBe(2);
    });

    it("ignores hours never heard when finding the quietest", () => {
        const means = Array<number | null>(24).fill(null);
        means[4] = 3;
        means[20] = 50;
        expect(quietestHour(profileOf(means))).toEqual({ hour: 4, mean: 3 });
    });

    it("has nothing to say about a day with no messages", () => {
        expect(busiestRun(profileOf(Array(24).fill(0)))).toBeNull();
    });
});

describe("saying how much data a grid rests on", () => {
    it("counts hours, then days, then weeks", () => {
        expect(sampleLabel(1)).toBe("1 hour of data");
        expect(sampleLabel(5)).toBe("5 hours of data");
        expect(sampleLabel(24)).toBe("1 day of data");
        expect(sampleLabel(13 * 24)).toBe("13 days of data");
        expect(sampleLabel(14 * 24)).toBe("2 week mean");
    });

    it("warns until two weeks, then goes quiet", () => {
        expect(reliabilityNote(5)).toContain("single hour");
        expect(reliabilityNote(3 * 24)).toContain("Based on 3 days");
        expect(reliabilityNote(10 * 24)).toContain("second week");
        expect(reliabilityNote(14 * 24)).toBeNull();
    });
});

describe("minutes listening", () => {
    const now = new Date("2026-08-04T00:00:00Z");
    const dayAgo = new Date(now.getTime() - 24 * HOUR);

    it("counts minutes inside the window against a full day", () => {
        const hourStart = Date.parse("2026-08-03T10:00:00Z");
        const rows = [{ hourStart, minutes: [0, 1, 2] }];
        expect(listeningOver(rows, dayAgo.getTime() - HOUR, dayAgo, now)).toEqual({
            online: 3,
            possible: 1440
        });
    });

    it("does not hold minutes before measuring began against the bot", () => {
        const since = now.getTime() - 90 * 60_000;
        expect(listeningOver([], since, dayAgo, now)).toEqual({ online: 0, possible: 90 });
        expect(listeningOver([], null, dayAgo, now)).toEqual({ online: 0, possible: 0 });
    });
});

describe("a member's hours on leave", () => {
    it("leaves them out of the average, like an hour the bot missed", () => {
        const first = Date.parse("2026-08-03T00:00:00Z");
        const second = first + 7 * 24 * HOUR;
        const result = observe(
            input({
                from: new Date(first),
                to: new Date(second + HOUR),
                messagesByHour: new Map([[first, 40]]),
                excludedHours: new Set([second])
            })
        );
        // The second Monday 12:00 was leave, so it is not a zero halving the first.
        expect(result.observed[0][12]).toBe(1);
        expect(result.demand[0][12]).toBe(40);
    });

    it("drops a cell to unheard when every time it came round was leave", () => {
        const first = Date.parse("2026-08-03T00:00:00Z");
        const result = observe(
            input({
                from: new Date(first),
                to: new Date(first + HOUR),
                excludedHours: new Set([first])
            })
        );
        expect(result.observed[0][12]).toBe(0);
        expect(result.observedHours).toBe(0);
    });

    it("counts every hour a leave touches, the part hours at either end included", () => {
        const from = new Date("2026-08-03T00:00:00Z");
        const to = new Date("2026-08-04T00:00:00Z");
        const hours = hoursTouchedBy(
            [
                {
                    startDate: new Date("2026-08-03T09:30:00Z"),
                    endDate: new Date("2026-08-03T11:15:00Z")
                }
            ],
            from,
            to
        );
        expect([...hours].map((hour) => new Date(hour).toISOString())).toEqual([
            "2026-08-03T09:00:00.000Z",
            "2026-08-03T10:00:00.000Z",
            "2026-08-03T11:00:00.000Z"
        ]);
    });

    it("clips a leave to the window", () => {
        const from = new Date("2026-08-03T00:00:00Z");
        const to = new Date("2026-08-03T02:00:00Z");
        const hours = hoursTouchedBy(
            [
                {
                    startDate: new Date("2026-07-01T00:00:00Z"),
                    endDate: new Date("2026-09-01T00:00:00Z")
                }
            ],
            from,
            to
        );
        expect(hours.size).toBe(2);
    });
});

describe("a member's minutes by hour", () => {
    it("keys each hour's set minutes by its UTC start, and skips empty hours", () => {
        const bitmap = emptyBitmap();
        setMinute(bitmap, 0);
        setMinute(bitmap, 59);
        setMinute(bitmap, 23 * 60 + 30);
        const totals = minutesByUtcHour(new Map([["2026-08-03", bitmap]]));
        expect(totals).toEqual(
            new Map([
                [Date.parse("2026-08-03T00:00:00Z"), 2],
                [Date.parse("2026-08-03T23:00:00Z"), 1]
            ])
        );
    });
});

describe("where a member's grid begins", () => {
    const to = new Date("2026-08-10T00:00:00Z");

    it("starts at the first whole hour after joining, not the hour they joined in", () => {
        const joined = new Date("2026-08-05T10:45:00Z");
        expect(memberWindowStart(to, 8, joined).toISOString()).toBe("2026-08-05T11:00:00.000Z");
    });

    it("keeps a join exactly on the hour", () => {
        const joined = new Date("2026-08-05T10:00:00Z");
        expect(memberWindowStart(to, 8, joined).toISOString()).toBe("2026-08-05T10:00:00.000Z");
    });

    it("uses the lookback for somebody who joined before it", () => {
        const joined = new Date("2025-01-01T10:45:00Z");
        expect(memberWindowStart(to, 1, joined).toISOString()).toBe("2026-08-03T00:00:00.000Z");
    });

    it("never starts after the window ends", () => {
        const joined = new Date("2026-08-09T23:30:00Z");
        expect(memberWindowStart(to, 8, joined)).toEqual(to);
    });
});

describe("the load on each moderator", () => {
    const from = Date.parse("2026-08-03T00:00:00Z");
    /** Consecutive hours from Monday 12:00 in Auckland, judged for load. */
    const hours = (messages: number[], overrides: Partial<ObservationInput> = {}) =>
        observe(
            input({
                to: new Date(from + messages.length * HOUR),
                messagesByHour: new Map(messages.map((count, index) => [from + index * HOUR, count])),
                judgeLoad: true,
                ...overrides
            })
        );

    it("takes the median hour anybody spoke in as the typical one", () => {
        expect(hours([100, 400, 800]).typicalHour).toBe(400);
        expect(hours([100, 400, 800, 1000]).typicalHour).toBe(600);
        expect(hours([0, 0, 100, 400, 800]).typicalHour).toBe(400);
    });

    it("divides by the moderators on shift", () => {
        const result = hours([1200], { coverageByHour: new Map([[from, 2 * HOUR]]) });
        expect(result.load[0][12]).toBe(600);
        expect(result.uncovered[0][12]).toBe(0);
    });

    it("never divides by a sliver of shift", () => {
        // 504 messages against ninety seconds of shift used to read as 20.2k
        // per moderator, forty times worse than the same hour left empty.
        const result = hours([504], { coverageByHour: new Map([[from, 90_000]]) });
        expect(result.load[0][12]).toBe(504);
        expect(result.uncovered[0][12]).toBeCloseTo(0.975, 5);
    });

    it("measures how much of the hour nobody was on for, not whether anybody was", () => {
        expect(hours([22]).uncovered[0][12]).toBe(1);
        const half = hours([22], { coverageByHour: new Map([[from, HOUR / 2]]) });
        expect(half.uncovered[0][12]).toBe(0.5);
        const two = hours([22], { coverageByHour: new Map([[from, 2 * HOUR]]) });
        expect(two.uncovered[0][12]).toBe(0);
    });

    it("never calls an hour without messages uncovered", () => {
        expect(hours([0]).uncovered[0][12]).toBe(0);
    });

    it("judges each hour before averaging, so a staffed week never hides an empty one", () => {
        const week = 7 * 24 * HOUR;
        const result = observe(
            input({
                from: new Date(from),
                to: new Date(from + week + HOUR),
                judgeLoad: true,
                messagesByHour: new Map([
                    [from, 100],
                    [from + week, 100]
                ]),
                coverageByHour: new Map([[from, 2 * HOUR]])
            })
        );
        // Averaged first, that is one moderator on and nobody missing.
        expect(result.coverage[0][12]).toBe(1);
        expect(result.uncovered[0][12]).toBe(0.5);
        expect(result.load[0][12]).toBe(75);
    });

    it("judges nothing unless asked, which is every grid but the coverage gap", () => {
        const result = hours([100, 400, 800], { judgeLoad: false });
        expect(result.typicalHour).toBe(0);
        expect(sum(result.load)).toBe(0);
    });
});

describe("the colour step for a coverage cell", () => {
    const typical = 600;

    it("reads one moderator through a typical hour as gold, not amber", () => {
        // In the middle step, an ordinary staffed hour read as an early
        // warning on every card.
        expect(gapBand(600, 0, typical)).toBe(1);
    });

    it("climbs with the load: amber past 1.1 typical hours, brick at 1.6, burgundy at 2.2", () => {
        expect([300, 500, 600, 700, 1000, 1400].map((load) => gapBand(load, 0, typical))).toEqual([
            0, 1, 1, 2, 3, 4
        ]);
    });

    it("never draws a wholly uncovered hour below the fourth step, however quiet", () => {
        // Messages divided by coverage used to read nobody as one moderator,
        // so an empty quiet evening was the coolest colour on the grid.
        expect(gapBand(22, 1, typical)).toBe(3);
        expect(gapBand(22, 0, typical)).toBe(0);
    });

    it("lifts in proportion to the time nobody was on, so there is no cliff at half an hour", () => {
        // All or nothing at half an hour moved a cell from plain blue to red
        // for a minute of cover either side.
        const lifts = [0, 0.1, 0.3, 0.49, 0.51, 0.7, 1].map((share) => gapBand(22, share, typical));
        expect(lifts).toEqual([0, 0, 1, 1, 2, 2, 3]);
        for (let index = 1; index < lifts.length; index += 1) {
            expect(lifts[index] - lifts[index - 1]).toBeLessThanOrEqual(1);
        }
    });

    it("still ranks a busier uncovered hour above a quiet one", () => {
        expect(gapBand(400, 1, typical)).toBe(4);
        expect(gapBand(22, 1, typical)).toBeLessThan(gapBand(400, 1, typical));
    });

    it("has nothing to draw for an hour nobody spoke in", () => {
        expect(gapBand(0, 1, typical)).toBe(-1);
    });
});
