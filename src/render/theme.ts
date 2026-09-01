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

/** The one font the runtime image installs. Referenced by both renderers. */
export const FONT_STACK = "DejaVu Sans, sans-serif";
