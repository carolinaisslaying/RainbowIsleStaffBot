import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { AssessmentStatus, LeaveDoc } from "../db/types.js";
import { leaveOverlapping } from "./leave.js";
import { assessmentVerdict, findAssessmentFor, rulesOf } from "./assessments.js";
import { fortnightsTouching, type LeaveSpan } from "./leaveDays.js";
import { fortnightAnchorDate } from "../config/guildConfig.js";

/**
 * What a purge would change somewhere else.
 *
 * Leave is not inert once it has been taken. It exempts weeks, and an exempt
 * week lowers or waives its fortnight's requirement. Delete the leave and the
 * purge reassesses those fortnights without it, so a verdict settled months
 * ago can come back as a shortfall against figures the member had no chance to
 * earn. The confirmation names every verdict that would move before anybody
 * clicks.
 */

export interface VerdictChange {
    index: number;
    windowStart: Date;
    windowEnd: Date;
    before: { status: AssessmentStatus; requiredMinutes: number };
    after: { status: AssessmentStatus; requiredMinutes: number };
}

/**
 * The closed, assessed fortnights whose verdict moves if this record is gone.
 *
 * Measured by reassessing each fortnight with the record and without it,
 * against the rules and minutes already stored, rather than by assuming any
 * overlap matters: a fortnight a second leave record still exempts loses
 * nothing, and warning about it would train people to ignore the warning.
 */
export async function verdictsChangedByPurging(
    leave: LeaveDoc,
    config: StaffBotConfig
): Promise<VerdictChange[]> {
    const rules = {
        anchor: fortnightAnchorDate(config),
        timeZone: config.accountingTimezone,
        weekStartDay: config.weekStartDay
    };

    const changes: VerdictChange[] = [];
    for (const window of fortnightsTouching(leave, rules)) {
        const stored = await findAssessmentFor(leave.staffId, window.index);
        if (!stored || stored.rehearsal) continue;

        const counting = await leaveOverlapping(leave.staffId, window.week1Start, window.end);
        const without = counting.filter((record) => !record._id.equals(leave._id));
        const judge = (spans: LeaveSpan[]) =>
            assessmentVerdict({
                week1Minutes: stored.week1Minutes,
                week2Minutes: stored.week2Minutes,
                counting: spans,
                pending: [],
                window,
                rules: rulesOf(stored)
            });

        const before = judge(counting);
        const after = judge(without);
        if (before.status === after.status && before.requiredMinutes === after.requiredMinutes) {
            continue;
        }
        changes.push({
            index: window.index,
            windowStart: window.week1Start,
            windowEnd: window.end,
            before: { status: before.status, requiredMinutes: before.requiredMinutes },
            after: { status: after.status, requiredMinutes: after.requiredMinutes }
        });
    }
    return changes;
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
