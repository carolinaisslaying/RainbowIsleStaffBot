import { Binary, ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { ActivityDayDoc } from "../db/types.js";
import {
    BITMAP_BYTES,
    countRange,
    emptyBitmap,
    hourHistogram,
    isMinuteSet,
    minuteOfUtcDay,
    normaliseBitmap,
    popcount,
    setMinute,
    setMinutes
} from "./bitmap.js";
import { utcDayKey, utcDayKeysBetween, dayKeyToDate, MINUTE_MS } from "../time/calendar.js";
import { withLock } from "../util/mutex.js";

/**
 * A staff member earns one activity minute for a UTC clock minute if, during
 * that minute, they had an open shift, that shift was Available rather than
 * paused, and they sent at least one message in a whitelisted public channel.
 *
 * Multiple messages in the same minute earn nothing extra: the bucket boundary
 * sits on the wall clock, so crediting is idempotent by construction.
 *
 * On the write path. The spec asks for a single upsert using $bit with an or
 * mask. MongoDB's $bit operator applies to integer fields only and cannot reach
 * inside a BinData value, so a literal reading of that is not expressible in
 * MQL against the document shape the spec also mandates. What we do instead
 * keeps both the shape and the cost: an in-process per-day lock plus a hot
 * bitmap cache means the overwhelming majority of credits are a cache hit on an
 * already set bit and cost zero writes, and a genuine new minute costs exactly
 * one write. The lock makes the read-modify-write atomic within this process,
 * which is the only writer. `count` is maintained on that write and rebuilt
 * nightly by recomputeCounts(), so it stays advisory as the spec intends.
 */

interface CachedDay {
    staffId: string;
    date: string;
    bitmap: Buffer;
}

const hotDays = new Map<string, CachedDay>();

function cacheKey(staffId: ObjectId, date: string): string {
    return `${staffId.toHexString()}:${date}`;
}

/** Drop cached days that are not today or yesterday. Called by the hourly tick. */
export function pruneActivityCache(now = new Date()): void {
    const keep = new Set([
        utcDayKey(now),
        utcDayKey(new Date(now.getTime() - 86_400_000))
    ]);
    for (const [key, entry] of hotDays) {
        if (!keep.has(entry.date)) hotDays.delete(key);
    }
}

export function clearActivityCache(): void {
    hotDays.clear();
}

async function loadDay(staffId: ObjectId, date: string): Promise<CachedDay> {
    const key = cacheKey(staffId, date);
    const cached = hotDays.get(key);
    if (cached) return cached;

    const doc = await collections.activityDays().findOne({ staffId, date });
    const entry: CachedDay = {
        staffId: staffId.toHexString(),
        date,
        bitmap: normaliseBitmap(doc?.minutes?.buffer)
    };
    hotDays.set(key, entry);
    return entry;
}

/**
 * Credit the UTC minute containing `at`. Returns true when the minute was newly
 * credited, false when it was already set and nothing was written.
 */
export async function creditMinute(staffId: ObjectId, at: Date): Promise<boolean> {
    const date = utcDayKey(at);
    const minute = minuteOfUtcDay(at);
    const key = cacheKey(staffId, date);

    return withLock(key, async () => {
        const day = await loadDay(staffId, date);
        if (isMinuteSet(day.bitmap, minute)) return false;

        // Set the bit on a copy and commit it to the cache only once the write
        // has landed. Mutating the cached buffer first meant a failed write left
        // the minute set in memory and absent from the document: every later
        // call returned "already credited" and the minute was gone for good,
        // beyond the reach of the nightly recompute, which rebuilds `count`
        // from the stored bitmap and so never knew about it either.
        const next = Buffer.from(day.bitmap);
        setMinute(next, minute);

        await collections.activityDays().updateOne(
            { staffId, date },
            {
                $set: { minutes: new Binary(next) },
                $setOnInsert: { _id: new ObjectId(), staffId, date },
                $inc: { count: 1 }
            },
            { upsert: true }
        );

        day.bitmap = next;
        return true;
    });
}

export async function getDayBitmap(staffId: ObjectId, date: string): Promise<Buffer> {
    const cached = hotDays.get(cacheKey(staffId, date));
    if (cached) return cached.bitmap;
    const doc = await collections.activityDays().findOne({ staffId, date });
    return normaliseBitmap(doc?.minutes?.buffer);
}

async function fetchDays(
    staffId: ObjectId,
    dateKeys: string[]
): Promise<Map<string, Buffer>> {
    const map = new Map<string, Buffer>();
    if (dateKeys.length === 0) return map;

    const docs = await collections
        .activityDays()
        .find({ staffId, date: { $in: dateKeys } })
        .toArray();
    for (const doc of docs) {
        map.set(doc.date, normaliseBitmap(doc.minutes?.buffer));
    }
    // In-process writes may not have been read back yet.
    for (const key of dateKeys) {
        const cached = hotDays.get(cacheKey(staffId, key));
        if (cached) map.set(key, cached.bitmap);
    }
    return map;
}

/**
 * Activity minutes inside [from, to). Windows are half open and may span any
 * number of UTC days: each day contributes only the slice of itself that falls
 * inside the window, so a week boundary in a non-UTC accounting zone lands
 * mid-day without any special casing.
 */
export async function countMinutesBetween(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<number> {
    if (to <= from) return 0;
    const dateKeys = utcDayKeysBetween(from, to);
    const days = await fetchDays(staffId, dateKeys);

    let total = 0;
    for (const key of dateKeys) {
        const bitmap = days.get(key);
        if (!bitmap) continue;
        const dayStart = dayKeyToDate(key).getTime();
        const fromMinute = Math.max(0, Math.floor((from.getTime() - dayStart) / MINUTE_MS));
        const toMinute = Math.min(1440, Math.ceil((to.getTime() - dayStart) / MINUTE_MS));
        total += countRange(bitmap, fromMinute, toMinute);
    }
    return total;
}

/** Distinct UTC days with at least one credited minute inside the window. */
export async function countActiveDaysBetween(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<number> {
    if (to <= from) return 0;
    const dateKeys = utcDayKeysBetween(from, to);
    const days = await fetchDays(staffId, dateKeys);

    let active = 0;
    for (const key of dateKeys) {
        const bitmap = days.get(key);
        if (!bitmap) continue;
        const dayStart = dayKeyToDate(key).getTime();
        const fromMinute = Math.max(0, Math.floor((from.getTime() - dayStart) / MINUTE_MS));
        const toMinute = Math.min(1440, Math.ceil((to.getTime() - dayStart) / MINUTE_MS));
        if (countRange(bitmap, fromMinute, toMinute) > 0) active += 1;
    }
    return active;
}

/** Per day totals for a window. Feeds /mydata export and recap cards. */
export async function dailyTotalsBetween(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<{ date: string; minutes: number }[]> {
    const dateKeys = utcDayKeysBetween(from, to);
    const days = await fetchDays(staffId, dateKeys);
    return dateKeys.map((date) => ({
        date,
        minutes: days.has(date) ? popcount(days.get(date) as Buffer) : 0
    }));
}

/** Per UTC hour totals across a window, length 24. Feeds the coverage heatmap. */
export async function hourlyTotalsBetween(
    staffId: ObjectId,
    from: Date,
    to: Date
): Promise<number[]> {
    const dateKeys = utcDayKeysBetween(from, to);
    const days = await fetchDays(staffId, dateKeys);
    const hours = new Array<number>(24).fill(0);
    for (const bitmap of days.values()) {
        const histogram = hourHistogram(bitmap);
        for (let hour = 0; hour < 24; hour += 1) hours[hour] += histogram[hour];
    }
    return hours;
}

export async function exportDays(
    staffId: ObjectId
): Promise<{ date: string; minutes: number; setMinutes: number[] }[]> {
    const docs = await collections
        .activityDays()
        .find({ staffId })
        .sort({ date: 1 })
        .toArray();
    return docs.map((doc) => {
        const bitmap = normaliseBitmap(doc.minutes?.buffer);
        return { date: doc.date, minutes: popcount(bitmap), setMinutes: setMinutes(bitmap) };
    });
}

/**
 * Nightly recompute of the popcount cache. The spec treats `count` as advisory
 * precisely so that this job, not the hot path, is what makes it true.
 */
export async function recomputeCounts(): Promise<{ scanned: number; corrected: number }> {
    const cursor = collections.activityDays().find({});
    let scanned = 0;
    let corrected = 0;

    for await (const doc of cursor) {
        scanned += 1;
        const actual = popcount(normaliseBitmap(doc.minutes?.buffer));
        if (doc.count !== actual) {
            await collections
                .activityDays()
                .updateOne({ _id: doc._id }, { $set: { count: actual } });
            corrected += 1;
        }
    }
    return { scanned, corrected };
}

export { BITMAP_BYTES, emptyBitmap };
