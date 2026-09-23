import { describe, expect, it } from "vitest";
import {
    ACTIVITY_STYLE,
    TIERS_BY_RANK,
    TIER_STYLE,
    recordStyle,
    tierConsequenceLine,
    tierTitle
} from "../src/render/tiers.js";
import { EMOJI, EMOJI_FOR_COLOUR } from "../src/render/emoji.js";
import { COLOUR } from "../src/render/theme.js";
import { warningWeightLine } from "../src/domain/review.js";
import { CONDUCT_TIERS, type ConductTier } from "../src/db/types.js";

/**
 * The two rungs used to render identically. A colleague reading the log said
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

    it("climbs from gold to red", () => {
        expect(TIER_STYLE.caution.colour).toBe(COLOUR.caution);
        expect(TIER_STYLE.misconduct.colour).toBe(COLOUR.misconduct);
    });

    it("makes the heading larger for the worse rung", () => {
        // Fewer hashes is a bigger heading in Discord's markdown.
        expect(TIER_STYLE.misconduct.heading.length).toBeLessThan(
            TIER_STYLE.caution.heading.length
        );
    });

    it("ranks them lowest first", () => {
        expect(TIERS_BY_RANK).toEqual(["caution", "misconduct"]);
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
        expect(tierTitle("misconduct")).toBe("## 🚨 Misconduct");
    });

    it("steps down in a list, so a record is not a wall of headings", () => {
        // Only the top rung still steps up; a page of H1s would be unreadable.
        expect(tierTitle("caution", true)).toBe("⚠️ Caution");
        expect(tierTitle("misconduct", true)).toBe("### 🚨 Misconduct");
    });

    it("leaves an activity warning out of the conduct ladder", () => {
        // It is issued off a figure the bot computed. Dressing it in the
        // ladder's colours would say something nobody decided.
        expect(tierTitle(null)).toContain("Activity warning");
        expect(tierTitle(null)).not.toContain("🚨");
    });
});

describe("an activity warning has a mark and a colour of its own", () => {
    it("shares its mark with nothing else in the bot", () => {
        // It used to open with ⚠️, which is also Caution's mark and the bot's
        // general "look at this", so an activity warning and a Caution led
        // with the same symbol in the same channel.
        expect(tierTitle(null)).toBe("### 📉 Activity warning");
        for (const tier of CONDUCT_TIERS) {
            expect(TIER_STYLE[tier].emoji).not.toBe(ACTIVITY_STYLE.emoji);
        }
        expect(Object.values(EMOJI)).not.toContain(ACTIVITY_STYLE.emoji);
        const owners = Object.entries(EMOJI_FOR_COLOUR).filter(
            ([, mark]) => mark === ACTIVITY_STYLE.emoji
        );
        expect(owners.map(([value]) => Number(value))).toEqual([COLOUR.activityWarning]);
    });

    it("is drawn in neither rung's colour, nor in the grey of a finished record", () => {
        // On the log card it used to be red, the same red as Misconduct.
        for (const tier of CONDUCT_TIERS) {
            expect(ACTIVITY_STYLE.colour).not.toBe(TIER_STYLE[tier].colour);
        }
        expect(ACTIVITY_STYLE.colour).not.toBe(COLOUR.adverse);
        expect(ACTIVITY_STYLE.colour).not.toBe(COLOUR.settled);
        expect(ACTIVITY_STYLE.colour).not.toBe(COLOUR.pending);
    });

    it("is the colour of its card in the warning log", async () => {
        const { warningLogCard } = await import("../src/render/cards.js");
        const card = warningLogCard({
            warningId: "x",
            displayName: "Ashley",
            mention: "<@123>",
            kind: "activity",
            tier: null,
            issuedAt: new Date("2026-09-01T10:00:00Z"),
            issuedBy: "<@999>",
            reason: "Below for the fortnight.",
            permanent: false,
            lifetimeDays: 90,
            acknowledgedAt: null,
            delivery: "delivered",
            withdrawn: null
        }).components[0].toJSON() as { accent_color: number };
        expect(card.accent_color).toBe(COLOUR.activityWarning);
        expect(JSON.stringify(card)).toContain("📉 Activity warning");
    });
});

describe("a record reads at the weight of the worst warning still counting", () => {
    it("takes the highest rung, then activity, then nothing", () => {
        expect(
            recordStyle([
                { kind: "activity", tier: null },
                { kind: "conduct", tier: "caution" },
                { kind: "conduct", tier: "misconduct" }
            ])?.colour
        ).toBe(COLOUR.misconduct);
        expect(
            recordStyle([
                { kind: "activity", tier: null },
                { kind: "conduct", tier: "caution" }
            ])?.emoji
        ).toBe("⚠️");
        expect(recordStyle([{ kind: "activity", tier: null }])?.colour).toBe(
            COLOUR.activityWarning
        );
        expect(recordStyle([])).toBeNull();
    });
});

describe("what a rung does to the record", () => {
    it("states permanence in bold rather than as a footnote", () => {
        const line = tierConsequenceLine(0);
        expect(line).toContain("**This warning does not expire.**");
    });

    it("names the number of days for an activity warning, which still expires", () => {
        expect(tierConsequenceLine(90)).toContain("**Counts for 90 days.**");
        expect(tierConsequenceLine(180)).toContain("**Counts for 180 days.**");
    });

    it("says the record keeps an expiring warning once it stops counting", () => {
        for (const days of [90, 180]) {
            expect(tierConsequenceLine(days)).toContain("The record keeps it");
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
            tier: "misconduct" as const,
            issuedAt: new Date("2026-09-01T10:00:00Z"),
            issuedBy: "<@999>",
            reason: "Something happened.",
            permanent: true,
            lifetimeDays: 0,
            acknowledgedAt: null,
            delivery: "delivered" as const
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

        expect(live).toContain("does not expire");
        // "does not expire" above "no longer counts against them" is a card
        // contradicting itself in consecutive lines.
        expect(withdrawn).not.toContain("does not expire");
        expect(withdrawn).toContain("no longer counts against them");
    });

    it("goes grey whatever its rung, and offers no button", () => {
        return import("../src/render/cards.js").then(({ warningLogCard }) => {
            const card = warningLogCard({
                warningId: "x",
                displayName: "Ashley",
                mention: "<@123>",
                kind: "conduct",
                tier: "misconduct",
                issuedAt: new Date("2026-09-01T10:00:00Z"),
                issuedBy: "<@999>",
                reason: "Something happened.",
                permanent: true,
                lifetimeDays: 0,
                acknowledgedAt: null,
                delivery: "delivered",
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
        ...overrides
    });

    it("says which rungs, not just how many conduct warnings", () => {
        // Two Cautions and one Misconduct are different facts, and an
        // Executive deciding an attendance shortfall should see which.
        const line = warningWeightLine({
            total: 3,
            conduct: 2,
            activity: 1,
            tiers: tiers({ caution: 1, misconduct: 1 })
        });
        expect(line).toContain("1 Misconduct");
        expect(line).toContain("1 Caution");
        expect(line).toContain("1 activity");
        expect(line).toContain("their 4th");
    });

    it("puts the worst rung first", () => {
        const line = warningWeightLine({
            total: 2,
            conduct: 2,
            activity: 0,
            tiers: tiers({ caution: 1, misconduct: 1 })
        });
        expect(line.indexOf("Misconduct")).toBeLessThan(line.indexOf("Caution"));
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
    });

    it("still reads without a rung breakdown at all", () => {
        // The field is optional, so an older caller degrades rather than throws.
        expect(warningWeightLine({ total: 2, conduct: 1, activity: 1 })).toContain(
            "1 conduct, 1 activity"
        );
    });
});
