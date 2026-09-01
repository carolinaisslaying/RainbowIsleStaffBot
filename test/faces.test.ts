import { describe, expect, it } from "vitest";
import { FACES, DEFAULT_FACE, faceFor, lighten, ringColours } from "../src/render/faces.js";
import { ringsSvg, ringsCacheKey } from "../src/render/rings.js";
import { needsRingFace } from "../src/domain/staff.js";
import type { StaffDoc } from "../src/db/types.js";

/** Hue in degrees, 0 = red. Saturation 0..1. */
function hsl(hex: string): { hue: number; saturation: number } {
    const value = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map(
        (channel) => channel / 255
    );
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const span = max - min;
    if (span === 0) return { hue: 0, saturation: 0 };

    const hue =
        max === r
            ? 60 * (((g - b) / span + 6) % 6)
            : max === g
              ? 60 * ((b - r) / span + 2)
              : 60 * ((r - g) / span + 4);
    const lightness = (max + min) / 2;
    return { hue, saturation: span / (1 - Math.abs(2 * lightness - 1)) };
}

function separation(left: number, right: number): number {
    const gap = Math.abs(left - right) % 360;
    return gap > 180 ? 360 - gap : gap;
}

describe("a face never borrows a hue the outer ring owns", () => {
    // The outer ring is green, amber, red or grey, and that is what it means.
    // A shift ring in green would make "on target" and "that is merely their
    // shift ring" the same glance, which is the one thing these images exist to
    // keep apart.
    const RESERVED = [
        { name: "red and amber", from: 0, to: 60 },
        { name: "green", from: 90, to: 165 }
    ];

    for (const face of FACES) {
        for (const [role, hex] of [
            ["shift", face.shift],
            ["days", face.days]
        ] as const) {
            it(`${face.name}'s ${role} ring stays out of the reserved bands`, () => {
                const { hue, saturation } = hsl(hex);
                for (const band of RESERVED) {
                    expect(
                        hue >= band.from && hue <= band.to,
                        `${hex} is ${Math.round(hue)}deg, inside ${band.name}`
                    ).toBe(false);
                }
                // And never so desaturated that it reads as the grey of leave.
                expect(saturation).toBeGreaterThan(0.4);
            });
        }
    }
});

describe("a face's two rings are told apart from each other", () => {
    for (const face of FACES) {
        it(`${face.name} separates its two soft rings`, () => {
            // Tidepool is the tightest at about 40 degrees, cyan against
            // indigo, which reads clearly at ring size. Anything under 35 does
            // not, and would make the card look like one ring drawn twice.
            const gap = separation(hsl(face.shift).hue, hsl(face.days).hue);
            expect(gap).toBeGreaterThanOrEqual(35);
        });
    }

    it("gives every face a distinct identity, not four shades of one idea", () => {
        const ids = FACES.map((face) => face.id);
        expect(new Set(ids).size).toBe(FACES.length);
        expect(new Set(FACES.map((face) => face.name)).size).toBe(FACES.length);
    });
});

describe("deriving the light end and the extra lap", () => {
    it("reproduces the colours that were originally picked by eye", () => {
        // The justification for deriving rather than hand-picking twelve more
        // hexes: run the original blue through it and you land on what a
        // designer chose, to within a couple of values per channel.
        const blue = ringColours("#0a84ff");
        expect(blue.light).toBe("#60afff"); // was #5cb3ff
        expect(blue.overlay).toBe("#a2d0ff"); // was #a5d6ff

        const violet = ringColours("#bf5af2");
        expect(violet.light).toBe("#d594f7"); // was #d99bf7
    });

    it("moves towards white and never past it", () => {
        expect(lighten("#000000", 0)).toBe("#000000");
        expect(lighten("#000000", 1)).toBe("#ffffff");
        expect(lighten("#ffffff", 0.5)).toBe("#ffffff");
    });

    it("keeps the core exactly as written, since that is the colour named", () => {
        for (const face of FACES) {
            expect(ringColours(face.shift).core).toBe(face.shift);
            expect(ringColours(face.days).core).toBe(face.days);
        }
    });
});

describe("resolving a stored face id", () => {
    it("falls back rather than failing on an id that no longer exists", () => {
        // Retiring a face must not break the cards of everyone who chose it.
        expect(faceFor("a-face-we-retired")).toBe(DEFAULT_FACE);
        expect(faceFor(null)).toBe(DEFAULT_FACE);
        expect(faceFor(undefined)).toBe(DEFAULT_FACE);
    });

    it("returns the face that was asked for when it exists", () => {
        for (const face of FACES) {
            expect(faceFor(face.id)).toBe(face);
        }
    });
});

describe("the face reaches the drawing", () => {
    const input = {
        activityMinutes: 60,
        activityTarget: 120,
        shiftHours: 2,
        shiftTarget: 4,
        activeDays: 2,
        activeDaysTarget: 3,
        state: "amber" as const,
        softRingsEnabled: true
    };

    const trackStrokes = (svg: string) =>
        [...svg.matchAll(/<circle class="ring-track"[^>]*stroke="([^"]+)"/g)].map(
            (match) => match[1]
        );

    it("draws the two soft rings in the chosen face", () => {
        const neon = FACES.find((face) => face.id === "neon")!;
        expect(trackStrokes(ringsSvg({ ...input, face: "neon" }))).toEqual([
            "#ff9f0a", // the outer ring is the amber state, untouched
            neon.shift,
            neon.days
        ]);
    });

    it("leaves the compliance ring alone whichever face is chosen", () => {
        for (const face of FACES) {
            expect(trackStrokes(ringsSvg({ ...input, face: face.id }))[0]).toBe("#ff9f0a");
        }
    });

    it("greys every face out on leave, because away is not a matter of taste", () => {
        for (const face of FACES) {
            const svg = ringsSvg({ ...input, state: "leave", face: face.id });
            expect(svg).not.toContain(face.shift);
            expect(svg).not.toContain(face.days);
        }
    });

    it("renders the default for a member who has no face yet", () => {
        expect(trackStrokes(ringsSvg(input))).toEqual([
            "#ff9f0a",
            DEFAULT_FACE.shift,
            DEFAULT_FACE.days
        ]);
    });
});

describe("changing a face changes the picture", () => {
    const stats = {
        activityMinutes: 60,
        shiftHours: 2,
        activeDays: 2,
        state: "amber" as const,
        softRingsEnabled: true
    };
    const week = new Date("2026-09-07T00:00:00Z");

    it("keys the cache on the face, or the old picture is served forever", () => {
        // The failure this prevents is silent and infuriating: you pick a new
        // face, nothing changes, and it keeps not changing until your minute
        // count happens to move.
        const keys = FACES.map((face) => ringsCacheKey("staff1", week, { ...stats, face: face.id }));
        expect(new Set(keys).size).toBe(FACES.length);
    });

    it("still separates two members with the same face and the same week", () => {
        expect(ringsCacheKey("staff1", week, { ...stats, face: "neon" })).not.toBe(
            ringsCacheKey("staff2", week, { ...stats, face: "neon" })
        );
    });

    it("treats an unset face as the default rather than as its own key", () => {
        expect(ringsCacheKey("staff1", week, { ...stats, face: null })).toBe(
            ringsCacheKey("staff1", week, { ...stats, face: DEFAULT_FACE.id })
        );
    });
});

describe("the onboarding gate", () => {
    const staff = { ringFace: null } as unknown as StaffDoc;

    it("asks a member who has never chosen", () => {
        expect(needsRingFace(staff)).toBe(true);
        expect(needsRingFace(null)).toBe(true);
    });

    it("stops asking once they have", () => {
        expect(needsRingFace({ ...staff, ringFace: "neon" })).toBe(false);
    });

    it("keeps asking if the stored value is empty rather than absent", () => {
        expect(needsRingFace({ ...staff, ringFace: "" })).toBe(true);
    });
});
