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
    /** What it is called. Never "minor": both are formal written warnings. */
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
     * and the top rung takes it: gravity, not expiry, is what separates them
     * now that neither lapses.
     */
    heading: string;
    /**
     * The same escalation in a list, where a page of `#` headings turns into a
     * wall. The top rung still steps up and the other stays inline.
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
        emoji: "🚨",
        heading: "##",
        listHeading: "###",
        rank: 2
    }
};

/**
 * How an activity warning presents itself. It has no rung, so it is not a
 * `TierStyle`, but it is drawn on the same surfaces and needs the same two
 * signals held in one place. 📉 rather than ⚠️, which is Caution's mark and the
 * bot's general "look at this": an activity warning and a Caution used to
 * open with the same symbol.
 */
export const ACTIVITY_STYLE = {
    label: "Activity warning",
    colour: COLOUR.activityWarning,
    emoji: "📉"
} as const;

/**
 * The colour and mark for a member's whole record: the worst warning that
 * still counts, so a record holding a live Misconduct never reads as a
 * Caution. Null when nothing counts.
 */
export function recordStyle(
    counting: { kind: "activity" | "conduct"; tier: ConductTier | null }[]
): { colour: number; emoji: string } | null {
    const worst = counting
        .filter((row) => row.kind === "conduct" && row.tier)
        .map((row) => TIER_STYLE[row.tier as ConductTier])
        .sort((a, b) => b.rank - a.rank)[0];
    if (worst) return { colour: worst.colour, emoji: worst.emoji };
    return counting.length > 0 ? { colour: ACTIVITY_STYLE.colour, emoji: ACTIVITY_STYLE.emoji } : null;
}

/** The rungs, lowest first. */
export const TIERS_BY_RANK: readonly ConductTier[] = (
    Object.keys(TIER_STYLE) as ConductTier[]
).sort((a, b) => TIER_STYLE[a].rank - TIER_STYLE[b].rank);

/**
 * What the rung does to the record, as a sentence, bold on every surface.
 *
 * A conduct warning is always permanent, so this always reads the same for
 * one; an activity warning still expires on `warningExpiryDays`, so the
 * function keeps taking a day count rather than hard-coding permanence. It
 * reads at the same weight as the name instead of sitting in a footnote, and
 * never says what happens next, because the bot does not escalate and should
 * not hint that it might.
 */
export function tierConsequenceLine(days: number): string {
    return days <= 0
        ? "**This warning does not expire.**"
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
    if (!tier) return `### ${ACTIVITY_STYLE.emoji} ${ACTIVITY_STYLE.label}`;
    const style = TIER_STYLE[tier];
    const heading = inList ? style.listHeading : style.heading;
    const prefix = heading ? `${heading} ` : "";
    return `${prefix}${style.emoji} ${style.label}`;
}
