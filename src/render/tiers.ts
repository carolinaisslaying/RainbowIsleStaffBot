import type { ConductTier } from "../db/types.js";
import { COLOUR } from "./theme.js";

/**
 * How a rung of the conduct ladder presents itself, in one place.
 *
 * The same tier appears on four surfaces — the member's DM, the card in the
 * warning channel, the record list and the review row — and it looked identical
 * on all of them at every rung. A colleague reading the log said they could not
 * see any difference at all until they really looked, which for a disciplinary
 * record is a defect rather than a matter of taste.
 *
 * So severity is carried four ways at once, and every one of them lives here:
 * an accent colour, a heading size, a mark, and a sentence about what the rung
 * actually does to the record. Nothing at a call site picks any of them, so the
 * four surfaces cannot drift from each other the way they already had.
 *
 * Colour alone would not be enough even if it were consistent: roughly one man
 * in twelve cannot separate the gold from the red reliably, and a notification
 * preview shows the mark and the text before it shows any accent at all.
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
     * Discord's heading markup, climbing with the rung. `#` is the largest
     * thing Discord renders, and the top rung gets it: a warning that never
     * expires should not be the same size on the page as one that lapses in
     * ninety days.
     */
    heading: string;
    /**
     * The same escalation for a list, where a page of `#` headings would be
     * unreadable. The top rung still steps up; the other two stay inline.
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
 * This is the part with actual consequences and the only thing that genuinely
 * differs between rungs, so it is stated as plainly as the name is — not left
 * as a footnote for somebody to find. Never says what happens next: the bot
 * does not escalate and must not imply that it will.
 */
export function tierConsequenceLine(days: number): string {
    return days <= 0
        ? "**This never stops counting.** It stays on the record permanently."
        : `**Counts for ${days} days**, then stops counting. It stays on the record either way.`;
}

/**
 * The title a warning card leads with, at the weight its rung earns.
 *
 * An activity warning has no rung and takes the plain form: it is issued off a
 * figure the bot computed, and dressing it in the conduct ladder's colours
 * would say something about it that nobody decided.
 */
export function tierTitle(tier: ConductTier | null, inList = false): string {
    if (!tier) return "### ⚠️ Activity warning";
    const style = TIER_STYLE[tier];
    const heading = inList ? style.listHeading : style.heading;
    const prefix = heading ? `${heading} ` : "";
    return `${prefix}${style.emoji} ${style.label}`;
}
