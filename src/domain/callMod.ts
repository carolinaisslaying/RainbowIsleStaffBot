/**
 * `/callmod` cooldowns, in memory. A restart forgets them, which is the right
 * direction to be wrong in: the worst case is one extra call to moderators.
 *
 * Two clocks. The server clock stops a channel being pinged twice in a few
 * minutes by different people reporting the same incident; the member clock
 * stops one person pinging on repeat. The member's own clock is checked first,
 * because it is the longer one: telling somebody who called ten minutes ago to
 * wait five would only send them back to be refused again.
 *
 * A cooldown of 0 minutes is off.
 */

export type CallModRefusal = "user" | "server";

export interface CallModCooldowns {
    userMinutes: number;
    serverMinutes: number;
}

const MINUTE_MS = 60_000;

export class CallModLimiter {
    private lastServerCall: number | null = null;
    private readonly lastUserCall = new Map<string, number>();

    /**
     * Refuse, or claim both clocks and allow. Checking and claiming happen in
     * one synchronous step, so two calls arriving together cannot both pass.
     */
    claim(userId: string, now: number, cooldowns: CallModCooldowns): CallModRefusal | null {
        const userLast = this.lastUserCall.get(userId);
        if (userLast !== undefined && now - userLast < cooldowns.userMinutes * MINUTE_MS) {
            return "user";
        }
        if (
            this.lastServerCall !== null &&
            now - this.lastServerCall < cooldowns.serverMinutes * MINUTE_MS
        ) {
            return "server";
        }
        this.prune(now, cooldowns);
        this.lastServerCall = now;
        this.lastUserCall.set(userId, now);
        return null;
    }

    /**
     * Give a claim back when the call never reached the channel, so a failed
     * send does not lock the member and the server out for nothing.
     */
    release(userId: string, claimedAt: number): void {
        if (this.lastServerCall === claimedAt) this.lastServerCall = null;
        if (this.lastUserCall.get(userId) === claimedAt) this.lastUserCall.delete(userId);
    }

    /** Forget members whose cooldown has run out, so the map cannot grow for ever. */
    private prune(now: number, cooldowns: CallModCooldowns): void {
        for (const [id, at] of this.lastUserCall) {
            if (now - at >= cooldowns.userMinutes * MINUTE_MS) this.lastUserCall.delete(id);
        }
    }
}

function minutes(count: number): string {
    return count === 1 ? "minute" : `${count} minutes`;
}

/** The ephemeral refusal, in the wording agreed for it. */
export function callModRefusalText(refusal: CallModRefusal, cooldowns: CallModCooldowns): string {
    return refusal === "user"
        ? `You can only run this command every ${minutes(cooldowns.userMinutes)}.`
        : `This command can only be ran on the server every ${minutes(cooldowns.serverMinutes)}.`;
}
