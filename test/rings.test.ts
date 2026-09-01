import { describe, expect, it } from "vitest";
import { ringStateFor } from "../src/domain/rings.js";
import { ringCardSvg, ringsSvg, describeRings } from "../src/render/rings.js";
import { cappedArcPath, capAngle, polarToCartesian } from "../src/render/svg.js";

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

/** Elements the renderer labels, so tests can name parts rather than count tags. */
function parts(svg: string, className: string): string[] {
    return [...svg.matchAll(new RegExp(`<(\\w+) class="${className}"[^>]*>`, "g"))].map(
        (match) => match[0]
    );
}

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
        expect(parts(svg, "ring-track")).toHaveLength(3);
        expect(parts(svg, "ring-progress")).toHaveLength(3);
    });

    it("draws the outer ring alone at the same diameter when soft rings are off", () => {
        const svg = ringsSvg({ ...input, softRingsEnabled: false });
        expect(parts(svg, "ring-track")).toHaveLength(1);
        expect(svg).toContain('width="200" height="200"');
        expect(ringsSvg(input)).toContain('width="200" height="200"');
    });

    it("draws a complete ring as a circle, not a zero length arc", () => {
        // An SVG arc sweeping a whole turn has coincident endpoints and renders
        // as nothing, so a finished ring has to become a circle.
        const svg = ringsSvg({
            ...input,
            activityMinutes: 120,
            softRingsEnabled: false,
            state: "green"
        });
        expect(parts(svg, "ring-progress")[0]).toMatch(/^<circle/);
    });

    it("adds one lighter overlay arc for overachievement", () => {
        const svg = ringsSvg({
            ...input,
            activityMinutes: 180, // 150 percent
            softRingsEnabled: false,
            state: "green"
        });
        expect(parts(svg, "ring-overlay")).toHaveLength(1);
        expect(parts(svg, "ring-overlay")[0]).toMatch(/^<path/);
    });

    it("draws a full extra lap as a circle, since a 360 degree arc draws nothing", () => {
        const svg = ringsSvg({
            ...input,
            activityMinutes: 240, // exactly 200 percent
            softRingsEnabled: false,
            state: "green"
        });
        expect(parts(svg, "ring-progress")[0]).toMatch(/^<circle/);
        expect(parts(svg, "ring-overlay")[0]).toMatch(/^<circle/);
    });

    it("caps the overlay at one extra revolution", () => {
        // The claim is about the rings alone. The readout quotes the raw figure
        // and is expected to differ, as is the lens it sits on, which is sized
        // from the length of that figure.
        const rings = (svg: string) =>
            ["ring-track", "ring-progress", "ring-overlay"]
                .flatMap((name) => parts(svg, name))
                .join("|");
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
        expect(rings(wild)).toBe(rings(twice));
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
        expect(parts(svg, "ring-track")).toHaveLength(3);
        expect(parts(svg, "ring-progress")).toHaveLength(0);
    });

    it("puts the outer figure in the centre so a zero ring still says something", () => {
        expect(ringsSvg(base)).toContain(">0%</text>");
        expect(ringsSvg({ ...base, activityMinutes: 104, state: "amber" })).toContain(
            ">87%</text>"
        );
    });

    it("gives each ring a track in its own colour, dimmed", () => {
        // This reverses an older rule that made all three tracks one neutral
        // grey, because per-ring tints "made an empty card look like a dark
        // smudge". They did, on the mid-dark panel of the time. The panel is
        // near black now, which is what the Watch puts its rings on, and at
        // that contrast a dimmed tint of each ring's own colour reads as three
        // distinct empty rings rather than as one grey bullseye.
        const tracks = parts(ringsSvg(base), "ring-track");
        const strokes = tracks.map((element) => /stroke="([^"]+)"/.exec(element)?.[1]);
        expect(strokes).toEqual(["#ff453a", "#0a84ff", "#bf5af2"]);

        // Dimmed by opacity rather than by mixing a darker colour, so an empty
        // ring is unmistakably the same hue as the one that will fill it.
        for (const track of tracks) {
            expect(track).toContain('stroke-opacity="0.19"');
        }
    });

    it("draws a ring as a track and an arc, and nothing else", () => {
        // The whole failure of the previous design: nine strokes per ring, so
        // three rings were twenty-seven concentric circles and read as a camera
        // lens. A ring at rest is one circle; a ring in progress is two.
        const empty = ringsSvg({ ...base, softRingsEnabled: false });
        expect(empty.match(/<circle|<path/g)).toHaveLength(1);

        const running = ringsSvg({
            ...base,
            activityMinutes: 60,
            softRingsEnabled: false
        });
        expect(running.match(/<circle|<path/g)).toHaveLength(2);
    });

    it("keeps the readout inside the hole it sits in", () => {
        // The centre hole is 55 across. Four characters at the two digit size
        // overlap the innermost ring.
        expect(ringsSvg({ ...base, activityMinutes: 60 })).toContain('font-size="26"');
        expect(ringsSvg({ ...base, activityMinutes: 120 })).toContain('font-size="20"');
        expect(ringsSvg({ ...base, activityMinutes: 1_200 })).toContain('font-size="15"');
    });

    it("lets leave recede into grey", () => {
        const away = ringsSvg({
            ...base,
            activityMinutes: 104,
            shiftHours: 6,
            activeDays: 3,
            state: "leave"
        });
        expect(parts(away, "ring-progress")).toHaveLength(3);
        // No ring keeps its own hue while the member is away.
        for (const colour of ["#ff453a", "#0a84ff", "#bf5af2"]) {
            expect(away).not.toContain(colour);
        }
    });

    it("names a font the runtime image actually installs", () => {
        expect(ringsSvg(base)).toContain("DejaVu Sans");
        expect(ringsSvg(base)).toContain("Inter");
    });
});

describe("round caps that still land on the figure", () => {
    // A round cap is a semicircle of half the stroke width stuck on each end,
    // so a naive path overhangs the angle it was asked for. The rings are drawn
    // the way the Watch draws them; the drawing still has to agree with the
    // number printed in the middle of it.

    const RADIUS = 87;
    const STROKE = 18;

    function endOf(path: string): { x: number; y: number } {
        const match = /A [\d.]+ [\d.]+ 0 [01] 1 ([-\d.]+) ([-\d.]+)/.exec(path);
        if (!match) throw new Error(`no arc in ${path}`);
        return { x: Number(match[1]), y: Number(match[2]) };
    }

    it("pulls each end in by exactly half a cap", () => {
        const half = capAngle(RADIUS, STROKE);
        // Half of an 18 wide stroke at radius 87 is a shade under six degrees.
        expect(half).toBeCloseTo(5.93, 2);

        const path = cappedArcPath(100, 100, RADIUS, 0, 180, STROKE);
        const drawnEnd = endOf(path);
        const trueEnd = polarToCartesian(100, 100, RADIUS, 180 - half);
        expect(drawnEnd.x).toBeCloseTo(trueEnd.x, 1);
        expect(drawnEnd.y).toBeCloseTo(trueEnd.y, 1);
    });

    it("puts the cap's centre on the angle the figure describes", () => {
        // The visible tip is the drawn end plus half a cap, which is the whole
        // point: 75 percent has to end at three o'clock and not past it.
        const half = capAngle(RADIUS, STROKE);
        const path = cappedArcPath(100, 100, RADIUS, 0, 270, STROKE);
        const drawnEnd = endOf(path);
        const capCentre = polarToCartesian(100, 100, RADIUS, 270 - half);
        expect(drawnEnd.x).toBeCloseTo(capCentre.x, 1);
        expect(drawnEnd.y).toBeCloseTo(capCentre.y, 1);

        // And that cap centre is three o'clock, to within a rounding place.
        const threeOClock = polarToCartesian(100, 100, RADIUS, 270);
        expect(
            Math.hypot(capCentre.x - threeOClock.x, capCentre.y - threeOClock.y)
        ).toBeLessThan(STROKE / 2 + 1);
    });

    it("draws a dot rather than nothing when the sweep is shorter than its caps", () => {
        // One percent of a ring is narrower than the cap itself. The Watch shows
        // a small nub there; drawing an arc would show nothing at all.
        const path = cappedArcPath(100, 100, RADIUS, 0, 3.6, STROKE);
        expect(path).not.toContain("A ");
        expect(path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    });

    it("gives every progress arc round ends", () => {
        const svg = ringsSvg({
            activityMinutes: 60,
            activityTarget: 120,
            shiftHours: 0,
            shiftTarget: 8,
            activeDays: 0,
            activeDaysTarget: 4,
            state: "red",
            softRingsEnabled: false
        });
        expect(parts(svg, "ring-progress")[0]).toContain('stroke-linecap="round"');
    });
});

describe("the labelled card's margins", () => {
    // Every one of these was a hand-picked number that only happened to look
    // right for three rows, which is why the card sat left of centre.

    const input = {
        activityMinutes: 9,
        activityTarget: 120,
        shiftHours: 1,
        shiftTarget: 4,
        activeDays: 1,
        activeDaysTarget: 3,
        state: "red" as const,
        softRingsEnabled: true
    };

    /** Where the ring group lands on the card, and how far it was scaled. */
    function ringPlacement(svg: string): { x: number; y: number; scale: number } {
        const match = /translate\(([-\d.]+), ([-\d.]+)\) scale\(([\d.]+)\)/.exec(svg);
        if (!match) throw new Error("no ring transform");
        return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
    }

    /** The rings are drawn on a 200 canvas whose outer edge is 5 in from it. */
    const RING_EDGE = 5;
    const PAD = 24;

    it("insets the rings by the margin on the left and on the top", () => {
        const { x, y, scale } = ringPlacement(ringCardSvg(input));
        expect(x + RING_EDGE * scale).toBeCloseTo(PAD, 1);
        expect(y + RING_EDGE * scale).toBeCloseTo(PAD, 1);
    });

    it("ends the legend rails on the same margin", () => {
        const svg = ringCardSvg(input);
        const rails = [...svg.matchAll(/<rect x="(\d+)" y="[\d.]+" width="(\d+)"/g)];
        expect(rails.length).toBeGreaterThan(0);
        for (const rail of rails) {
            expect(Number(rail[1]) + Number(rail[2])).toBe(460 - PAD);
        }
    });

    it("centres the legend block whether it holds one row or three", () => {
        // Three rows fill the height between the margins, matching the rings.
        // One row does not stretch to fill it; it sits in the middle. Either
        // way the ink above the block and below it has to come out equal.
        const extent = (svg: string) => {
            const labelYs = [...svg.matchAll(/<text x="234" y="([\d.]+)"[^>]*font-size="15"/g)]
                .map((match) => Number(match[1]));
            const railYs = [
                ...svg.matchAll(/<rect x="234" y="([\d.]+)" width="\d+" height="4"/g)
            ].map((match) => Number(match[1]));
            expect(labelYs.length).toBeGreaterThan(0);
            expect(railYs.length).toBeGreaterThan(0);
            return { top: Math.min(...labelYs) - 11, bottom: Math.max(...railYs) + 4 };
        };

        const three = extent(ringCardSvg(input));
        expect(three.top).toBeCloseTo(PAD, 1);
        expect(200 - three.bottom).toBeCloseTo(PAD, 1);

        const one = extent(ringCardSvg({ ...input, softRingsEnabled: false }));
        expect(one.top).toBeCloseTo(200 - one.bottom, 1);
    });
});

describe("the legend's ring markers", () => {
    const input = {
        activityMinutes: 9,
        activityTarget: 120,
        shiftHours: 1,
        shiftTarget: 4,
        activeDays: 1,
        activeDaysTarget: 3,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("gives every row a marker in the colour of the ring it names", () => {
        const svg = ringCardSvg(input);
        const halos = [...svg.matchAll(/<circle class="pip-halo"[^>]*stroke="([^"]+)"/g)].map(
            (match) => match[1]
        );
        // Same three colours, in the same order, as the tracks in the drawing.
        expect(halos).toEqual(["#ff453a", "#0a84ff", "#bf5af2"]);
    });

    it("dims the marker's halo by exactly as much as an unlit ring track", () => {
        expect(ringCardSvg(input)).toContain('class="pip-halo"');
        const halo = /<circle class="pip-halo"[^>]*>/.exec(ringCardSvg(input))?.[0] ?? "";
        expect(halo).toContain('stroke-opacity="0.19"');
    });

    it("drops the two soft markers when the soft rings are off", () => {
        const svg = ringCardSvg({ ...input, softRingsEnabled: false });
        expect([...svg.matchAll(/class="pip-halo"/g)]).toHaveLength(1);
    });

    it("greys the markers out on leave, like the rings", () => {
        const svg = ringCardSvg({ ...input, state: "leave" });
        for (const colour of ["#ff453a", "#0a84ff", "#bf5af2"]) {
            expect(svg).not.toContain(colour);
        }
    });

    it("keeps a rail visible at a fraction of a percent", () => {
        // A one pixel sliver reads as a rendering fault. The rail's own round
        // end is the smallest thing that reads as "barely started".
        const svg = ringCardSvg({ ...input, activityMinutes: 1 });
        const fill = /<rect class="rail-fill"[^>]*width="([\d.]+)"/.exec(svg)?.[1];
        expect(Number(fill)).toBeGreaterThanOrEqual(4);
    });
});

describe("the glass is in the panel, never in the rings", () => {
    const input = {
        activityMinutes: 60,
        activityTarget: 120,
        shiftHours: 2,
        shiftTarget: 4,
        activeDays: 2,
        activeDaysTarget: 3,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("never blurs, at 20ms of a 27ms render", () => {
        expect(ringCardSvg(input)).not.toContain("feGaussianBlur");
        expect(ringsSvg(input)).not.toContain("feGaussianBlur");
    });

    it("gives the panel a sheen and a rim, and the bare rings neither", () => {
        expect(ringCardSvg(input)).toContain("url(#panelSheen)");
        expect(ringCardSvg(input)).toContain("url(#panelRim)");
        // The thumbnail has no panel, so it must not reference one.
        expect(ringsSvg(input)).not.toContain("panel");
    });

    it("still draws each ring as a track and an arc and nothing else", () => {
        const svg = ringCardSvg({ ...input, softRingsEnabled: false });
        const ringElements = [
            ...svg.matchAll(/<(circle|path) class="ring-(track|progress|overlay)"/g)
        ];
        expect(ringElements).toHaveLength(2);
    });
});
