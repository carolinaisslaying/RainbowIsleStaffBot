import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { PauseCause, ShiftDoc, ShiftEndReason, ShiftPause } from "../db/types.js";
import { countMinutesBetween } from "./activity.js";

/**
 * Three states: Available, Away, Ended.
 *
 * The document carries no state field. State is derived: no open shift means
 * Ended, an open shift whose last pause is unclosed means Away, anything else
 * means Available. One source of truth, so a crash cannot desynchronise a
 * status flag from the pause list.
 */

export type ShiftState = "available" | "away" | "ended";

export interface Interval {
    from: Date;
    to: Date;
}

export function stateOf(shift: ShiftDoc | null): ShiftState {
    if (!shift || shift.endedAt) return "ended";
    return openPauseOf(shift) ? "away" : "available";
}

export function openPauseOf(shift: ShiftDoc): ShiftPause | null {
    for (let index = shift.pauses.length - 1; index >= 0; index -= 1) {
        if (shift.pauses[index].to === null) return shift.pauses[index];
    }
    return null;
}

export async function getOpenShift(staffId: ObjectId): Promise<ShiftDoc | null> {
    return collections.shifts().findOne({ staffId, endedAt: null });
}

export async function listOpenShifts(): Promise<ShiftDoc[]> {
    return collections.shifts().find({ endedAt: null }).toArray();
}

export async function startShift(staffId: ObjectId, at = new Date()): Promise<ShiftDoc> {
    const shift: ShiftDoc = {
        _id: new ObjectId(),
        staffId,
        startedAt: at,
        endedAt: null,
        endReason: null,
        pauses: [],
        availableMs: 0,
        activityMinutes: 0
    };
    await collections.shifts().insertOne(shift);
    return shift;
}

/**
 * Enter Away. Idempotent by construction: the filter refuses to match a shift
 * that already has an open pause, so a presence event and an inactivity sweep
 * landing on the same member in the same second cannot stack two pauses.
 */
export async function pauseShift(
    shiftId: ObjectId,
    cause: PauseCause,
    at = new Date()
): Promise<boolean> {
    const result = await collections.shifts().updateOne(
        {
            _id: shiftId,
            endedAt: null,
            // No element with to: null. This covers both a shift that has never
            // paused and one whose pauses have all closed.
            pauses: { $not: { $elemMatch: { to: null } } }
        },
        { $push: { pauses: { from: at, to: null, cause } } }
    );
    return result.modifiedCount > 0;
}

/** Return to Available. Closes the open pause. Idempotent. */
export async function resumeShift(shiftId: ObjectId, at = new Date()): Promise<boolean> {
    const result = await collections.shifts().updateOne(
        { _id: shiftId, endedAt: null, "pauses.to": null },
        { $set: { "pauses.$[open].to": at } },
        { arrayFilters: [{ "open.to": null }] }
    );
    return result.modifiedCount > 0;
}

/**
 * Available intervals of a shift: the shift window minus its pauses, clamped so
 * an open pause or an open shift is measured only up to `now`. Pure, so the
 * state machine tests can drive it without a database.
 */
export function availableIntervals(shift: ShiftDoc, now = new Date()): Interval[] {
    const start = shift.startedAt.getTime();
    const end = (shift.endedAt ?? now).getTime();
    if (end <= start) return [];

    const pauses = shift.pauses
        .map((pause) => ({
            from: Math.max(start, pause.from.getTime()),
            to: Math.min(end, (pause.to ?? new Date(end)).getTime())
        }))
        .filter((pause) => pause.to > pause.from)
        .sort((left, right) => left.from - right.from);

    const intervals: Interval[] = [];
    let cursor = start;
    for (const pause of pauses) {
        if (pause.from > cursor) {
            intervals.push({ from: new Date(cursor), to: new Date(pause.from) });
        }
        cursor = Math.max(cursor, pause.to);
    }
    if (cursor < end) intervals.push({ from: new Date(cursor), to: new Date(end) });
    return intervals;
}

/** Clocked availability in milliseconds. Not activity minutes. Never conflate them. */
export function computeAvailableMs(shift: ShiftDoc, now = new Date()): number {
    return availableIntervals(shift, now).reduce(
        (total, interval) => total + (interval.to.getTime() - interval.from.getTime()),
        0
    );
}

export function computePausedMs(shift: ShiftDoc, now = new Date()): number {
    const start = shift.startedAt.getTime();
    const end = (shift.endedAt ?? now).getTime();
    return Math.max(0, end - start) - computeAvailableMs(shift, now);
}

/**
 * Activity minutes credited during this shift's Available windows. Each
 * interval is summed separately, so a window crossing a UTC midnight is two
 * bitmap slices added together rather than a special case.
 */
export async function computeShiftActivityMinutes(
    shift: ShiftDoc,
    now = new Date()
): Promise<number> {
    let total = 0;
    for (const interval of availableIntervals(shift, now)) {
        total += await countMinutesBetween(shift.staffId, interval.from, interval.to);
    }
    return total;
}

export interface ClosedShift {
    shift: ShiftDoc;
    durationMs: number;
    availableMs: number;
    pausedMs: number;
    activityMinutes: number;
}

export async function endShift(
    shiftId: ObjectId,
    reason: ShiftEndReason,
    at = new Date()
): Promise<ClosedShift | null> {
    // Close any open pause first, so availableMs is measured to the same instant.
    await resumeShift(shiftId, at);

    const shift = await collections.shifts().findOne({ _id: shiftId, endedAt: null });
    if (!shift) return null;

    const closed: ShiftDoc = { ...shift, endedAt: at, endReason: reason };
    const availableMs = computeAvailableMs(closed, at);
    const activityMinutes = await computeShiftActivityMinutes(closed, at);

    const result = await collections.shifts().updateOne(
        { _id: shiftId, endedAt: null },
        { $set: { endedAt: at, endReason: reason, availableMs, activityMinutes } }
    );
    if (result.modifiedCount === 0) return null;

    const durationMs = at.getTime() - shift.startedAt.getTime();
    return {
        shift: { ...closed, availableMs, activityMinutes },
        durationMs,
        availableMs,
        pausedMs: Math.max(0, durationMs - availableMs),
        activityMinutes
    };
}

/** Shift milliseconds overlapping [from, to). Open shifts count up to `to`. */
export function shiftMsInWindow(shift: ShiftDoc, from: Date, to: Date, now = new Date()): number {
    let total = 0;
    for (const interval of availableIntervals(shift, now)) {
        const overlapFrom = Math.max(interval.from.getTime(), from.getTime());
        const overlapTo = Math.min(interval.to.getTime(), to.getTime());
        if (overlapTo > overlapFrom) total += overlapTo - overlapFrom;
    }
    return total;
}

export async function shiftsOverlapping(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<ShiftDoc[]> {
    return collections
        .shifts()
        .find({
            staffId,
            startedAt: { $lt: to },
            $or: [{ endedAt: null }, { endedAt: { $gt: from } }]
        })
        .sort({ startedAt: 1 })
        .toArray();
}

export async function allShiftsOverlapping(from: Date, to: Date): Promise<ShiftDoc[]> {
    return collections
        .shifts()
        .find({
            startedAt: { $lt: to },
            $or: [{ endedAt: null }, { endedAt: { $gt: from } }]
        })
        .sort({ startedAt: 1 })
        .toArray();
}

export async function shiftHistory(staffId: ObjectId, limit = 25): Promise<ShiftDoc[]> {
    return collections
        .shifts()
        .find({ staffId })
        .sort({ startedAt: -1 })
        .limit(limit)
        .toArray();
}
