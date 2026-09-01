import type { RingState } from "../db/types.js";

/**
 * Ring state thresholds. Green at or above 100 percent of the outer target,
 * amber from amberThresholdPercent to 99, red below that, grey on leave.
 *
 * Colour never carries meaning alone. Every card that shows a ring also states
 * the numbers, because around one in twelve people cannot reliably separate
 * amber from green.
 */

export interface RingInput {
    activityMinutes: number;
    weeklyTargetMinutes: number;
    amberThresholdPercent: number;
    onLeave: boolean;
}

export function ringStateFor(input: RingInput): RingState {
    if (input.onLeave) return "leave";
    const target = input.weeklyTargetMinutes;
    const achieved = target <= 0 ? 100 : (input.activityMinutes / target) * 100;
    if (achieved >= 100) return "green";
    if (achieved >= input.amberThresholdPercent) return "amber";
    return "red";
}

/** Plain language for the figures line. Never the only signal, but never absent. */
/** Reads as the tail of a sentence: "0 of 120 activity minutes, behind target." */
export const RING_STATE_LABEL: Record<RingState, string> = {
    green: "target met",
    amber: "on track",
    red: "behind target",
    leave: "on leave"
};

export const RING_STATE_COLOUR: Record<RingState, number> = {
    green: 0x30d158,
    amber: 0xff9f0a,
    red: 0xff453a,
    leave: 0x8e8e93
};
