import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { LeaveDoc } from "../db/types.js";
import { coverageOf, leaveOverlapping } from "./leave.js";
import { windowForIndex } from "./assessments.js";
import { fortnightAnchorDate } from "../config/guildConfig.js";
import { fortnightIndexFor, weekStartFor } from "../time/calendar.js";

/**
 * What a purge would quietly change somewhere else.
 *
 * Leave is not inert once it has been taken. A fortnight in which a member was
 * away for a full week is assessed as exempt, and that verdict is not stored as
 * a fact about the fortnight — it is recomputed from the leave records every
 * time `/admin recompute` runs. Delete the leave and the exemption goes with
 * it, so a fortnight that was settled months ago comes back as a real pass or
 * fail against figures the member had no chance to earn.
 *
 * The damage is invisible at the moment of the purge and surfaces weeks later
 * in somebody else's report, which is exactly the kind of consequence that has
 * to be put in front of the person clicking the button.
 */

export interface LostExemption {
    index: number;
    windowStart: Date;
    windowEnd: Date;
}

/**
 * The fortnights that are exempt today and would stop being exempt if this
 * record were removed.
 *
 * Measured by recomputing each affected fortnight's coverage with the record
 * and without it, rather than by assuming any overlap matters: a fortnight
 * covered by a second, overlapping leave record loses nothing when this one
 * goes, and warning about it would train people to ignore the warning.
 */
export async function exemptionsLostByPurging(
    leave: LeaveDoc,
    config: StaffBotConfig
): Promise<LostExemption[]> {
    const anchor = fortnightAnchorDate(config);
    const zone = config.accountingTimezone;
    const from = leave.startDate;
    // Open ended leave has no last day of its own, so measure to today: no
    // fortnight beyond that has been assessed yet.
    const to = leave.endDate ?? new Date(Math.max(Date.now(), from.getTime()));

    const firstIndex = fortnightIndexFor(weekStartFor(from, zone, config.weekStartDay), anchor);
    const lastIndex = fortnightIndexFor(weekStartFor(to, zone, config.weekStartDay), anchor);

    const lost: LostExemption[] = [];

    for (let index = firstIndex; index <= lastIndex; index += 1) {
        const window = windowForIndex(index, config);

        const halves: Array<[Date, Date]> = [
            [window.week1Start, window.week2Start],
            [window.week2Start, window.end]
        ];

        let exemptNow = false;
        let exemptAfter = false;

        for (const [start, end] of halves) {
            const records = await leaveOverlapping(leave.staffId, start, end);
            const remaining = records.filter((record) => !record._id.equals(leave._id));
            if (coverageOf(records, start, end).full) exemptNow = true;
            if (coverageOf(remaining, start, end).full) exemptAfter = true;
        }

        if (exemptNow && !exemptAfter) {
            lost.push({ index, windowStart: window.week1Start, windowEnd: window.end });
        }
    }

    return lost;
}

/**
 * True when removing this record would strand the member without their roles.
 *
 * Activating leave takes a member's ranks away and writes down which ones, and
 * that snapshot is the only record of what to give back. Purging it while the
 * leave is still running leaves a person with no roles and nothing anywhere
 * saying what they held, which no amount of auditing can repair.
 */
export function holdsUnrestoredRoles(leave: LeaveDoc): boolean {
    return (
        leave.status === "active" &&
        leave.removedRoles.length > 0 &&
        leave.rolesRestoredAt === null
    );
}

export type { ObjectId };
