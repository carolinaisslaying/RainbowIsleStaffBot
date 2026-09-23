import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { LeaveDoc } from "../db/types.js";
import { weekLeave, type LeaveSpan, type WeekLeave } from "./leaveDays.js";

/**
 * Leave suspends assessment for the weeks it exempts, freezes streaks, greys
 * the rings and hides the member from public leaderboards. It never deletes or
 * rewrites their history.
 *
 * How much leave exempts what is `domain/leaveDays.ts`. This file is the
 * records.
 */

/** The statuses whose leave counts towards an exemption. */
const COUNTING: LeaveDoc["status"][] = ["approved", "active", "ended"];

export async function createLeaveRequest(
    staffId: ObjectId,
    startDate: Date,
    endDate: Date,
    reason: string
): Promise<LeaveDoc> {
    const doc: LeaveDoc = {
        _id: new ObjectId(),
        staffId,
        requestedAt: new Date(),
        startDate,
        endDate,
        plannedEndDate: null,
        pendingExtension: null,
        reason,
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        removedRoles: [],
        rolesRestoredAt: null,
        restoreErrors: []
    };
    await collections.leave().insertOne(doc);
    return doc;
}

export async function findLeave(leaveId: ObjectId): Promise<LeaveDoc | null> {
    return collections.leave().findOne({ _id: leaveId });
}

export async function activeLeaveFor(
    staffId: ObjectId,
    at = new Date()
): Promise<LeaveDoc | null> {
    return collections.leave().findOne({
        staffId,
        status: "active",
        startDate: { $lte: at },
        endDate: { $gte: at }
    });
}

export async function pendingOrApprovedLeaveFor(staffId: ObjectId): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({ staffId, status: { $in: ["pending", "approved", "active"] } })
        .sort({ startDate: 1 })
        .toArray();
}

/**
 * Leave records that overlap [from, to) and count towards an exemption.
 * Approved but not yet activated leave counts: the exemption follows the
 * decision, not the role change.
 */
export async function leaveOverlapping(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({
            staffId,
            status: { $in: COUNTING },
            startDate: { $lt: to },
            endDate: { $gt: from }
        })
        .toArray();
}

/**
 * Leave waiting on an Executive that overlaps [from, to), as the spans it would
 * add if approved: a pending request's whole window, and the stretch a pending
 * extension would add beyond the current end.
 */
export async function pendingSpansOverlapping(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<LeaveSpan[]> {
    const records = await collections
        .leave()
        .find({
            staffId,
            $or: [
                { status: "pending", startDate: { $lt: to }, endDate: { $gt: from } },
                {
                    status: { $in: ["approved", "active"] },
                    "pendingExtension.endDate": { $gt: from },
                    endDate: { $lt: to }
                }
            ]
        })
        .toArray();

    return records.map((record) =>
        record.status === "pending"
            ? { startDate: record.startDate, endDate: record.endDate }
            : {
                  startDate: record.endDate,
                  endDate: (record.pendingExtension as { endDate: Date }).endDate
              }
    );
}

/** A member's leave in one week, and whether it exempts the week. */
export async function weekLeaveFor(
    staffId: ObjectId,
    from: Date,
    to: Date,
    minimumLeaveDays: number
): Promise<WeekLeave> {
    return weekLeave(await leaveOverlapping(staffId, from, to), from, to, minimumLeaveDays);
}

/** Staff ids whose leave exempts the window, resolved in one query. */
export async function staffExemptDuring(
    from: Date,
    to: Date,
    minimumLeaveDays: number
): Promise<Set<string>> {
    const docs = await collections
        .leave()
        .find({ status: { $in: COUNTING }, startDate: { $lt: to }, endDate: { $gt: from } })
        .toArray();

    const byStaff = new Map<string, LeaveDoc[]>();
    for (const doc of docs) {
        const key = doc.staffId.toHexString();
        byStaff.set(key, [...(byStaff.get(key) ?? []), doc]);
    }

    const exempt = new Set<string>();
    for (const [key, records] of byStaff) {
        if (weekLeave(records, from, to, minimumLeaveDays).exempt) exempt.add(key);
    }
    return exempt;
}

export async function decideLeave(
    leaveId: ObjectId,
    approved: boolean,
    decidedBy: ObjectId
): Promise<LeaveDoc | null> {
    return collections.leave().findOneAndUpdate(
        { _id: leaveId, status: "pending" },
        {
            $set: {
                status: approved ? "approved" : "declined",
                decidedBy,
                decidedAt: new Date()
            }
        },
        { returnDocument: "after" }
    );
}

/**
 * Move approved leave to active. False when it is no longer approved, which
 * means an Executive cancelled it while the roles were being removed: the
 * cancellation stands and the caller has to put the roles back.
 */
export async function markLeaveActive(
    leaveId: ObjectId,
    removedRoles: string[]
): Promise<boolean> {
    const result = await collections
        .leave()
        .updateOne({ _id: leaveId, status: "approved" }, { $set: { status: "active", removedRoles } });
    return result.matchedCount > 0;
}

/**
 * Call off leave before it starts: a request still waiting on a decision, or
 * approved leave. Conditional on the status so it cannot race the sweep or a
 * decision: a leave that activated first comes back null, and the caller ends
 * it instead, because by then there are roles to restore.
 */
export async function markLeaveCancelled(
    leave: LeaveDoc,
    cancelledBy: ObjectId,
    reason: string | null,
    at = new Date()
): Promise<LeaveDoc | null> {
    return collections.leave().findOneAndUpdate(
        { _id: leave._id, status: { $in: ["pending", "approved"] } },
        {
            $set: {
                status: "cancelled",
                cancelledBy,
                cancelledAt: at,
                cancellationReason: reason,
                // An extension on a leave that never started has nothing to extend.
                pendingExtension: null
            }
        },
        { returnDocument: "after" }
    );
}

/**
 * Where a leave ending at `at` actually ends: the booked date if it ran its
 * course, the moment it stopped if that came sooner, and never before it
 * started, so a leave cancelled before it began covers nothing.
 */
export function actualEnd(leave: Pick<LeaveDoc, "startDate" | "endDate">, at: Date): Date {
    const end = Math.min(leave.endDate.getTime(), at.getTime());
    return new Date(Math.max(leave.startDate.getTime(), end));
}

/**
 * Close a leave record. An early end moves `endDate` to the moment it ended
 * and keeps the booked date in `plannedEndDate`, so a fortnight is exempted by
 * the leave somebody took rather than the leave they booked.
 */
export async function markLeaveEnded(
    leave: LeaveDoc,
    restoreErrors: string[],
    endedEarlyBy: ObjectId | null = null,
    at = new Date(),
    endedEarlyReason: string | null = null
): Promise<LeaveDoc | null> {
    const end = actualEnd(leave, at);
    const early = end.getTime() < leave.endDate.getTime();
    return collections.leave().findOneAndUpdate(
        { _id: leave._id },
        {
            $set: {
                status: "ended",
                rolesRestoredAt: at,
                restoreErrors,
                endedEarlyBy,
                endedEarlyReason,
                endDate: end,
                plannedEndDate: early ? leave.endDate : leave.plannedEndDate ?? null,
                // An extension still waiting when the leave ends has nothing
                // left to extend.
                pendingExtension: null
            }
        },
        { returnDocument: "after" }
    );
}

/**
 * Remember where the request's card was posted.
 *
 * Every later change of state edits that one card rather than posting a second
 * message about the same leave, so the channel reads as one row per request
 * from "pending" through to "ended". That is only possible if the record knows
 * where its own card is.
 */
export async function recordLeaveCard(
    leaveId: ObjectId,
    channelId: string,
    messageId: string
): Promise<void> {
    await collections
        .leave()
        .updateOne({ _id: leaveId }, { $set: { logChannelId: channelId, logMessageId: messageId } });
}

/**
 * Ask for a later return date. The leave keeps running on its current end
 * until an Executive decides, so nothing about the member's roles or their
 * requirement moves yet.
 */
export async function requestExtension(
    leaveId: ObjectId,
    endDate: Date,
    reason: string,
    at = new Date()
): Promise<LeaveDoc | null> {
    return collections.leave().findOneAndUpdate(
        {
            _id: leaveId,
            status: { $in: ["approved", "active"] },
            endDate: { $lt: endDate },
            pendingExtension: null
        },
        { $set: { pendingExtension: { endDate, reason, requestedAt: at } } },
        { returnDocument: "after" }
    );
}

/**
 * Decide a pending extension. Approving moves the end date and appends the
 * member's reason to the record, so an Executive reading it later sees the
 * whole story and not only the most recent sentence. Declining leaves the
 * leave exactly as it was.
 */
export async function decideExtension(
    leave: LeaveDoc,
    approved: boolean
): Promise<LeaveDoc | null> {
    const extension = leave.pendingExtension;
    if (!extension) return null;

    const reason = approved
        ? `${leave.reason}\n\nExtended to ${extension.endDate.toISOString().slice(0, 10)}: ` +
          extension.reason
        : leave.reason;

    return collections.leave().findOneAndUpdate(
        {
            _id: leave._id,
            status: { $in: ["approved", "active"] },
            "pendingExtension.requestedAt": extension.requestedAt
        },
        {
            $set: {
                ...(approved ? { endDate: extension.endDate } : {}),
                reason: reason.slice(0, 4000),
                pendingExtension: null
            }
        },
        { returnDocument: "after" }
    );
}

/** Approved leave whose start date has arrived but which is not yet active. */
export async function leaveDueToActivate(at = new Date()): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({ status: "approved", startDate: { $lte: at } })
        .toArray();
}

/** Active leave whose end date has passed. */
export async function leaveDueToEnd(at = new Date()): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({ status: "active", endDate: { $lte: at } })
        .toArray();
}

export async function currentAndUpcomingLeave(at = new Date()): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({
            status: { $in: ["pending", "approved", "active"] },
            endDate: { $gte: at }
        })
        .sort({ startDate: 1 })
        .toArray();
}

/**
 * Remove one leave record permanently.
 *
 * The only deleting operation in the domain. It takes the record's own id
 * rather than a staff id so that nothing can widen accidentally: a purge is
 * always one decision about one record, made by a person looking at it.
 */
export async function purgeLeaveRecord(leaveId: ObjectId): Promise<boolean> {
    const result = await collections.leave().deleteOne({ _id: leaveId });
    return result.deletedCount === 1;
}

export async function leaveHistory(staffId: ObjectId): Promise<LeaveDoc[]> {
    return collections.leave().find({ staffId }).sort({ startDate: -1 }).toArray();
}

/** A member's other leave, for comparing their requirement with and without one record. */
export async function otherCountingLeave(
    staffId: ObjectId,
    excludeId: ObjectId | null
): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({
            staffId,
            status: { $in: COUNTING },
            ...(excludeId ? { _id: { $ne: excludeId } } : {})
        })
        .toArray();
}
