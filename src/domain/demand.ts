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

export async function demandBetween(from: Date, to: Date): Promise<DemandBucketDoc[]> {
    return collections
        .demandBuckets()
        .find({ hourStart: { $gte: from, $lt: to } })
        .toArray();
}

/** Total messages per UTC hour bucket across all tracked channels. */
export async function demandByHour(from: Date, to: Date): Promise<Map<number, number>> {
    const buckets = await demandBetween(from, to);
    const totals = new Map<number, number>();
    for (const bucket of buckets) {
        const key = bucket.hourStart.getTime();
        totals.set(key, (totals.get(key) ?? 0) + bucket.messages);
    }
    return totals;
}
