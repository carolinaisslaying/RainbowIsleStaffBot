/**
 * Shared colour language.
 *
 * Every card takes its accent from this list rather than picking a colour at
 * the call site, so the stripe down the left edge is readable on its own:
 * violet for a member's own data, gold for standings, amber for anything
 * awaiting a decision, red for a decision that went against them.
 *
 * Colour never carries meaning alone. Each of these pairs with wording or a
 * figure that says the same thing.
 */
export const COLOUR = {
    /** Personal data: rings, exports, timezone. */
    personal: 0x9d7cff,
    /** Standings and comparisons. */
    standings: 0xf0b232,
    /** Shift running, member available. */
    onShift: 0x32d74b,
    /** Shift paused. */
    away: 0xff9f0a,
    /** Waiting on a human decision. */
    pending: 0xff9f0a,
    /** Approved, restored, resolved. */
    approved: 0x32d74b,
    /** Declined, warned, below threshold. */
    adverse: 0xff453a,
    /** Finished and filed, no action left. */
    settled: 0x8e8e93,
    /** Reports and analysis. */
    report: 0x40c8e0,
    /** Configuration and administration. */
    admin: 0x5865f2,
    /** Something to celebrate. */
    milestone: 0xffd60a
} as const;

/**
 * The fonts the runtime image installs, in preference order.
 *
 * Inter first: the rings are drawn in Apple's idiom, and Apple's numerals are
 * half of why that idiom reads the way it does. DejaVu stays behind it so a
 * build without Inter renders text rather than nothing.
 */
export const FONT_STACK = "Inter, DejaVu Sans, sans-serif";

/**
 * The surface vocabulary.
 *
 * Apple's material is a property of the *container*, not of the contents. The
 * rings on a Watch face are flat, vivid and sit on black; what is made of glass
 * is the panel they sit in. An earlier pass had this backwards and built each
 * ring out of nine concentric strokes -- track, two rims, filament, inner edge,
 * sheen, three halo layers -- which at three rings is twenty-seven concentric
 * circles and reads as a camera lens rather than as a Watch.
 *
 * The panel is near black, and deliberately much darker than the Discord
 * container behind it, which is about #2b2d31 in dark mode. That is the fix for
 * the card reading as a box inside a box: the old panel sat a few percent off
 * its surround with a faint border, which looks like a mistake. A panel this
 * much darker reads as a screen inset into the card on purpose, and it is what
 * lets the ring colours be as saturated as they are on a Watch.
 */
export const SURFACE = {
    /** Panel ground. Near black, with a barely there lift towards the top. */
    panelTop: "#17181c",
    panelBottom: "#0e0f12",
    /** The hairline where the panel catches the light. Almost nothing. */
    rimLight: "rgba(255,255,255,0.07)",
    /** How much of its own colour a ring lends the panel behind it. */
    washMax: 0.16,
    /** An unlit track: the ring's own colour, dimmed, never grey and never white. */
    trackAlpha: 0.19,
    text: "#f2f3f5",
    textMuted: "#9b9ea6",
    /** Rails under the legend rows. */
    rail: "rgba(255,255,255,0.08)"
} as const;
