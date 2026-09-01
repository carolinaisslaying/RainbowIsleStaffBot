import { collections } from "../db/client.js";
import type { FortnightReviewDoc } from "../db/types.js";

/**
 * Where a fortnight's queue lives, and whether it has been chased.
 *
 * Keyed by the fortnight index itself, so posting a queue twice upserts rather
 * than duplicating. The header needs somewhere to keep its message id: without
 * it a re-run posts a second header above the same rows, which is how the old
 * card came to look like a fresh queue every time somebody recomputed.
 */

export async function findReview(index: number): Promise<FortnightReviewDoc | null> {
    return collections.fortnightReviews().findOne({ _id: index });
}

export async function rememberHeader(
    index: number,
    channelId: string,
    messageId: string
): Promise<void> {
    await collections.fortnightReviews().updateOne(
        { _id: index },
        {
            $set: { headerChannelId: channelId, headerMessageId: messageId },
            $setOnInsert: { postedAt: new Date(), remindedAt: null }
        },
        { upsert: true }
    );
}

/** Record that the one reminder has gone out. Never reset. */
export async function markReminded(index: number, at = new Date()): Promise<void> {
    await collections.fortnightReviews().updateOne({ _id: index }, { $set: { remindedAt: at } });
}

/** Queues that have been posted and might still be owed their reminder. */
export async function unremindedReviews(): Promise<FortnightReviewDoc[]> {
    return collections.fortnightReviews().find({ remindedAt: null }).toArray();
}
