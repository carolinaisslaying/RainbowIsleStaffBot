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
 * `null` means the bot cannot read any status, because the public guild is
 * unavailable to this process. Starting and pausing handle it in opposite
 * ways. A start refuses it, so the check never waves anybody through. The
 * pause ignores it, so a guild outage of a minute leaves every shift alone.
 */

/** The statuses Discord reports for another user. "invisible" only for self. */
export type SeenStatus = "online" | "idle" | "dnd" | "offline" | "invisible";

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
