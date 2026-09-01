import { describe, expect, it } from "vitest";
import { spreadSvg, trendSvg } from "../src/render/trend.js";

/**
 * The charts are pure string functions, exported separately from the render*
 * wrappers, so these assert on markup without invoking resvg.
 *
 * What matters here is that the requirement line is always on the scale and
 * always labelled: it is the only thing carrying met-versus-below, which is
 * deliberate. Red against green is ΔE 7.9 under deuteranopia, so colour is not
 * allowed to be the encoding, and geometry has to be.
 */

/** Only the data marks: the panel draws rects of its own that are not bars. */
const BAR = /<rect[^>]*height="([\d.]+)"[^>]*fill="(?:#2e9fb8|#5ed0e6|rgba\(255,255,255,0\.13\))"/g;

/** The requirement line, which is the only dashed line either chart draws. */
const RULE = /<line[^>]*y1="([\d.]+)"[^>]*stroke-dasharray/;

const points = [
    { label: "9 Jun", minutes: 310, exempt: false, current: false },
    { label: "23 Jun", minutes: 0, exempt: true, current: false },
    { label: "18 Aug", minutes: 40, exempt: false, current: true }
];

describe("a member's recent fortnights", () => {
    it("keeps the requirement line on the scale even when everybody missed it", () => {
        // A chart scaled to the data alone puts the line off the top whenever
        // the whole history is below it, which is exactly when it is needed.
        const svg = trendSvg({ points, requiredMinutes: 240, title: "x" });
        const line = svg.match(/stroke-dasharray="5 4"[^>]*\/>/);
        expect(line).not.toBeNull();
        expect(svg).toContain("240 min required");
    });

    it("keeps the line on the scale when one fortnight dwarfs it", () => {
        const svg = trendSvg({
            points: [{ label: "a", minutes: 5000, exempt: false, current: true }],
            requiredMinutes: 240,
            title: "x"
        });
        const y = Number(svg.match(RULE)?.[1]);
        // Still inside the plot rather than flattened onto the baseline.
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(200);
    });

    it("draws leave as an absence, never as a zero", () => {
        // A zero-height bar for a fortnight somebody was away says they earned
        // nothing, which is the opposite of what an exemption means.
        expect(trendSvg({ points, requiredMinutes: 240, title: "x" })).toContain(">leave<");
    });

    it("labels only the fortnight being decided", () => {
        const svg = trendSvg({ points, requiredMinutes: 240, title: "x" });
        expect(svg).toContain(">40<");
        expect(svg).not.toContain(">310<");
    });

    it("still draws a visible mark when every fortnight is zero", () => {
        // The all-zero case is the one that used to render as an empty axis and
        // read as a broken image.
        const svg = trendSvg({
            points: [
                { label: "a", minutes: 0, exempt: false, current: false },
                { label: "b", minutes: 0, exempt: false, current: true }
            ],
            requiredMinutes: 240,
            title: "x"
        });
        const heights = [...svg.matchAll(BAR)].map((match) => Number(match[1]));
        expect(heights).toHaveLength(2);
        expect(heights.every((height) => height >= 2)).toBe(true);
    });

    it("says so in words when there is nothing to compare", () => {
        const svg = trendSvg({ points: [], requiredMinutes: 240, title: "x" });
        expect(svg).toContain("No earlier fortnight");
        expect(svg).not.toContain("stroke-dasharray");
    });

    it("uses one hue, so no verdict is carried by colour", () => {
        // Nothing red and nothing green: the dashed line says which side of the
        // requirement a bar is on, and that survives greyscale and CVD.
        const svg = trendSvg({ points, requiredMinutes: 240, title: "x" });
        expect(svg).not.toMatch(/#ff453a|#30d158|#ff9f0a/i);
    });
});

describe("the fortnight's spread", () => {
    const entries = [
        { minutes: 400, below: false },
        { minutes: 260, below: false },
        { minutes: 90, below: true }
    ];

    it("counts what it plotted", () => {
        expect(spreadSvg({ entries, requiredMinutes: 240, title: "x" })).toContain(
            "3 assessed, 1 below the line"
        );
    });

    it("sorts descending, so the shape reads as a distribution", () => {
        const svg = spreadSvg({ entries, requiredMinutes: 240, title: "x" });
        const heights = [...svg.matchAll(BAR)].map((match) => Number(match[1]));
        expect(heights).toHaveLength(3);
        expect(heights).toEqual([...heights].sort((left, right) => right - left));
    });

    it("says so in words when nobody was assessed", () => {
        expect(spreadSvg({ entries: [], requiredMinutes: 240, title: "x" })).toContain(
            "Nobody was assessed"
        );
    });

    it("never colours a shortfall red", () => {
        // Below the line is drawn as an absence. A red bar would be the bot
        // expressing a verdict the Executive has not reached yet.
        expect(spreadSvg({ entries, requiredMinutes: 240, title: "x" })).not.toMatch(
            /#ff453a/i
        );
    });
});
