import { describe, expect, it } from "vitest";
import { heatmapSvg, scaleTop } from "../src/render/heatmap.js";
import type { CoverageGrid } from "../src/services/coverageService.js";

/**
 * The heatmap is a pure function of a grid, so it needs no database and no
 * Discord. Everything here is about the picture: its margins, its empty state
 * and the legibility of the figure printed in each cell.
 */

function grid(ratio: number[][]): CoverageGrid {
    return {
        coverage: ratio.map((row) => row.map(() => 1)),
        demand: ratio,
        ratio,
        observed: ratio.map((row) => row.map(() => 4)),
        timeZone: "Pacific/Auckland",
        weekStartDay: 1,
        observedHours: 4 * 168,
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-29T00:00:00Z"),
        maxRatio: Math.max(0, ...ratio.flat()),
        maxDemand: Math.max(0, ...ratio.flat())
    };
}

const zeros = () => Array.from({ length: 7 }, () => Array(24).fill(0));

/** A grid with one reading in each of the five bands, and the rest empty. */
function banded(): CoverageGrid {
    const ratio = zeros();
    for (let index = 0; index < 5; index += 1) {
        ratio[0][index] = 0.5 + index * 2.4; // 0.5, 2.9, 5.3, 7.7, 10.1 against 10.1
    }
    return grid(ratio);
}

const PAD = 22;
const CELL = 30;
const WIDTH = PAD + 26 + 24 * CELL + PAD;

describe("heatmap margins", () => {
    it("leaves the same margin on the left and the right of the grid", () => {
        const svg = heatmapSvg(banded());
        expect(svg).toContain(`width="${WIDTH}"`);

        const cellXs = [
            ...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="27" height="27"/g)
        ].map((match) => Number(match[1]));
        // Cells are inset 1.5 inside their own 30 wide slot.
        const left = Math.min(...cellXs) - 1.5;
        const right = Math.max(...cellXs) + 27 + 1.5;
        expect(left).toBe(PAD + 26);
        expect(WIDTH - right).toBe(PAD);
    });

    it("keeps the weekday labels inside the margin", () => {
        const svg = heatmapSvg(banded());
        const labelXs = [...svg.matchAll(/<text x="(\d+)" y="[\d.]+" fill="#9b9ea6"/g)].map(
            (match) => Number(match[1])
        );
        expect(Math.min(...labelXs)).toBeGreaterThanOrEqual(PAD);
    });
});

describe("what a cell says", () => {
    it("prints the reading in every cell that has one, and in none that does not", () => {
        const svg = heatmapSvg(banded());
        const figures = [...svg.matchAll(/font-weight="bold" text-anchor="middle">([\d.]+)</g)];
        expect(figures).toHaveLength(5);
    });

    it("uses one ink on every band, because dark out-contrasts light on all five", () => {
        // Black on the ramp's blue is 5.7:1; white on it is 3.7:1. The figures
        // are 9.5px and bold, where contrast beats every other consideration,
        // so the fix for the cool end of the ramp is a darker ink, not a light
        // one.
        const svg = heatmapSvg(banded());
        const inks = new Set(
            [...svg.matchAll(/fill="([^"]+)" font-size="9.5"/g)].map((match) => match[1])
        );
        expect(inks).toEqual(new Set(["rgba(0,0,0,0.82)"]));
    });
});

describe("an empty window", () => {
    it("says so in words rather than drawing 168 empty boxes", () => {
        const svg = heatmapSvg(grid(zeros()));
        expect(svg).toContain("No demand recorded");
        expect(svg).toContain("Nothing to plot yet.");
        expect(svg).not.toContain('height="27"');
    });

    it("still names the window it found nothing in", () => {
        const svg = heatmapSvg(grid(zeros()));
        expect(svg).toContain("Pacific/Auckland");
        expect(svg).toContain("4 week mean");
    });
});

describe("the panel under the grid", () => {
    it("is the same glass as the ring card's, and is never blurred", () => {
        for (const svg of [heatmapSvg(banded()), heatmapSvg(grid(zeros()))]) {
            expect(svg).toContain("url(#panelGround)");
            expect(svg).toContain("url(#panelSheen)");
            expect(svg).toContain("url(#panelRim)");
            expect(svg).not.toContain("feGaussianBlur");
        }
    });
});

describe("hours not heard yet", () => {
    it("draws them dashed, apart from quiet hours, and says what dashed means", () => {
        const input = banded();
        input.observed = input.observed.map((row, weekday) =>
            row.map((times) => (weekday === 6 ? 0 : times))
        );
        const svg = heatmapSvg(input);
        expect([...svg.matchAll(/stroke-dasharray="3 3"/g)]).toHaveLength(24);
        expect(svg).toContain("Dashed hours have not been heard yet.");
    });

    it("does not mention dashes when every hour has been heard", () => {
        expect(heatmapSvg(banded())).not.toContain("Dashed");
    });
});

describe("the activity reading", () => {
    it("plots messages rather than the ratio, and labels itself so", () => {
        const input = banded();
        input.demand = input.demand.map((row) => row.map((value) => value * 100));
        const svg = heatmapSvg(input, "activity");
        expect(svg).toContain("Average messages per hour.");
        expect(svg).toContain("quiet to busiest");
        expect(svg).toContain(">1.0k<");
    });

    it("says no messages rather than no demand when empty", () => {
        const svg = heatmapSvg(grid(zeros()), "activity");
        expect(svg).toContain("No messages recorded");
    });
});

describe("the member reading", () => {
    it("scales to the whole hour, so the same minutes are the same colour on every card", () => {
        const light = grid(zeros());
        light.demand[0][0] = 6; // a tenth of the hour, and this member's busiest
        // Against 60 minutes that is the bottom band; scaled to their own
        // busiest cell it would have been the top one.
        const svg = heatmapSvg(light, "member");
        const filled = [...svg.matchAll(/height="27" rx="7" fill="(#[0-9a-f]{6})"/g)].map(
            (match) => match[1]
        );
        expect(filled).toEqual(["#0a84ff"]);
    });

    it("labels itself in minutes out of sixty", () => {
        const svg = heatmapSvg(banded(), "member");
        expect(svg).toContain("Average activity minutes per hour, out of 60.");
        expect(svg).toContain("0 to 60 minutes");
    });

    it("says dashed hours may be leave", () => {
        const input = banded();
        input.observed[6] = input.observed[6].map(() => 0);
        expect(heatmapSvg(input, "member")).toContain("Dashed hours were on leave or not heard.");
    });

    it("says no activity when empty", () => {
        expect(heatmapSvg(grid(zeros()), "member")).toContain("No activity recorded");
    });
});

describe("the colour scale", () => {
    it("tops out at the 95th percentile so one spike does not wash the rest out", () => {
        const values = [...Array.from({ length: 99 }, () => 10), 1000];
        expect(scaleTop(values)).toBe(10);
    });

    it("is the largest reading when there are too few to trim", () => {
        expect(scaleTop([1, 2, 3])).toBe(3);
        expect(scaleTop([0, 0])).toBe(0);
    });
});
