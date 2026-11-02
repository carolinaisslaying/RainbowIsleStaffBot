import { describe, expect, it } from "vitest";
import { earlierOutcomeWord, onSpreadChart } from "../src/domain/review.js";
import { chartName, spreadSvg, trendDetail, trendSvg, type TrendPoint } from "../src/render/trend.js";

/**
 * The charts are pure string functions, exported separately from the render*
 * wrappers, so these assert on markup without invoking resvg.
 */

const point = (extra: Partial<TrendPoint>): TrendPoint => ({
    label: "5 Oct",
    minutes: 66,
    exempt: false,
    requiredMinutes: 240,
    lowered: false,
    state: "red",
    word: null,
    ...extra
});
const trend = (points: TrendPoint[]) => trendSvg({ points, title: "x" });
const earlier = (extra: Partial<TrendPoint>) => point({ label: "21 Sep", word: "met", ...extra });

describe("a member's recent fortnights", () => {
    it("titles the first row as the one under review, and only that one", () => {
        const svg = trend([point({ label: "19 Oct" }), earlier({})]);
        expect(svg).toContain("This fortnight · 19 Oct");
        expect(svg).toContain(">21 Sep<");
    });

    it("holds every sub-line to one pattern", () => {
        expect(trendDetail(point({ minutes: 139 }))).toBe("139 of 240 minutes · 101 under");
        expect(trendDetail(point({ minutes: 96, requiredMinutes: 120, lowered: true }))).toBe(
            "96 of 120 minutes · 24 under · minimum lowered"
        );
        expect(trendDetail(point({ minutes: 207, word: "warned" }))).toBe(
            "207 of 240 minutes · 33 under · warned"
        );
        expect(trendDetail(point({ minutes: 453, word: "met" }))).toBe("453 of 240 minutes · met");
    });

    it("states the percentage", () => {
        expect(trend([point({})])).toContain(">28%<");
    });

    it("reads leave as exempt, never as a zero, and draws no rail", () => {
        const exempt = point({ exempt: true, minutes: 35, requiredMinutes: 0, state: "leave" });
        expect(trendDetail(exempt)).toBe("35 minutes · on leave");
        const svg = trend([exempt]);
        expect(svg).toContain(">exempt<");
        expect(svg).not.toContain("rail-fill");
        expect(svg).not.toContain("rail-track");
    });

    it("keeps an exempt row as tall as one with a rail", () => {
        const height = (extra: Partial<TrendPoint>) =>
            trend([point({}), earlier(extra)]).match(/height="(\d+)"/)?.[1];
        expect(height({ exempt: true, requiredMinutes: 0, state: "leave" })).toBe(height({}));
    });

    it("divides the row under review from earlier ones, when there are any", () => {
        expect(trend([point({})])).not.toContain("rows-divider");
        expect(trend([point({}), earlier({})]).match(/rows-divider/g)).toHaveLength(1);
        expect(trend([point({}), earlier({}), earlier({})]).match(/rows-divider/g)).toHaveLength(1);
    });

    it("lights the rail in the ring's state, stopping at full", () => {
        const svg = trend([point({ minutes: 480, state: "green" })]);
        expect(svg).toContain(">200%<");
        expect(svg).toContain("url(#rail-green)");
        expect(Number(svg.match(/class="rail-fill"[^>]*width="([\d.]+)"/)?.[1])).toBeLessThanOrEqual(460);
    });

    it("draws no rail fill at zero, and still says so", () => {
        const svg = trend([point({ minutes: 0 })]);
        expect(svg).toContain("0 of 240 minutes");
        expect(svg).not.toContain("rail-fill");
    });
});

describe("how an earlier fortnight ended", () => {
    const word = (status: string, outcome: "warned" | "excused" | "dismissed" | null, withdrawn = false) =>
        earlierOutcomeWord({ status, outcome, withdrawn });

    it("says what was decided, first", () => {
        expect(word("below", "warned")).toBe("warned");
        expect(word("below", "excused")).toBe("excused");
        expect(word("below", "dismissed")).toBe("dismissed");
    });

    it("says when a warning was taken back", () => {
        expect(word("below", "warned", true)).toBe("warned, withdrawn");
    });

    it("says met, on leave or undecided without a decision", () => {
        expect(word("met", null)).toBe("met");
        expect(word("exempt", null)).toBe("on leave");
        expect(word("below", null)).toBe("undecided");
    });
});

describe("the fortnight's spread", () => {
    const entries = [
        { name: "Ana", minutes: 400, below: false, state: "green" as const },
        { name: "Bo", minutes: 260, below: false, state: "green" as const },
        { name: "Cy", minutes: 200, below: true, state: "amber" as const },
        { name: "Di", minutes: 90, below: true, state: "red" as const },
        { name: "Ed", minutes: 0, below: true, state: "red" as const }
    ];
    const spread = (list = entries) =>
        spreadSvg({ entries: list, requiredMinutes: 240, amberPercent: 75, title: "x" });

    it("counts what it plotted", () => {
        expect(spread()).toContain("2 met the minimum and 3 did not.");
    });

    it("names and figures every column, busiest first", () => {
        const names = [...spread().matchAll(/class="spread-name"[^>]*>([^<]+)</g)].map((m) => m[1]);
        expect(names).toEqual(["Ana", "Bo", "Cy", "Di", "Ed"]);
    });

    it("gives anybody below a track and draws nothing for a zero", () => {
        const svg = spread();
        expect(svg.match(/class="spread-track"/g)).toHaveLength(3);
        // Ana, Bo and their lighter tops are four; Cy and Di two; Ed none.
        expect(svg.match(/class="spread-(fill|past)"/g)).toHaveLength(6);
    });

    it("keeps a tiny figure shorter than a larger one", () => {
        const height = (minutes: number) =>
            Number(
                spread([{ name: "a", minutes, below: true, state: "red" }]).match(
                    /height="([\d.]+)"[^>]*class="spread-fill"/
                )?.[1]
            );
        expect(height(5)).toBeLessThan(height(100));
    });

    it("stops the scale at twice the requirement and says so", () => {
        const svg = spread([{ name: "a", minutes: 3000, below: false, state: "green" }]);
        expect(svg).toContain("Bars stop at 480.");
        expect(spread()).not.toContain("Bars stop");
    });

    it("keeps the requirement labelled", () => {
        expect(spread()).toContain(">240 min</text>");
    });

    describe("somebody whose leave lowered their minimum", () => {
        const junior = {
            name: "Junior",
            minutes: 96,
            below: true,
            requiredMinutes: 120,
            state: "amber" as const
        };
        const texts = (svg: string, name: string) =>
            [...svg.matchAll(new RegExp(`class="${name}" x="([\\d.]+)"`, "g"))].map((m) =>
                Number(m[1])
            );
        const trackHeights = (svg: string) =>
            [...svg.matchAll(/height="([\d.]+)"[^>]*class="spread-track"/g)].map((m) => Number(m[1]));

        it("counts them with everybody else, the way the queue does", () => {
            expect(spread([...entries, junior])).toContain("2 met the minimum and 4 did not.");
        });

        it("draws them on a line of their own, labelled", () => {
            const svg = spread([...entries, junior]);
            expect(svg.match(/class="spread-line"/g)).toHaveLength(2);
            expect(svg).toContain(">120 min</text>");
        });

        it("draws their track up to their own line, not the main one", () => {
            const heights = trackHeights(spread([junior, entries[2]!]));
            expect(heights[0]).toBeGreaterThan(heights[1]!);
        });

        it("goes lighter past their own line, not past the main one", () => {
            const svg = spread([{ ...junior, minutes: 200, below: false, state: "green" }]);
            expect(svg).toContain('class="spread-past"');
        });

        it("sits after everybody on the full requirement, whatever the figures", () => {
            const names = [...spread([junior, ...entries]).matchAll(/class="spread-name"[^>]*>([^<]+)</g)];
            expect(names.at(-1)?.[1]).toBe("Junior");
        });

        it("keeps every line's label past every column of its group", () => {
            const svg = spread([...entries, { ...junior, minutes: 600 }]);
            const names = texts(svg, "spread-name");
            const [mainLabel, ownLabel] = texts(svg, "spread-line-label");
            expect(mainLabel).toBeGreaterThan(names.at(-2)!);
            expect(mainLabel).toBeLessThan(names.at(-1)!);
            expect(ownLabel).toBeGreaterThan(names.at(-1)!);
        });

        it("says they had leave, and says nothing when nobody did", () => {
            expect(spread([...entries, junior])).toContain(">had leave</text>");
            expect(spread()).not.toContain("had leave");
        });

        it("says it under each name while there is room", () => {
            const pair = [junior, { ...junior, name: "Rua" }];
            expect(spread(pair).match(/class="spread-note"/g)).toHaveLength(2);
        });

        it("says it once when it would run into the next name", () => {
            const crowd = Array.from({ length: 11 }, (_, i) => ({ ...entries[0]!, name: `m${i}` }));
            const pair = [junior, { ...junior, name: "Rua" }];
            expect(spread([...crowd, ...pair]).match(/class="spread-note"/g)).toHaveLength(1);
        });
    });

    it("shows no padlock on a hidden member", () => {
        expect(spread()).not.toContain("🔒");
    });

    it("cuts a long name to its column", () => {
        const svg = spread([
            { name: "SOCIAL SOCIALIST", minutes: 10, below: true, state: "red" }
        ]);
        expect(svg).toContain("…");
        expect(svg).not.toContain("SOCIAL SOCIALIST");
    });

    it("drops names and figures when they no longer fit", () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            name: `m${i}`,
            minutes: i,
            below: true,
            state: "red" as const
        }));
        expect(spread(many)).not.toContain("spread-name");
    });

    it("says so in words when nobody was assessed", () => {
        expect(spread([])).toContain("Nobody was assessed");
    });
});

describe("a name on the chart", () => {
    it("loses what the fonts cannot draw", () => {
        expect(chartName("🌙 Reese")).toBe("Reese");
        expect(chartName("ᛉ swocks")).toBe("swocks");
    });

    it("keeps ordinary punctuation", () => {
        expect(chartName("Mary-Jane O'Neil")).toBe("Mary-Jane O'Neil");
    });

    it("never comes out empty", () => {
        expect(chartName("🌙")).toBe("?");
    });
});

describe("who the chart draws", () => {
    it("leaves out Executives excluded from the queue", () => {
        expect(onSpreadChart({ status: "below", excludedAsExecutive: true })).toBe(false);
        expect(onSpreadChart({ status: "met", excludedAsExecutive: true })).toBe(false);
    });

    it("draws Executives when they are being reviewed", () => {
        expect(onSpreadChart({ status: "below", excludedAsExecutive: false })).toBe(true);
    });

    it("draws anybody something was asked of, and only them", () => {
        expect(onSpreadChart({ status: "below" })).toBe(true);
        expect(onSpreadChart({ status: "met" })).toBe(true);
        expect(onSpreadChart({ status: "exempt" })).toBe(false);
    });
});
