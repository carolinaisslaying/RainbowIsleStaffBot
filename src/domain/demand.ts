import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { DemandBucketDoc } from "../db/types.js";
import { HOUR_MS } from "../time/calendar.js";

/**
 * Server load, for the heatmap. No identity is attached and none ever will be:
 * every message in a tracked channel increments a counter, staff or not, and
 * nothing here records who sent it or what it said.
 */

export function hourBucketFor(instant: Date): Date {
    return new Date(Math.floor(instant.getTime() / HOUR_MS) * HOUR_MS);
}

export async function recordDemand(channelId: string, at = new Date()): Promise<void> {
    const hourStart = hourBucketFor(at);
    await collections.demandBuckets().updateOne(
        { channelId, hourStart },
        {
            $inc: { messages: 1 },
            $setOnInsert: { _id: new ObjectId(), channelId, hourStart }
        },
        { upsert: true }
    );
}

export async function demandBetween(
    from: Date,
    to: Date,
    channelIds?: readonly string[]
): Promise<DemandBucketDoc[]> {
    return collections
        .demandBuckets()
        .find({
            hourStart: { $gte: from, $lt: to },
            ...(channelIds ? { channelId: { $in: [...channelIds] } } : {})
        })
        .toArray();
}

/** Total messages per UTC hour bucket across the given channels. */
export async function demandByHour(
    from: Date,
    to: Date,
    channelIds?: readonly string[]
): Promise<Map<number, number>> {
    const buckets = await demandBetween(from, to, channelIds);
    const totals = new Map<number, number>();
    for (const bucket of buckets) {
        const key = bucket.hourStart.getTime();
        totals.set(key, (totals.get(key) ?? 0) + bucket.messages);
    }
    return totals;
}

/**
 * The first hour any of these channels recorded a message, which is as close as
 * the store can get to when counting began. A quiet channel's first bucket can
 * land a little after it was added; for the busy channels that decide the
 * picture, it is the same hour.
 */
export async function firstDemandHour(channelIds: readonly string[]): Promise<Date | null> {
    if (channelIds.length === 0) return null;
    const first = await collections
        .demandBuckets()
        .find({ channelId: { $in: [...channelIds] } })
        .sort({ hourStart: 1 })
        .limit(1)
        .next();
    return first?.hourStart ?? null;
}
