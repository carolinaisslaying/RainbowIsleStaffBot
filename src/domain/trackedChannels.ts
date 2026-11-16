/**
 * `trackedChannels` holds channel ids and category ids side by side. A message
 * counts when its channel is on the list, or when the category that channel
 * sits in is. A thread is judged as its parent channel, so a thread in a
 * tracked category counts too.
 *
 * Demand is still stored per channel, never per category, so moving a channel
 * between categories moves it in or out of tracking without rewriting what it
 * already recorded.
 */

export interface ChannelPlace {
    /** The channel itself, or a thread's parent. */
    channelId: string;
    /** The category that channel sits in, if any. */
    categoryId: string | null;
}

export function isTracked(tracked: readonly string[], place: ChannelPlace): boolean {
    if (tracked.includes(place.channelId)) return true;
    return place.categoryId !== null && tracked.includes(place.categoryId);
}

/**
 * Every concrete channel the list covers, for reading demand back: a category
 * on the list stands for each channel currently inside it. An id that is not a
 * category stays as it is, including one whose channel has since been deleted,
 * so its history still reads.
 */
export function trackedChannelIds(
    tracked: readonly string[],
    channels: readonly { id: string; parentId: string | null }[]
): string[] {
    const ids = new Set<string>(tracked);
    for (const channel of channels) {
        if (channel.parentId !== null && tracked.includes(channel.parentId)) ids.add(channel.id);
    }
    return [...ids];
}
