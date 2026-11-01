import type { Tier } from "./permissions.js";

/**
 * The one heads up a member gets before a fortnight closes, as pure rules.
 *
 * Several members have closed a fortnight about thirty minutes short, which read
 * as an oversight. So this tells them while they can still do something about it,
 * and says nothing about reviews or consequences. It is compulsory: one DM a
 * fortnight, and only to somebody who is actually short.
 */

const DAY_MS = 86_400_000;
export const REMINDER_DAYS_BEFORE_CLOSE = 3;

/**
 * Their own 09:00, inside the last three days. The receipt makes it once, so this
 * is the first such hour for everybody, and a bot that was down catches up at the
 * next one with a day less to say.
 */
export function fortnightReminderDue(now: Date, closesAt: Date, localHour: number): boolean {
    const left = closesAt.getTime() - now.getTime();
    return left > 0 && left <= REMINDER_DAYS_BEFORE_CLOSE * DAY_MS && localHour === 9;
}

export type FortnightReminderRefusal =
    | "executive"
    | "notStaff"
    | "onLeave"
    | "met"
    | "exempt"
    | "mayBeExempt";

/** Why somebody gets none, or null. Anybody leave might yet excuse is left alone. */
export function fortnightReminderRefusal(input: {
    tier: Tier;
    onLeaveNow: boolean;
    status: "met" | "below" | "exempt";
    /** Pending leave would take them off the queue if approved. */
    heldForLeave: boolean;
    /** Pending leave would exempt a week that still counts. */
    pendingExemptsAWeek: boolean;
}): FortnightReminderRefusal | null {
    if (input.tier === "executive") return "executive";
    if (input.tier === "none") return "notStaff";
    if (input.onLeaveNow) return "onLeave";
    if (input.status === "exempt") return "exempt";
    if (input.status === "met") return "met";
    if (input.heldForLeave || input.pendingExemptsAWeek) return "mayBeExempt";
    return null;
}

/** The card's title, true whenever it goes out. */
export function daysLeftTitle(now: Date, closesAt: Date): string {
    const days = Math.max(1, Math.ceil((closesAt.getTime() - now.getTime()) / DAY_MS));
    const word = ["One", "Two", "Three"][days - 1] ?? String(days);
    return `${word} ${days === 1 ? "day" : "days"} left this fortnight`;
}
