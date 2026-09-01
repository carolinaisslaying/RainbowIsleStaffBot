import { describe, expect, it } from "vitest";
import { heatmapSvg } from "../src/render/heatmap.js";
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
        timeZone: "Pacific/Auckland",
        weekStartDay: 1,
        weeks: 4,
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-29T00:00:00Z"),
        maxRatio: Math.max(0, ...ratio.flat())
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
