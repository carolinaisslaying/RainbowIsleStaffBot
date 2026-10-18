import type { Tier } from "./permissions.js";

/**
 * A nudge for a member who is active but forgot to start a shift.
 *
 * The bot credits minutes only on shift, so a Moderator who spends an evening
 * in the tracked channels without running `/shift start` earns nothing and
 * finds out at the end of the week. The bot sees it happen, so it says so.
 *
 * The Executives asked for a high bar: twenty messages in half an hour by
 * default, in tracked channels only. Members learn to ignore a reminder that
 * fires on a couple of off-duty answers, and then miss the one that mattered.
 *
 * Executives get no reminder, for the reason the review skips them: their rank
 * outranks the requirement. Neither does a member on leave, on shift, or opted
 * out in `/settings`. Leads do, because they work shifts like everybody else.
 */

/** The message times still inside the window, oldest first. */
export function withinWindow(times: number[], now: number, windowMs: number): number[] {
    return times.filter((at) => now - at < windowMs);
}

/** Whether there is enough activity in the window to say anything. */
export function activityReached(count: number, threshold: number): boolean {
    // Zero turns the feature off. Without this check it would fire on every message.
    return threshold > 0 && count >= threshold;
}

export type ReminderRefusal = "executive" | "notStaff" | "onLeave" | "optedOut" | "onShift";

/**
 * Why this member gets no reminder, or null when they should get one. The
 * caller looks up each fact, so the rule lives here, pure and tested.
 */
export function reminderRefusal(input: {
    /** Tier from public-guild roles alone. A seeded admin is not promoted here. */
    tier: Tier;
    onLeave: boolean;
    optedOut: boolean;
    onShift: boolean;
}): ReminderRefusal | null {
    if (input.tier === "executive") return "executive";
    if (input.tier === "none") return "notStaff";
    if (input.onShift) return "onShift";
    if (input.onLeave) return "onLeave";
    if (input.optedOut) return "optedOut";
    return null;
}

/** Whether the cooldown since the last reminder has run out. Never reminded is due. */
export function cooldownElapsed(
    lastRemindedAt: Date | null | undefined,
    now: Date,
    cooldownMs: number
): boolean {
    if (!lastRemindedAt) return true;
    return now.getTime() - lastRemindedAt.getTime() >= cooldownMs;
}
