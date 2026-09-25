import { describe, expect, it } from "vitest";
import {
    gapLine,
    heatmapSvg,
    memberEmptyNote,
    reliabilityNote,
    scaleTop
} from "../src/render/heatmap.js";
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
        // Copies, so a test can set messages and load apart.
        load: ratio.map((row) => [...row]),
        uncovered: ratio.map((row) => row.map(() => 0)),
        unstaffed: ratio.map((row) => row.map(() => false)),
        severity: ratio.map((row) => row.map((value) => (value > 0 ? 0 : -1))),
        typicalHour: 0,
        observed: ratio.map((row) => row.map(() => 4)),
        timeZone: "Pacific/Auckland",
        weekStartDay: 1,
        observedHours: 4 * 168,
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-29T00:00:00Z"),
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

    it("prints each figure in whichever ink out-contrasts its step", () => {
        // Dark on the three light steps (9.6, 7.4 and 5.5:1), white on brick
        // and burgundy (4.9 and 7.7:1, where dark managed 3.8 and 2.5).
        const input = grid(zeros());
        [0, 1, 2, 3, 4].forEach((step, hour) => {
            input.demand[0][hour] = 100;
            input.load[0][hour] = 100;
            input.severity[0][hour] = step;
        });
        const inks = [...heatmapSvg(input).matchAll(/fill="([^"]+)" font-size="9.5"/g)].map(
            (match) => match[1]
        );
        expect(inks).toEqual([
            "rgba(0,0,0,0.82)",
            "rgba(0,0,0,0.82)",
            "rgba(0,0,0,0.82)",
            "#ffffff",
            "#ffffff"
        ]);
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

describe("the coverage reading", () => {
    const filled = (svg: string) =>
        [...svg.matchAll(/height="27" rx="7" fill="(#[0-9a-f]{6})"/g)].map((match) => match[1]);
    const rings = (svg: string) => [...svg.matchAll(/stroke="#111216"/g)].length;

    /** One cell at Monday 00:00 with the given load and step. */
    function one(load: number, severity: number, unstaffed: boolean): CoverageGrid {
        const input = grid(zeros());
        input.demand[0][0] = load;
        input.load[0][0] = load;
        input.severity[0][0] = severity;
        input.unstaffed[0][0] = unstaffed;
        input.typicalHour = 600;
        return input;
    }

    it("colours each cell by the step it was given, never by its own scale", () => {
        const input = grid(zeros());
        [0, 1, 2, 3, 4].forEach((step, hour) => {
            input.demand[0][hour] = 100;
            input.load[0][hour] = 100;
            input.severity[0][hour] = step;
        });
        expect(filled(heatmapSvg(input))).toEqual([
            "#86df9a",
            "#d0a83e",
            "#d27c02",
            "#c14b24",
            "#9a273a"
        ]);
    });

    it("prints the messages each moderator carried", () => {
        expect(heatmapSvg(one(540, 2, false))).toContain(">540<");
    });

    it("rings an hour nobody was on shift for, and keys the ring only when there is one", () => {
        const empty = heatmapSvg(one(22, 3, true));
        expect(rings(empty)).toBe(2); // the cell and its key
        expect(empty).toContain("nobody on for most of the hour");

        const staffed = heatmapSvg(one(22, 0, false));
        expect(rings(staffed)).toBe(0);
        expect(staffed).not.toContain("nobody on for most");
    });

    it("labels itself as load per moderator, against the typical hour", () => {
        const svg = heatmapSvg(one(540, 2, false));
        expect(svg).toContain("Messages per moderator on shift.");
        expect(svg).toContain("A typical hour here is 600 messages.");
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

/** One member reading in each of the five bands of the 0 to 60 minute scale. */
function memberBanded(): CoverageGrid {
    const minutes = zeros();
    [6, 18, 30, 42, 54].forEach((value, hour) => (minutes[0][hour] = value));
    return grid(minutes);
}

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
        expect(filled).toEqual(["#035160"]);
    });

    it("labels itself in minutes out of sixty", () => {
        const svg = heatmapSvg(banded(), "member");
        expect(svg).toContain("Average activity minutes per hour, out of 60.");
        expect(svg).toContain("1 to 60 minutes");
    });

    it("is one hue, dim to bright, and never the status colours the server cards use", () => {
        const svg = heatmapSvg(memberBanded(), "member");
        const filled = [...svg.matchAll(/height="27" rx="7" fill="(#[0-9a-f]{6})"/g)].map(
            (match) => match[1]
        );
        expect(filled).toEqual(["#035160", "#0b758a", "#169cb7", "#4ec2de", "#8fe7fe"]);
        for (const status of ["#86df9a", "#d0a83e", "#d27c02", "#c14b24", "#9a273a"]) {
            expect(svg).not.toContain(status);
        }
    });

    it("prints light figures on the dim steps and dark ones on the bright", () => {
        const svg = heatmapSvg(memberBanded(), "member");
        const inks = [...svg.matchAll(/fill="([^"]+)" font-size="9.5"/g)].map((match) => match[1]);
        expect(inks).toEqual([
            "#ffffff",
            "#ffffff",
            "rgba(0,0,0,0.82)",
            "rgba(0,0,0,0.82)",
            "rgba(0,0,0,0.82)"
        ]);
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

describe("a member's card with nothing to plot", () => {
    it("says a window that was all leave was leave, not that they did nothing", () => {
        const note = memberEmptyNote("Sam", 0, 1344, 1344);
        expect(note).toBe(
            "_Sam was on leave for the whole of this window, so there is nothing to average._"
        );
        expect(note).not.toContain("No activity");
        expect(note).not.toContain("come round");
    });

    it("says what the rest was when leave and an outage covered the window between them", () => {
        const note = memberEmptyNote("Sam", 0, 100, 168);
        expect(note).toContain("on leave for 100 hours of this window");
        expect(note).toContain("not listening for the rest");
    });

    it("says no activity when the hours were heard, with the leave and the caveat beneath", () => {
        const note = memberEmptyNote("Sam", 5, 3, 8);
        expect(note).toContain("_No activity minutes recorded for Sam in this window._");
        expect(note).toContain("-# 3 hours on leave left out of the averages.");
        expect(note).toContain("dashed ones were on leave or not heard");
    });

    it("leaves the server cards' wording alone", () => {
        expect(reliabilityNote(5)).toContain("have not come round yet");
        expect(reliabilityNote(5, "member")).toContain("were on leave or not heard");
    });
});

describe("the server activity reading's colours", () => {
    it("is the same one-hue ramp as a member's, not the coverage gap's", () => {
        const input = memberBanded();
        const svg = heatmapSvg(input, "activity");
        const filled = [...svg.matchAll(/height="27" rx="7" fill="(#[0-9a-f]{6})"/g)].map(
            (match) => match[1]
        );
        expect(new Set(filled)).toEqual(
            new Set(["#035160", "#0b758a", "#169cb7", "#4ec2de", "#8fe7fe"])
        );
        expect(svg).not.toContain("#9a273a");
    });

    it("leaves the coverage gap on its leaf-to-burgundy ramp", () => {
        expect(heatmapSvg(banded(), "coverage")).toContain('fill="#86df9a"');
    });
});

describe("the legend", () => {
    it("gives zero a grey swatch of its own on every kind, before the ramp", () => {
        for (const kind of ["coverage", "activity", "member"] as const) {
            const svg = heatmapSvg(banded(), kind);
            const swatch = svg.match(
                /<rect x="(\d+)" y="[\d.]+" width="18" height="9" rx="4.5" fill="rgba\(255,255,255,0.045\)"/
            );
            expect(swatch, kind).not.toBeNull();
            expect(svg).toMatch(/font-size="10.5" font-family="[^"]+">0<\/text>/);
            const barX = Number(svg.match(/<clipPath id="rampClip"><rect x="(\d+)"/)?.[1]);
            expect(barX).toBeGreaterThan(Number(swatch?.[1]));
        }
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

describe("one of the worst hours, in words", () => {
    const cell = (demand: number, coverage: number, uncovered: number) => ({
        weekday: 0,
        hour: 0,
        demand,
        coverage,
        load: demand / Math.max(1, coverage),
        uncovered,
        unstaffed: uncovered > 0.5,
        severity: 4
    });

    it("says nobody was on shift for an hour nobody covered", () => {
        expect(gapLine(cell(581, 0, 1))).toBe("581 messages an hour, **nobody on shift**");
    });

    it("never divides by a fraction of a moderator, even in words", () => {
        // "504 messages an hour across 0.0 moderators: 504 each" was on the
        // card for an hour with ninety seconds of cover.
        const line = gapLine(cell(504, 0.025, 0.975));
        expect(line).toBe("504 messages an hour, **nobody on for 59 min** of it");
        expect(line).not.toContain("moderators");
        expect(line).not.toContain("each");
    });

    it("gives the share each moderator carried once there was at least one", () => {
        expect(gapLine(cell(1173, 1.11, 0))).toBe(
            "1173 messages an hour across 1.1 moderators: **1057 each**"
        );
    });

    it("counts at least a minute for a gap that rounds to nothing", () => {
        expect(gapLine(cell(300, 0.995, 0.005))).toBe(
            "300 messages an hour, **nobody on for 1 min** of it"
        );
    });
});

describe("the chart's title", () => {
    const title = (svg: string) => svg.match(/letter-spacing="-0.2">([^<]+)</)?.[1];

    it("names its zone, how much data and which dates, so it stands alone when forwarded", () => {
        expect(title(heatmapSvg(banded()))).toBe("Pacific/Auckland, 4 week mean, 1 Aug to 29 Aug");
    });

    it("dates the window in the chart's own zone, so the days match the rows", () => {
        // In UTC this window is 23 to 24 September; the Auckland grid it is
        // drawn on has Friday the 25th in it. The card used to print the first
        // above the second.
        const input = banded();
        input.from = new Date("2026-09-23T07:00:00Z");
        input.to = new Date("2026-09-24T23:00:00Z");
        input.observedHours = 40;
        expect(title(heatmapSvg(input))).toBe("Pacific/Auckland, 1 day of data, 23 Sep to 25 Sep");
    });

    it("dates an empty window too", () => {
        expect(heatmapSvg(grid(zeros()))).toContain("1 Aug to 29 Aug");
    });

    it("leaves the dates out of a window with no length", () => {
        const input = banded();
        input.to = input.from;
        expect(title(heatmapSvg(input))).toBe("Pacific/Auckland, 4 week mean");
    });
});
