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
 * The glass vocabulary.
 *
 * Apple's material is a lens: it bends the light behind it, catches a hard
 * specular edge where it curves, and drops a soft shadow because it sits above
 * the surface rather than on it. None of that is available for free here. These
 * images composite onto a Discord card, so there is no backdrop to sample and
 * no `backdrop-filter` in SVG to sample it with.
 *
 * So the light is drawn rather than borrowed. Every ring is a lit tube: a
 * frosted channel with a bright inner rim and a dark outer one, a saturated
 * filament inside it, and that filament's own colour blurred underneath as the
 * glow escaping the glass. The values below are the whole vocabulary, and
 * nothing in the renderers invents its own.
 */
export const GLASS = {
    /** The empty channel: glass with nothing lit behind it. */
    frost: "rgba(255,255,255,0.085)",
    /** Where the tube curves towards the light, at ten o'clock. */
    rimLight: "rgba(255,255,255,0.55)",
    /** The far edge of the same curve. */
    rimShade: "rgba(0,0,0,0.38)",
    /** The sheen laid across the whole surface. */
    sheen: "rgba(255,255,255,0.30)",
    /** Panel ground, top and bottom of a vertical fall. */
    substrateTop: "#16171c",
    substrateBottom: "#0b0c10",
    /** The frosted sheet itself. */
    pane: "rgba(255,255,255,0.055)",
    paneRim: "rgba(255,255,255,0.14)",
    /** Text on glass. */
    text: "#f5f6f8",
    textMuted: "#9ea0a8"
} as const;
