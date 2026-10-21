/**
 * Nobody is on shift while Discord shows them as offline.
 *
 * Discord reports an invisible member to everybody else, the bot included, as
 * offline. The rule wants that: the community sees an invisible moderator the
 * same way it sees one who has left, so nobody can watch them work.
 *
 * Three paths used to let a member earn minutes offline. A message sent while
 * invisible resumed a paused shift and credited the minute. `/shift start`
 * never checked status. And a presence event lost in a reconnect left an
 * offline member available until the inactivity sweep heard silence, which a
 * member who keeps posting never gives it.
 *
 * `null` means the bot does not know: the public guild is unavailable to this
 * process, or Discord has not told it this member's status since it connected.
 * The second is the common one. Discord does not send a guild this size every
 * online member's presence on connect, only changes from then on, so a member
 * who has sat on one status since before a restart is simply absent from the
 * cache. Reading that absence as offline once ended the shift of everybody who
 * posted in the minutes after a restart, and paused the rest, all for being
 * invisible when none of them were. An unknown status is never a reason to act
 * against anybody; `confirmPresence` (discord/presence.ts) asks Discord before
 * anything that would. Starting and pausing still handle `null` in opposite
 * ways. A start refuses it, so the check never waves anybody through. The pause
 * ignores it, so a restart or a guild outage leaves every shift alone.
 */

/** The statuses Discord reports for another user. "invisible" only for self. */
export type SeenStatus = "online" | "idle" | "dnd" | "offline" | "invisible";

/**
 * A member's status from what the gateway has told this process. A cached
 * presence is the answer, `offline` included: Discord sent it. With none cached
 * the member is offline only if the bot asked Discord directly and was told so;
 * otherwise nobody knows yet.
 */
export function readStatus(
    cached: SeenStatus | undefined,
    confirmedOffline: boolean
): SeenStatus | null {
    if (cached !== undefined) return cached;
    return confirmedOffline ? "offline" : null;
}

export function isOffline(status: SeenStatus | null): boolean {
    return status === "offline" || status === "invisible";
}

/** Whether `/shift start` may proceed. It refuses an unknown status too. */
export function mayStartShift(status: SeenStatus | null): boolean {
    return status !== null && !isOffline(status);
}

/**
 * What a message from somebody with an open shift does, given their status.
 *
 *   resume   paused and visible: come back, then credit the minute
 *   credit   available and visible: credit the minute
 *   end      offline, paused or not: end the shift and credit nothing
 *
 * A member who has closed Discord cannot post, so an offline sender is
 * invisible. A pause let them keep posting into a shift that later ended
 * without a word, so the bot ends it now and the summary tells them why.
 * `INVISIBLE_RECHECK_MS` in services/shiftService.ts guards the one race.
 */
export type MessageEffect = "resume" | "credit" | "end";

export function messageEffect(status: SeenStatus | null, paused: boolean): MessageEffect {
    if (isOffline(status)) return "end";
    return paused ? "resume" : "credit";
}

/** The sweep's backstop: an available shift held by somebody seen offline. */
export function sweepShouldPause(status: SeenStatus | null, paused: boolean): boolean {
    return !paused && isOffline(status);
}
