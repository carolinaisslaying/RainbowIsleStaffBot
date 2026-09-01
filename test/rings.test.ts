import { describe, expect, it } from "vitest";
import { ringStateFor } from "../src/domain/rings.js";
import { ringsSvg, describeRings } from "../src/render/rings.js";

const base = { weeklyTargetMinutes: 120, amberThresholdPercent: 75, onLeave: false };

describe("ring state thresholds", () => {
    it("is red below the amber threshold", () => {
        // 74 percent of 120 is 88.8 minutes; 88 is below, 89 is not.
        expect(ringStateFor({ ...base, activityMinutes: 0 })).toBe("red");
        expect(ringStateFor({ ...base, activityMinutes: 88 })).toBe("red");
    });

    it("is amber exactly at the threshold", () => {
        expect(ringStateFor({ ...base, activityMinutes: 90 })).toBe("amber"); // 75%
    });

    it("is amber at 99 percent and green at 100", () => {
        expect(ringStateFor({ ...base, activityMinutes: 119 })).toBe("amber");
        expect(ringStateFor({ ...base, activityMinutes: 120 })).toBe("green");
    });

    it("stays green above 100 percent", () => {
        expect(ringStateFor({ ...base, activityMinutes: 121 })).toBe("green");
        expect(ringStateFor({ ...base, activityMinutes: 2400 })).toBe("green");
    });

    it("checks the boundary percentages directly", () => {
        const at = (percent: number) =>
            ringStateFor({
                ...base,
                weeklyTargetMinutes: 100,
                activityMinutes: percent
            });
        expect(at(74)).toBe("red");
        expect(at(75)).toBe("amber");
        expect(at(99)).toBe("amber");
        expect(at(100)).toBe("green");
        expect(at(101)).toBe("green");
    });

    it("honours a different amber threshold from config", () => {
        expect(ringStateFor({ ...base, amberThresholdPercent: 50, activityMinutes: 60 })).toBe("amber");
        expect(ringStateFor({ ...base, amberThresholdPercent: 50, activityMinutes: 59 })).toBe("red");
    });

    it("greys out on leave regardless of the figures, and never reds", () => {
        expect(ringStateFor({ ...base, activityMinutes: 0, onLeave: true })).toBe("leave");
        expect(ringStateFor({ ...base, activityMinutes: 500, onLeave: true })).toBe("leave");
    });

    it("treats a zero target as met rather than dividing by zero", () => {
        expect(ringStateFor({ ...base, weeklyTargetMinutes: 0, activityMinutes: 0 })).toBe("green");
    });
});

describe("ring rendering", () => {
    const input = {
        activityMinutes: 104,
        activityTarget: 120,
        shiftHours: 6,
        shiftTarget: 8,
        activeDays: 3,
        activeDaysTarget: 4,
        state: "amber" as const,
        softRingsEnabled: true
    };

    it("emits three tracks plus three progress arcs when soft rings are on", () => {
        const svg = ringsSvg(input);
        expect(svg.match(/<circle/g)?.length).toBe(3); // three tracks, no ring complete
        expect(svg.match(/<path/g)?.length).toBe(3);
    });

    it("draws the outer ring alone at the same diameter when soft rings are off", () => {
        const svg = ringsSvg({ ...input, softRingsEnabled: false });
        expect(svg.match(/<circle/g)?.length).toBe(1);
        expect(svg).toContain('width="200" height="200"');
        expect(ringsSvg(input)).toContain('width="200" height="200"');
    });

    it("draws a complete ring as a circle, not a zero length arc", () => {
        const svg = ringsSvg({
            ...input,
            activityMinutes: 120,
            softRingsEnabled: false,
            state: "green"
        });
        expect(svg.match(/<circle/g)?.length).toBe(2); // track plus filled ring
        expect(svg.match(/<path/g) ?? []).toHaveLength(0);
    });

    it("adds one lighter overlay arc for overachievement", () => {
        const svg = ringsSvg({
            ...input,
            activityMinutes: 180, // 150 percent
            softRingsEnabled: false,
            state: "green"
        });
        expect(svg.match(/<path/g)?.length).toBe(1);
    });

    it("draws a full extra lap as a circle, since a 360 degree arc draws nothing", () => {
        const svg = ringsSvg({
            ...input,
            activityMinutes: 240, // exactly 200 percent
            softRingsEnabled: false,
            state: "green"
        });
        // Track, completed first lap, and the overlay lap: three circles, no arc.
        expect(svg.match(/<circle/g)?.length).toBe(3);
        expect(svg.match(/<path/g) ?? []).toHaveLength(0);
    });

    it("caps the overlay at one extra revolution", () => {
        // Geometry only. The <title> and the centre readout both quote the raw
        // figures and are expected to differ; the claim is about the arcs.
        const geometry = (svg: string) =>
            svg.replace(/<title>[\s\S]*?<\/title>/, "").replace(/<text[\s\S]*?<\/text>/g, "");
        const wild = ringsSvg({
            ...input,
            activityMinutes: 12_000,
            softRingsEnabled: false,
            state: "green"
        });
        const twice = ringsSvg({
            ...input,
            activityMinutes: 240,
            softRingsEnabled: false,
            state: "green"
        });
        expect(geometry(wild)).toBe(geometry(twice));
    });

    it("always states the numbers alongside the colour", () => {
        expect(describeRings(input)).toBe(
            "104 of 120 activity minutes, 6 of 8 shift hours, 3 of 4 active days"
        );
        expect(describeRings({ ...input, softRingsEnabled: false })).toBe(
            "104 of 120 activity minutes"
        );
    });
});

describe("ring legibility", () => {
    const base = {
        activityMinutes: 0,
        activityTarget: 120,
        shiftHours: 0,
        shiftTarget: 8,
        activeDays: 0,
        activeDaysTarget: 4,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("still draws three tracks when everything is at zero", () => {
        // An empty ring must read as empty, not as broken.
        const svg = ringsSvg(base);
        expect(svg.match(/<circle/g)?.length).toBe(3);
        expect(svg.match(/<path/g) ?? []).toHaveLength(0);
    });

    it("puts the outer figure in the centre so a zero ring still says something", () => {
        expect(ringsSvg(base)).toContain(">0%</text>");
        expect(ringsSvg({ ...base, activityMinutes: 104, state: "amber" })).toContain(
            ">87%</text>"
        );
    });

    it("uses one neutral track for every ring rather than a dark tint each", () => {
        // Whatever the track colour is, all three rings must share it: the old
        // per-ring tints are what made an empty card look like a dark smudge.
        const strokes = [...ringsSvg(base).matchAll(/stroke="(#[0-9a-f]{6})"/gi)].map(
            (match) => match[1]
        );
        expect(strokes).toHaveLength(3);
        expect(new Set(strokes).size).toBe(1);
    });

    it("names a font the runtime image actually installs", () => {
        expect(ringsSvg(base)).toContain("DejaVu Sans");
    });

    it("ends progress arcs on the exact angle, with no rounded overhang", () => {
        const svg = ringsSvg({ ...base, activityMinutes: 60, state: "red" });
        expect(svg).toContain('stroke-linecap="butt"');
        expect(svg).not.toContain('stroke-linecap="round"');
    });
});
