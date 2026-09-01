import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { LeaveDoc } from "../db/types.js";

/**
 * Leave suspends assessment, freezes streaks, greys the rings and hides the
 * member from public leaderboards. It never deletes or rewrites their history.
 */

export async function createLeaveRequest(
    staffId: ObjectId,
    startDate: Date,
    endDate: Date | null,
    reason: string
): Promise<LeaveDoc> {
    const doc: LeaveDoc = {
        _id: new ObjectId(),
        staffId,
        requestedAt: new Date(),
        startDate,
        endDate,
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
        $or: [{ endDate: null }, { endDate: { $gte: at } }]
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
 * Leave records that overlap [from, to). Used to mark a week or a fortnight
 * exempt. Approved but not yet activated leave counts: the exemption follows
 * the decision, not the role change.
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
            status: { $in: ["approved", "active", "ended"] },
            startDate: { $lt: to },
            $or: [{ endDate: null }, { endDate: { $gte: from } }]
        })
        .toArray();
}

export async function isOnLeaveDuring(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<boolean> {
    const overlaps = await leaveOverlapping(staffId, from, to);
    return overlaps.length > 0;
}

export interface LeaveCoverage {
    /** Leave covers every moment of the window. The week is genuinely absent. */
    full: boolean;
    /** Leave touches the window without covering it. Part of the week was worked. */
    partial: boolean;
    /** When the leave ended, if it ended inside the window. */
    endedAt: Date | null;
    /** When the leave began, if it began inside the window. */
    startedAt: Date | null;
}

/**
 * How much of a window leave actually covers.
 *
 * The distinction matters because "on leave" greys a member's rings, exempts
 * them from assessment and hides their figures. Applying that to a week in
 * which leave ended on the Tuesday told everyone the member was away all week
 * when they had in fact worked five days of it, and hid the minutes they
 * earned. So full coverage and partial coverage are different answers now, and
 * only full coverage suspends anything.
 *
 * Overlapping and adjacent leave records are merged before measuring, so two
 * back-to-back records covering a week between them count as covering it.
 */
export async function leaveCoverageFor(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<LeaveCoverage> {
    return coverageOf(await leaveOverlapping(staffId, from, to), from, to);
}

/**
 * The measuring itself, as a pure function over records already fetched.
 *
 * Overlapping and adjacent records are merged before measuring, so two
 * back-to-back leaves covering a week between them count as covering it.
 */
export function coverageOf(
    records: Pick<LeaveDoc, "startDate" | "endDate">[],
    from: Date,
    to: Date
): LeaveCoverage {
    const none: LeaveCoverage = { full: false, partial: false, endedAt: null, startedAt: null };
    if (records.length === 0) return none;

    const windowFrom = from.getTime();
    const windowTo = to.getTime();

    const clipped = records
        .map((record) => ({
            from: Math.max(windowFrom, record.startDate.getTime()),
            // Open ended leave runs past any window we could be asked about.
            to: Math.min(windowTo, record.endDate ? record.endDate.getTime() : windowTo),
            rawStart: record.startDate.getTime(),
            rawEnd: record.endDate ? record.endDate.getTime() : null
        }))
        .filter((span) => span.to > span.from)
        .sort((left, right) => left.from - right.from);

    if (clipped.length === 0) return none;

    // Merge, then ask whether the merged run reaches both edges of the window.
    const runStart = clipped[0].from;
    let reach = clipped[0].to;
    let covered = true;
    for (const span of clipped.slice(1)) {
        if (span.from > reach) {
            covered = false;
            break;
        }
        reach = Math.max(reach, span.to);
    }
    const full = covered && runStart <= windowFrom && reach >= windowTo;

    const endedAt = clipped
        .map((span) => span.rawEnd)
        .filter((end): end is number => end !== null && end > windowFrom && end < windowTo)
        .sort((left, right) => right - left)[0];

    const startedAt = clipped
        .map((span) => span.rawStart)
        .filter((start) => start > windowFrom && start < windowTo)
        .sort((left, right) => left - right)[0];

    return {
        full,
        partial: !full,
        endedAt: endedAt === undefined ? null : new Date(endedAt),
        startedAt: startedAt === undefined ? null : new Date(startedAt)
    };
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

export async function markLeaveActive(
    leaveId: ObjectId,
    removedRoles: string[]
): Promise<void> {
    await collections
        .leave()
        .updateOne({ _id: leaveId }, { $set: { status: "active", removedRoles } });
}

export async function markLeaveEnded(
    leaveId: ObjectId,
    restoreErrors: string[]
): Promise<void> {
    await collections.leave().updateOne(
        { _id: leaveId },
        { $set: { status: "ended", rolesRestoredAt: new Date(), restoreErrors } }
    );
}

/**
 * Push out a return date. The extension reason is appended rather than
 * replacing the original, so an Executive reading the record later sees the
 * whole story and not just the most recent sentence.
 */
export async function extendLeave(
    leaveId: ObjectId,
    endDate: Date | null,
    reasonNote?: string
): Promise<LeaveDoc | null> {
    const existing = await collections.leave().findOne({ _id: leaveId });
    if (!existing) return null;

    const reason = reasonNote
        ? `${existing.reason}\n\nExtension requested ${new Date()
              .toISOString()
              .slice(0, 10)}: ${reasonNote}`.slice(0, 4000)
        : existing.reason;

    return collections.leave().findOneAndUpdate(
        { _id: leaveId, status: { $in: ["approved", "active"] } },
        { $set: { endDate, reason } },
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

/** Active leave whose end date has passed. Open-ended leave never appears here. */
export async function leaveDueToEnd(at = new Date()): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({ status: "active", endDate: { $ne: null, $lte: at } })
        .toArray();
}

export async function currentAndUpcomingLeave(at = new Date()): Promise<LeaveDoc[]> {
    return collections
        .leave()
        .find({
            status: { $in: ["pending", "approved", "active"] },
            $or: [{ endDate: null }, { endDate: { $gte: at } }]
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

/** Staff IDs with leave overlapping the window at all, resolved in one query. */
export async function staffOnLeaveDuring(from: Date, to: Date): Promise<Set<string>> {
    const docs = await collections
        .leave()
        .find({
            status: { $in: ["approved", "active", "ended"] },
            startDate: { $lt: to },
            $or: [{ endDate: null }, { endDate: { $gte: from } }]
        })
        .project<{ staffId: ObjectId }>({ staffId: 1 })
        .toArray();
    return new Set(docs.map((doc) => doc.staffId.toHexString()));
}

/**
 * Staff IDs whose leave covers the whole window, which is the only kind that
 * should show as "on leave" rather than as a low score. Someone whose leave
 * ended on the Tuesday worked most of that week and their figures say so.
 */
export async function staffFullyOnLeaveDuring(
    from: Date,
    to: Date
): Promise<Set<string>> {
    const candidates = await staffOnLeaveDuring(from, to);
    const full = new Set<string>();
    for (const key of candidates) {
        const coverage = await leaveCoverageFor(new ObjectId(key), from, to);
        if (coverage.full) full.add(key);
    }
    return full;
}
