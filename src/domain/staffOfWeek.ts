import type { StaffOfWeekStatus } from "../db/types.js";
import type { Tier } from "./permissions.js";
import { addWallClockMinutes, nextWeekStart, weekStartFor } from "../time/calendar.js";

/**
 * Staff of the Week, as pure rules.
 *
 * Every surface — `/sotw set`, the random draw, the reminder's list, `/sotw
 * view` — asks `eligibilityFor`, so they cannot disagree about who may hold it.
 * Ids are hex strings here so nothing in this file needs a database.
 */

export function sotwEnabled(config: { staffOfWeekRole: string }): boolean {
    return config.staffOfWeekRole !== "";
}

export interface HolderRecord {
    holders: string[];
    removedHolders: string[];
}

/** Held the role in the week and was not taken off it. The only reader of the two lists. */
export function creditedHolders(record: HolderRecord | null): string[] {
    if (!record) return [];
    const removed = new Set(record.removedHolders);
    return record.holders.filter((id) => !removed.has(id));
}

/** The credited holders of the two week slots before the one being assigned. */
export function barredIds(previous: (HolderRecord | null)[]): Set<string> {
    return new Set(previous.flatMap((record) => creditedHolders(record)));
}

export interface Candidate {
    staffId: string;
    active: boolean;
    /** Resolved in the public guild; `none` covers somebody who has left it. */
    tier: Tier;
    /** Approved or active leave exempts the week. */
    exemptByLeave: boolean;
    /** Leave waiting on a decision would exempt the week if approved. */
    pendingLeave: boolean;
}

export type Refusal = "inactive" | "notStaff" | "executive" | "recentHolder" | "onLeave";

export type Eligibility = { eligible: true; pendingLeave: boolean } | { eligible: false; reason: Refusal };

export function eligibilityFor(candidate: Candidate, barred: Set<string>): Eligibility {
    if (!candidate.active) return { eligible: false, reason: "inactive" };
    if (candidate.tier === "none") return { eligible: false, reason: "notStaff" };
    if (candidate.tier === "executive") return { eligible: false, reason: "executive" };
    if (barred.has(candidate.staffId)) return { eligible: false, reason: "recentHolder" };
    if (candidate.exemptByLeave) return { eligible: false, reason: "onLeave" };
    return { eligible: true, pendingLeave: candidate.pendingLeave };
}

/**
 * The refusals that make a recorded pick impossible to honour at the handoff.
 * Late leave is not one of them: the Executives were already told who it
 * would be, and changing it is their call.
 */
const HARD: readonly Refusal[] = ["inactive", "notStaff", "executive"];

export function isHardRefusal(eligibility: Eligibility): boolean {
    return !eligibility.eligible && HARD.includes(eligibility.reason);
}

export function refusalText(reason: Refusal, name: string): string {
    switch (reason) {
        case "inactive":
            return `**${name}** has no active staff record.`;
        case "notStaff":
            return `**${name}** is not Moderation staff in the community server, or has left it.`;
        case "executive":
            return `**${name}** is an Executive, and Executives are never Staff of the Week.`;
        case "recentHolder":
            return (
                `**${name}** held Staff of the Week in one of the two weeks before, so they ` +
                "cannot hold it again yet."
            );
        case "onLeave":
            return `**${name}** has enough approved leave that week to be exempt from it.`;
    }
}

export const PENDING_LEAVE_NOTE = "has leave awaiting a decision for that week";

export interface Standing {
    staffId: string;
    minutes: number;
}

/**
 * Who the draw chooses between: the closed week's top three who met the
 * target and may hold it, plus everybody tied with the third, so a tie at the
 * cut never decides who is in. Pending leave skips the draw, so the bot never
 * hands the role to somebody who is probably away.
 */
export function drawPool(standings: Standing[], target: number, eligibility: Map<string, Eligibility>): Standing[] {
    const qualifying = standings
        .filter((row) => row.minutes >= target)
        .filter((row) => {
            const verdict = eligibility.get(row.staffId);
            return verdict?.eligible === true && !verdict.pendingLeave;
        })
        .sort((left, right) => right.minutes - left.minutes || left.staffId.localeCompare(right.staffId));
    if (qualifying.length <= 3) return qualifying;
    const cut = qualifying[2].minutes;
    return qualifying.filter((row) => row.minutes >= cut);
}

/** One uniformly at random. `rng` is injected so tests are deterministic. */
export function draw<T>(pool: readonly T[], rng: () => number): T | null {
    if (pool.length === 0) return null;
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

export type HandoffDecision =
    | { kind: "picked"; staffId: string }
    | { kind: "random"; staffId: string }
    | { kind: "skipped" }
    | { kind: "empty" };

export function decideHandoff(input: {
    week: { status: StaffOfWeekStatus; staffId: string | null } | null;
    pickEligibility: Eligibility | null;
    pool: Standing[];
    rng: () => number;
}): { decision: HandoffDecision; pickFailed: Refusal | null } {
    if (input.week?.status === "skipped") return { decision: { kind: "skipped" }, pickFailed: null };

    let pickFailed: Refusal | null = null;
    if (input.week?.status === "pending" && input.week.staffId) {
        const verdict = input.pickEligibility;
        if (verdict && isHardRefusal(verdict) && !verdict.eligible) {
            pickFailed = verdict.reason;
        } else {
            return { decision: { kind: "picked", staffId: input.week.staffId }, pickFailed: null };
        }
    }

    const chosen = draw(input.pool, input.rng);
    return {
        decision: chosen ? { kind: "random", staffId: chosen.staffId } : { kind: "empty" },
        pickFailed
    };
}

/**
 * How long after a week starts it counts as handed off even without a
 * receipt: a deployment that switched the feature on mid-week, or whose
 * handoff never ran, must not keep targeting a week that has already begun.
 */
export const HANDOFF_GRACE_MS = 3_600_000;

export function handoffSettled(input: { claimed: boolean; now: Date; weekStart: Date }): boolean {
    return input.claimed || input.now.getTime() - input.weekStart.getTime() >= HANDOFF_GRACE_MS;
}

export interface BootHandoffInput {
    coldStart: boolean;
    /** The week's `sotw-handoff` receipt exists. */
    claimed: boolean;
    /** The week's document carries `handedOffAt`. */
    handedOff: boolean;
    /** `HANDOFF_GRACE_MS` has passed since the week began. */
    pastGrace: boolean;
    week: { status: StaffOfWeekStatus; staffId: string | null } | null;
}

/**
 * What boot does about the current week. `claim` says whether the receipt is
 * still to be claimed: false means a handoff claimed it and stopped before
 * `markHandedOff`, so finishing must not claim again.
 */
export type BootHandoff =
    | { kind: "reassert" }
    | { kind: "run" }
    | { kind: "coldStart" }
    /** Honour the pending pick against hard refusals only. Never draws. */
    | { kind: "pick"; claim: boolean }
    /** Record the week as empty. Never draws. */
    | { kind: "empty"; claim: boolean }
    /** The week is already decided: mark it handed off, congratulate nobody. */
    | { kind: "mark"; claim: boolean };

/**
 * Nothing here ever draws once the week has begun. A pick waiting for a
 * handoff that did not run (the bot was down, or the close failed partway) is
 * honoured rather than stranded: left pending, nobody holds the role, `/sotw
 * view` names the pick, and the rest of the week cannot be given to anybody.
 */
export function bootHandoff(input: BootHandoffInput): BootHandoff {
    const { week } = input;
    const hasPick = week?.status === "pending" && week.staffId !== null;
    const undecided = !week || week.status === "pending";

    if (input.claimed) {
        if (input.handedOff) return { kind: "reassert" };
        if (hasPick) return { kind: "pick", claim: false };
        if (undecided) return { kind: "empty", claim: false };
        return { kind: "mark", claim: false };
    }
    if (input.coldStart) return { kind: "coldStart" };
    if (!input.pastGrace) return { kind: "run" };
    if (hasPick) return { kind: "pick", claim: true };
    if (undecided || week.status === "skipped") return { kind: "empty", claim: true };
    return { kind: "mark", claim: true };
}

/**
 * Which week `/sotw set` and `/sotw skip` are about. Before the calendar
 * week's handoff has run — the minutes between 00:00 and the 00:05 close — the
 * week about to be handed off is still "next", or a pick made at 00:02 would
 * land a week late and leave this one to the draw.
 */
export function targetWeeks(input: {
    previousStart: Date;
    currentStart: Date;
    nextStart: Date;
    currentHandedOff: boolean;
}): { current: Date; next: Date } {
    return input.currentHandedOff
        ? { current: input.currentStart, next: input.nextStart }
        : { current: input.previousStart, next: input.currentStart };
}

export function isHolding(status: StaffOfWeekStatus): boolean {
    return status === "picked" || status === "random";
}

/** Somebody could be given the rest of this week: it is handed off and nobody holds it. */
export function restOfWeekOffered(
    current: { status: StaffOfWeekStatus; staffId: string | null } | null,
    handedOff: boolean
): boolean {
    if (!handedOff) return false;
    return !current || current.staffId === null || !isHolding(current.status);
}

export function reminderTimeFor(weekStart: Date, rules: { timeZone: string; offsetMinutes: number }): Date {
    return addWallClockMinutes(weekStart, rules.offsetMinutes, rules.timeZone);
}

export function nextReminderAt(
    from: Date,
    rules: { timeZone: string; weekStartDay: number; offsetMinutes: number }
): Date {
    const current = weekStartFor(from, rules.timeZone, rules.weekStartDay);
    const thisWeek = reminderTimeFor(current, rules);
    if (thisWeek > from) return thisWeek;
    return reminderTimeFor(nextWeekStart(current, rules.timeZone, rules.weekStartDay), rules);
}

export type ColourStatus = "holding" | "saved" | "executive";

export function colourStatus(input: { holding: boolean; tier: Tier }): ColourStatus {
    if (input.holding) return "holding";
    return input.tier === "executive" ? "executive" : "saved";
}

export const COLOUR_COOLDOWN_MS = 30_000;

export function cooldownRemainingMs(lastAt: number | undefined, now: number): number {
    if (lastAt === undefined) return 0;
    return Math.max(0, lastAt + COLOUR_COOLDOWN_MS - now);
}

export function timesHeld(
    records: (HolderRecord & { weekStart: Date })[],
    staffId: string
): { count: number; last: Date | null } {
    const held = records
        .filter((record) => creditedHolders(record).includes(staffId))
        .map((record) => record.weekStart)
        .sort((left, right) => left.getTime() - right.getTime());
    return { count: held.length, last: held.at(-1) ?? null };
}

/**
 * The holder the team recap names: whoever holds the week that has just
 * begun, and only on the recap of the week that has just closed. A recap
 * posted during catch-up for an older week names nobody.
 */
export function recapHolder(input: {
    recapWeekEnd: Date;
    currentWeekStart: Date;
    nextWeek: { status: StaffOfWeekStatus; staffId: string | null } | null;
}): string | null {
    if (input.recapWeekEnd.getTime() !== input.currentWeekStart.getTime()) return null;
    if (!input.nextWeek || !isHolding(input.nextWeek.status)) return null;
    return input.nextWeek.staffId;
}

export type LateCause = "left" | "notStaff" | "executive";

/** Why the current holder can no longer hold it, or null when they still can. */
export function lateCauseFor(input: { present: boolean; tier: Tier }): LateCause | null {
    if (!input.present) return "left";
    if (input.tier === "none") return "notStaff";
    if (input.tier === "executive") return "executive";
    return null;
}
