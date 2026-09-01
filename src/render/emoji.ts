import { COLOUR } from "./theme.js";

/**
 * One emoji per card state, derived from the same value the accent colour is.
 *
 * Colour is already the state vocabulary in this bot: amber waits on a human,
 * green is settled well, red is settled badly, grey is filed. An emoji chosen
 * per card would drift from that within a week, so it is chosen from the colour
 * instead and the two cannot disagree. A card that changes colour changes its
 * emoji in the same edit, because there is only one edit to make.
 *
 * Keyed by the colour value rather than by the role name because that is what
 * `noticeCard` is handed. Two pairs of roles share a value: green is both
 * `approved` and `onShift`, amber both `pending` and `away`. The commoner
 * meaning wins the default and the two shift cards pass their own, which is
 * cheaper than splitting the palette to carry information the palette does not
 * hold.
 *
 * The emoji leads the title and appears nowhere else. These cards are read by
 * Moderators deciding something, and body copy peppered with icons reads as
 * decoration at exactly the moment it needs to read as a record.
 */
export const EMOJI_FOR_COLOUR: Record<number, string> = {
    [COLOUR.approved]: "✅",
    [COLOUR.pending]: "⏳",
    [COLOUR.adverse]: "❌",
    [COLOUR.settled]: "📁",
    [COLOUR.inProgress]: "🌙",
    [COLOUR.report]: "📋",
    [COLOUR.admin]: "⚙️",
    [COLOUR.milestone]: "🎉",
    [COLOUR.personal]: "📊",
    [COLOUR.standings]: "🏆"
};

/** Emoji for cards whose state the palette does not distinguish. */
export const EMOJI = {
    /** A shift running, as against leave approved: both are green. */
    onShift: "▶️",
    /** A shift paused, as against a decision pending: both are amber. */
    away: "⏸️",
    /** Coming back from leave. Warmer than the green it is drawn in. */
    welcome: "👋",
    /** Timezones and the clock. */
    clock: "🌍",
    /** Deletion, which is the one thing in here that cannot be undone. */
    purge: "🗑️",
    /** Something recomputed rather than decided. */
    recompute: "🔄",
    /** An outcome that needs a human to finish it by hand. */
    warning: "⚠️"
} as const;

/**
 * The emoji a card leads with. Falls back to the neutral marker rather than to
 * nothing, so a colour added to the palette without a matching emoji still
 * renders a title that lines up with every other card.
 */
export function emojiForColour(colour: number): string {
    return EMOJI_FOR_COLOUR[colour] ?? "•";
}
