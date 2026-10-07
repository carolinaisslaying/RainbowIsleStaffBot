import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type {
    StaffOfWeekDoc,
    StaffOfWeekEvent,
    StaffOfWeekEventKind,
    StaffOfWeekStatus
} from "../db/types.js";
import type { HolderRecord } from "./staffOfWeek.js";

/**
 * The `staffOfWeek` collection. One document per week, never deleted: a
 * removal is an event. Every write appends to `events`, which is the week's
 * history in order.
 */

export function sotwEvent(
    kind: StaffOfWeekEventKind,
    options: {
        actorId?: string | null;
        staffId?: ObjectId | null;
        reason?: string | null;
        detail?: Record<string, unknown> | null;
    },
    at = new Date()
): StaffOfWeekEvent {
    return {
        kind,
        at,
        actorId: options.actorId ?? null,
        staffId: options.staffId ?? null,
        reason: options.reason ?? null,
        detail: options.detail ?? null
    };
}

export function toHolderRecord(
    doc: Pick<StaffOfWeekDoc, "holders" | "removedHolders"> | null
): HolderRecord | null {
    if (!doc) return null;
    return {
        holders: (doc.holders ?? []).map((id) => id.toHexString()),
        removedHolders: (doc.removedHolders ?? []).map((id) => id.toHexString())
    };
}

export async function findWeek(weekStart: Date): Promise<StaffOfWeekDoc | null> {
    return collections.staffOfWeek().findOne({ weekStart });
}

export async function findWeeks(starts: Date[]): Promise<Map<number, StaffOfWeekDoc>> {
    const docs = await collections.staffOfWeek().find({ weekStart: { $in: starts } }).toArray();
    return new Map(docs.map((doc) => [doc.weekStart.getTime(), doc]));
}

export async function anyStaffOfWeek(): Promise<boolean> {
    return (await collections.staffOfWeek().findOne({}, { projection: { _id: 1 } })) !== null;
}

export async function recentWeeks(before: Date, limit: number): Promise<StaffOfWeekDoc[]> {
    return collections
        .staffOfWeek()
        .find({ weekStart: { $lt: before } })
        .sort({ weekStart: -1 })
        .limit(limit)
        .toArray();
}

/**
 * Everybody the bot has recorded on the role in its most recent weeks —
 * holders, picks and removed holders alike — so a handoff can take the role
 * off whoever had it without fetching all of the community server's members.
 */
export async function recentRoleHolderIds(limit = 6): Promise<ObjectId[]> {
    const docs = await collections
        .staffOfWeek()
        .find({}, { projection: { staffId: 1, holders: 1, removedHolders: 1 } })
        .sort({ weekStart: -1 })
        .limit(limit)
        .toArray();
    const seen = new Map<string, ObjectId>();
    for (const doc of docs) {
        for (const id of [doc.staffId, ...(doc.holders ?? []), ...(doc.removedHolders ?? [])]) {
            if (id) seen.set(id.toHexString(), id);
        }
    }
    return [...seen.values()];
}

export async function weeksHeldBy(staffId: ObjectId): Promise<StaffOfWeekDoc[]> {
    return collections.staffOfWeek().find({ holders: staffId }).sort({ weekStart: 1 }).toArray();
}

type WeekFields = Partial<{
    status: StaffOfWeekStatus;
    staffId: ObjectId | null;
    decidedBy: string | null;
    decidedAt: Date | null;
    handedOffAt: Date | null;
}>;

/**
 * Upsert one week. `$setOnInsert` fills whatever this write does not set, and
 * never names a field an `$addToSet` or `$push` in the same write touches —
 * MongoDB refuses a write that does both to one field.
 */
async function writeWeek(
    weekStart: Date,
    write: { set?: WeekFields; event?: StaffOfWeekEvent; addHolder?: ObjectId; addRemoved?: ObjectId },
    now: Date
): Promise<void> {
    const set: Record<string, unknown> = { ...(write.set ?? {}), updatedAt: now };
    const onInsert: Record<string, unknown> = { _id: new ObjectId(), weekStart, createdAt: now };
    const defaults: Record<string, unknown> = {
        status: "pending",
        staffId: null,
        decidedBy: null,
        decidedAt: null,
        handedOffAt: null
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in set)) onInsert[key] = value;
    }

    const addToSet: Record<string, ObjectId> = {};
    if (write.addHolder) addToSet.holders = write.addHolder;
    else onInsert.holders = [];
    if (write.addRemoved) addToSet.removedHolders = write.addRemoved;
    else onInsert.removedHolders = [];

    const update: Record<string, unknown> = { $set: set, $setOnInsert: onInsert };
    if (write.event) update.$push = { events: write.event };
    else onInsert.events = [];
    if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet;

    await collections.staffOfWeek().updateOne({ weekStart }, update as never, { upsert: true });
}

export async function recordPick(
    weekStart: Date,
    staffId: ObjectId,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<{ replaced: ObjectId | null }> {
    const existing = await findWeek(weekStart);
    const hadPick = existing?.status === "pending" && existing.staffId !== null;
    const replaced = hadPick && existing?.staffId && !existing.staffId.equals(staffId) ? existing.staffId : null;
    await writeWeek(
        weekStart,
        {
            set: { status: "pending", staffId, decidedBy: actorId, decidedAt: now },
            event: sotwEvent(hadPick ? "replaced" : "set", { actorId, staffId, reason }, now)
        },
        now
    );
    return { replaced };
}

export async function recordSkip(
    weekStart: Date,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: { status: "skipped", staffId: null, decidedBy: actorId, decidedAt: now },
            event: sotwEvent("skipped", { actorId, reason }, now)
        },
        now
    );
}

/** Somebody now holds the week: at the handoff, or for the rest of it. */
export async function recordGrant(
    weekStart: Date,
    grant: {
        staffId: ObjectId;
        status: "picked" | "random";
        decidedBy: string | null;
        eventKind: "set" | "drawn" | null;
        reason: string | null;
        detail: Record<string, unknown> | null;
    },
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: {
                status: grant.status,
                staffId: grant.staffId,
                decidedBy: grant.decidedBy,
                // A draw or a rest-of-week grant is decided now. A pick being
                // handed off keeps the time the Executive decided it.
                ...(grant.eventKind !== null ? { decidedAt: now } : {})
            },
            event: grant.eventKind
                ? sotwEvent(
                      grant.eventKind,
                      { actorId: grant.decidedBy, staffId: grant.staffId, reason: grant.reason, detail: grant.detail },
                      now
                  )
                : undefined,
            addHolder: grant.staffId
        },
        now
    );
}

export async function recordEmpty(
    weekStart: Date,
    reason: string,
    detail: Record<string, unknown> | null,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        { set: { status: "empty", staffId: null }, event: sotwEvent("empty", { reason, detail }, now) },
        now
    );
}

export async function recordRemoval(
    weekStart: Date,
    staffId: ObjectId,
    actorId: string | null,
    reason: string,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: { status: "empty", staffId: null },
            event: sotwEvent("removed", { actorId, staffId, reason }, now),
            addRemoved: staffId
        },
        now
    );
}

export async function appendEvent(weekStart: Date, event: StaffOfWeekEvent): Promise<void> {
    await collections
        .staffOfWeek()
        .updateOne({ weekStart }, { $push: { events: event }, $set: { updatedAt: event.at } });
}

export async function markHandedOff(
    weekStart: Date,
    detail: Record<string, unknown> | null,
    now = new Date()
): Promise<void> {
    await writeWeek(weekStart, { set: { handedOffAt: now }, event: sotwEvent("handoff", { detail }, now) }, now);
}
