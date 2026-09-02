import type { ConductTier } from "../db/types.js";
import { COLOUR } from "./theme.js";

/**
 * How a rung of the conduct ladder presents itself, in one place.
 *
 * A tier shows up on four surfaces: the member's DM, the card in the warning
 * channel, the record list, and the review row. All four drew every rung the
 * same way, and a colleague reading the log told us they could not tell the
 * rungs apart without stopping to read the word.
 *
 * Four signals now carry severity, and this file holds all four: an accent
 * colour, a heading size, a mark, and a sentence naming what the rung does to
 * the record. No call site picks any of them, which is how the four surfaces
 * drifted apart in the first place.
 *
 * Colour on its own would not carry it. About one man in twelve cannot tell the
 * gold from the red, and a notification preview shows the mark and the text
 * before it shows an accent.
 */
export interface TierStyle {
    /** What it is called. Never "minor": all three are formal written warnings. */
    label: string;
    /** The accent. On a warning card the rung owns this, not the state. */
    colour: number;
    /**
     * Leads the title, and is the one thing that survives a notification
     * preview, a colour-blind reader and a greyscale screenshot alike.
     */
    emoji: string;
    /**
     * Discord's heading markup, climbing with the rung. `#` renders largest,
     * and the top rung takes it. A warning that never expires should not sit
     * on the page at the same size as one that lapses in ninety days.
     */
    heading: string;
    /**
     * The same escalation in a list, where a page of `#` headings turns into a
     * wall. The top rung still steps up and the other two stay inline.
     */
    listHeading: string;
    /** Ordering, lowest first. Used to sort a record so the worst reads last. */
    rank: number;
}

export const TIER_STYLE: Record<ConductTier, TierStyle> = {
    caution: {
        label: "Caution",
        colour: COLOUR.caution,
        emoji: "⚠️",
        heading: "###",
        listHeading: "",
        rank: 1
    },
    misconduct: {
        label: "Misconduct",
        colour: COLOUR.misconduct,
        emoji: "🔶",
        heading: "##",
        listHeading: "",
        rank: 2
    },
    seriousMisconduct: {
        label: "Serious Misconduct",
        colour: COLOUR.seriousMisconduct,
        emoji: "🚨",
        heading: "#",
        listHeading: "###",
        rank: 3
    }
};

/** The rungs, lowest first. */
export const TIERS_BY_RANK: readonly ConductTier[] = (
    Object.keys(TIER_STYLE) as ConductTier[]
).sort((a, b) => TIER_STYLE[a].rank - TIER_STYLE[b].rank);

/**
 * What the rung does to the record, as a sentence, bold on every surface.
 *
 * The lifetime is what separates one rung from another, so it reads at the
 * same weight as the name instead of sitting in a footnote. It never says what
 * happens next, because the bot does not escalate and should not hint that it
 * might.
 */
export function tierConsequenceLine(days: number): string {
    return days <= 0
        ? "**This never stops counting.** The record keeps it for good."
        : `**Counts for ${days} days.** The record keeps it after that.`;
}

/**
 * The title a warning card leads with, at the weight its rung earns.
 *
 * An activity warning has no rung and takes the plain form. The bot computed
 * the figure behind it, so dressing it in the conduct ladder's colours would
 * claim a severity no Executive chose.
 */
export function tierTitle(tier: ConductTier | null, inList = false): string {
    if (!tier) return "### ⚠️ Activity warning";
    const style = TIER_STYLE[tier];
    const heading = inList ? style.listHeading : style.heading;
    const prefix = heading ? `${heading} ` : "";
    return `${prefix}${style.emoji} ${style.label}`;
}
