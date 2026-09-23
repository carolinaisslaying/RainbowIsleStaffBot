import { collections } from "../db/client.js";
import { HOUR_MS } from "../time/calendar.js";

/**
 * When the bot was listening. Recorded once a minute while connected to the
 * gateway, so the heatmaps can tell an hour nobody spoke in from an hour the bot
 * never heard. See `domain/observation.ts` for how it is read.
 *
 * One document per UTC hour for the whole bot, not one per channel: whether the
 * bot was connected does not depend on the channel, and a channel added to
 * tracking later is covered from the moment it is added.
 */

export async function recordOnlineMinute(at: Date): Promise<void> {
    const hourStart = Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
    const minute = Math.floor((at.getTime() - hourStart) / 60_000);
    await collections
        .uptimeHours()
        .updateOne({ _id: new Date(hourStart) }, { $addToSet: { minutes: minute } }, { upsert: true });
}

/** Minutes online per UTC hour start, across a window. */
export async function uptimeByHour(from: Date, to: Date): Promise<Map<number, number>> {
    const rows = await collections
        .uptimeHours()
        .aggregate<{ _id: Date; online: number }>([
            { $match: { _id: { $gte: from, $lt: to } } },
            { $project: { online: { $size: "$minutes" } } }
        ])
        .toArray();
    return new Map(rows.map((row) => [row._id.getTime(), row.online]));
}

/** The hours in a window with the minutes in each, for counting exact minutes. */
export async function uptimeRows(
    from: Date,
    to: Date
): Promise<{ hourStart: number; minutes: number[] }[]> {
    const rows = await collections
        .uptimeHours()
        .find({ _id: { $gte: new Date(Math.floor(from.getTime() / HOUR_MS) * HOUR_MS), $lt: to } })
        .toArray();
    return rows.map((row) => ({ hourStart: row._id.getTime(), minutes: row.minutes }));
}

/**
 * The first minute uptime was ever recorded, or null if it never has been.
 * Everything before it is assumed heard.
 */
export async function uptimeMeasuredSince(): Promise<number | null> {
    const first = await collections.uptimeHours().find().sort({ _id: 1 }).limit(1).next();
    if (!first || first.minutes.length === 0) return null;
    return first._id.getTime() + Math.min(...first.minutes) * 60_000;
}
