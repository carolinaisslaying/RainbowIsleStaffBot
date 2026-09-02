import { describe, expect, it } from "vitest";
import {
    TIERS_BY_RANK,
    TIER_STYLE,
    tierConsequenceLine,
    tierTitle
} from "../src/render/tiers.js";
import { COLOUR } from "../src/render/theme.js";
import { warningWeightLine } from "../src/domain/review.js";
import { CONDUCT_TIERS, type ConductTier } from "../src/db/types.js";

/**
 * The three rungs used to render identically. A colleague reading the log said
 * they could not see any difference at all until they really looked, which for a
 * disciplinary record is a defect. These hold the escalation in place.
 */

describe("every rung is visibly distinct", () => {
    it("covers every tier the record can hold", () => {
        for (const tier of CONDUCT_TIERS) {
            expect(TIER_STYLE[tier]).toBeDefined();
        }
        expect(Object.keys(TIER_STYLE)).toHaveLength(CONDUCT_TIERS.length);
    });

    it("gives each rung its own colour", () => {
        const colours = CONDUCT_TIERS.map((tier) => TIER_STYLE[tier].colour);
        expect(new Set(colours).size).toBe(colours.length);
    });

    it("gives each rung its own mark", () => {
        const marks = CONDUCT_TIERS.map((tier) => TIER_STYLE[tier].emoji);
        expect(new Set(marks).size).toBe(marks.length);
    });

    it("gives each rung its own heading size", () => {
        const headings = CONDUCT_TIERS.map((tier) => TIER_STYLE[tier].heading);
        expect(new Set(headings).size).toBe(headings.length);
    });

    it("climbs from gold through amber to red", () => {
        expect(TIER_STYLE.caution.colour).toBe(COLOUR.caution);
        expect(TIER_STYLE.misconduct.colour).toBe(COLOUR.misconduct);
        expect(TIER_STYLE.seriousMisconduct.colour).toBe(COLOUR.seriousMisconduct);
    });

    it("makes the heading larger as the rung gets worse", () => {
        // Fewer hashes is a bigger heading in Discord's markdown.
        expect(TIER_STYLE.caution.heading.length).toBeGreaterThan(
            TIER_STYLE.misconduct.heading.length
        );
        expect(TIER_STYLE.misconduct.heading.length).toBeGreaterThan(
            TIER_STYLE.seriousMisconduct.heading.length
        );
        expect(TIER_STYLE.seriousMisconduct.heading).toBe("#");
    });

    it("ranks them lowest first", () => {
        expect(TIERS_BY_RANK).toEqual(["caution", "misconduct", "seriousMisconduct"]);
    });

    it("never names a rung in a way that diminishes it", () => {
        // Everything issued through this bot is a formal written warning;
        // informal correction happens in a DM and never reaches the record.
        for (const tier of CONDUCT_TIERS) {
            const label = TIER_STYLE[tier].label.toLowerCase();
            expect(label).not.toContain("minor");
            expect(label).not.toContain("informal");
            expect(label).not.toContain("standard");
        }
    });
});

describe("the title a card leads with", () => {
    it("carries the mark and the label at the rung's own weight", () => {
        expect(tierTitle("caution")).toBe("### ⚠️ Caution");
        expect(tierTitle("misconduct")).toBe("## 🔶 Misconduct");
        expect(tierTitle("seriousMisconduct")).toBe("# 🚨 Serious Misconduct");
    });

    it("steps down in a list, so a record is not a wall of headings", () => {
        // Only the top rung still steps up; five entries at H1 would be unreadable.
        expect(tierTitle("caution", true)).toBe("⚠️ Caution");
        expect(tierTitle("misconduct", true)).toBe("🔶 Misconduct");
        expect(tierTitle("seriousMisconduct", true)).toBe("### 🚨 Serious Misconduct");
    });

    it("leaves an activity warning out of the conduct ladder", () => {
        // It is issued off a figure the bot computed. Dressing it in the
        // ladder's colours would say something nobody decided.
        expect(tierTitle(null)).toContain("Activity warning");
        expect(tierTitle(null)).not.toContain("🚨");
    });
});

describe("what a rung does to the record", () => {
    it("states permanence in bold rather than as a footnote", () => {
        const line = tierConsequenceLine(0);
        expect(line).toContain("**This never stops counting.**");
    });

    it("names the number of days for a rung that expires", () => {
        expect(tierConsequenceLine(90)).toContain("**Counts for 90 days**");
        expect(tierConsequenceLine(180)).toContain("**Counts for 180 days**");
    });

    it("says the record keeps it either way", () => {
        for (const days of [0, 90, 180]) {
            expect(tierConsequenceLine(days)).toContain("stays on the record");
        }
    });

    it("never implies a next step", () => {
        // The bot does not escalate and must not suggest that it will.
        for (const days of [0, 90, 180]) {
            const line = tierConsequenceLine(days).toLowerCase();
            expect(line).not.toContain("dismiss");
            expect(line).not.toContain("final");
            expect(line).not.toContain("further action");
        }
    });
});

describe("a withdrawn warning does not argue with itself", () => {
    it("drops the consequence line, which is no longer true of it", async () => {
        const { warningLogCard } = await import("../src/render/cards.js");
        const base = {
            warningId: "65a1b2c3d4e5f6a7b8c9d001",
            displayName: "Ashley",
            mention: "<@123>",
            kind: "conduct" as const,
            tier: "seriousMisconduct" as const,
            issuedAt: new Date("2026-09-01T10:00:00Z"),
            issuedBy: "<@999>",
            reason: "Something happened.",
            permanent: true,
            lifetimeDays: 0,
            acknowledgedAt: null,
            delivery: "delivered" as const,
            appeal: null
        };

        const live = JSON.stringify(
            warningLogCard({ ...base, withdrawn: null }).components[0].toJSON()
        );
        const withdrawn = JSON.stringify(
            warningLogCard({
                ...base,
                withdrawn: {
                    at: new Date("2026-09-02T10:00:00Z"),
                    by: "<@999>",
                    reason: "Wrong person."
                }
            }).components[0].toJSON()
        );

        expect(live).toContain("never stops counting");
        // "never stops counting" above "counts against them nowhere" is a card
        // contradicting itself in consecutive lines.
        expect(withdrawn).not.toContain("never stops counting");
        expect(withdrawn).toContain("counts against them nowhere");
    });

    it("goes grey whatever its rung, and offers no button", () => {
        return import("../src/render/cards.js").then(({ warningLogCard }) => {
            const card = warningLogCard({
                warningId: "x",
                displayName: "Ashley",
                mention: "<@123>",
                kind: "conduct",
                tier: "seriousMisconduct",
                issuedAt: new Date("2026-09-01T10:00:00Z"),
                issuedBy: "<@999>",
                reason: "Something happened.",
                permanent: true,
                lifetimeDays: 0,
                acknowledgedAt: null,
                delivery: "delivered",
                appeal: null,
                withdrawn: {
                    at: new Date("2026-09-02T10:00:00Z"),
                    by: "<@999>",
                    reason: "Wrong person."
                }
            }).components[0].toJSON() as {
                accent_color: number;
                components: { type: number }[];
            };

            // Grey means finished everywhere else in this bot, and a withdrawn
            // warning left blood red would misrepresent the record to anybody
            // scrolling past it.
            expect(card.accent_color).toBe(COLOUR.settled);
            expect(card.components.filter((child) => child.type === 1)).toHaveLength(0);
        });
    });
});

describe("the review row names the rungs", () => {
    const tiers = (
        overrides: Partial<Record<ConductTier, number>> = {}
    ): Record<ConductTier, number> => ({
        caution: 0,
        misconduct: 0,
        seriousMisconduct: 0,
        ...overrides
    });

    it("says which rungs, not just how many conduct warnings", () => {
        // Two Cautions and one Serious Misconduct are different facts, and an
        // Executive deciding an attendance shortfall should see which.
        const line = warningWeightLine({
            total: 3,
            conduct: 2,
            activity: 1,
            tiers: tiers({ caution: 1, seriousMisconduct: 1 })
        });
        expect(line).toContain("1 Serious Misconduct");
        expect(line).toContain("1 Caution");
        expect(line).toContain("1 activity");
        expect(line).toContain("their 4th");
    });

    it("puts the worst rung first", () => {
        const line = warningWeightLine({
            total: 2,
            conduct: 2,
            activity: 0,
            tiers: tiers({ caution: 1, seriousMisconduct: 1 })
        });
        expect(line.indexOf("Serious Misconduct")).toBeLessThan(line.indexOf("Caution"));
    });

    it("omits a rung nobody holds", () => {
        const line = warningWeightLine({
            total: 1,
            conduct: 1,
            activity: 0,
            tiers: tiers({ misconduct: 1 })
        });
        expect(line).toContain("1 Misconduct");
        expect(line).not.toContain("Caution");
        expect(line).not.toContain("Serious");
    });

    it("still reads without a rung breakdown at all", () => {
        // The field is optional, so an older caller degrades rather than throws.
        expect(warningWeightLine({ total: 2, conduct: 1, activity: 1 })).toContain(
            "1 conduct, 1 activity"
        );
    });
});
