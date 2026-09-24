import type { ShiftEndReason } from "../db/types.js";
import { formatDuration, ts } from "../time/format.js";

/**
 * One line of `/shift history`.
 *
 * Pure, with the figures passed in. A shift's `availableMs` and
 * `activityMinutes` are only written when it closes, so an open shift read
 * straight off its document said "0 min available, 0 min earned" however long
 * it had run. The command measures an open shift up to now and hands those
 * figures in instead; nothing is written.
 *
 * The end is printed beside the start, because a start and a length leave the
 * reader to do the sum, and a sum done in your head is how a correct time
 * starts to look wrong.
 */

export interface ShiftLineInput {
    startedAt: Date;
    endedAt: Date | null;
    endReason: ShiftEndReason | null;
    /** For an open shift, measured up to `now` by the caller. */
    availableMs: number;
    /** For an open shift, counted up to `now` by the caller. */
    activityMinutes: number;
    /** When an open shift's current pause began, or null while available. */
    awaySince: Date | null;
    now?: Date;
}

/**
 * Third person, unlike the member's own end-of-shift card: a Lead reads other
 * people's history here, and "you ended it" would be about the reader.
 */
const END_REASON: Record<ShiftEndReason, string> = {
    manual: "ended by hand",
    max_duration: "reached the maximum shift length",
    auto_ended_away: "auto-ended while away",
    leave_started: "ended when leave began",
    reconciled: "closed on restart",
    terminated: "ended by an Executive"
};

export function shiftHistoryLine(input: ShiftLineInput): string {
    const figures =
        `${formatDuration(input.availableMs)} available, ${input.activityMinutes} min earned`;

    if (input.endedAt) {
        const length = formatDuration(input.endedAt.getTime() - input.startedAt.getTime());
        return (
            `${ts(input.startedAt, "f")} → ${ts(input.endedAt, "t")}, ${length}, ${figures}` +
            (input.endReason ? `, ${END_REASON[input.endReason]}` : "")
        );
    }

    const now = input.now ?? new Date();
    const soFar = formatDuration(now.getTime() - input.startedAt.getTime());
    const state = input.awaySince
        ? `**away** since ${ts(input.awaySince, "t")}`
        : "**on shift**";
    return `${ts(input.startedAt, "f")} → now, ${soFar} so far, ${figures}, ${state}`;
}
