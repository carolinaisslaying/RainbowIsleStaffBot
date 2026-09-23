import type { ObjectId } from "mongodb";
import type { ConductTier, ReviewOutcome } from "../db/types.js";

/**
 * The fortnight review, as rules rather than as a card.
 *
 * Everything here is pure so the cases that matter can be enumerated without a
 * database or a Discord fixture: who may decide what, what a row looks like in
 * each of its states, when a warning stops counting, and whether the queue is
 * owed a reminder. The service does the talking; this decides what is true.
 */

export type ReviewAction = "warn" | "excuse" | "dismiss" | "reopen";

export const OUTCOME_FOR: Record<Exclude<ReviewAction, "reopen">, ReviewOutcome> = {
    warn: "warned",
    excuse: "excused",
    dismiss: "dismissed"
};

/** How a decided row reads, in the past tense, as the card and the DM say it. */
export const OUTCOME_LABEL: Record<ReviewOutcome, string> = {
    warned: "Warned",
    excused: "Excused",
    dismissed: "Dismissed"
};

export interface RowFacts {
    outcome: ReviewOutcome | null;
    /** No longer in the server, or the staff record is inactive. */
    departed: boolean;
    /** Written by a rehearsal, and never counted against anyone. */
    rehearsal: boolean;
    /**
     * Still below the requirement. Absent reads as below, which is what every
     * row in the queue was until leave could move one off it.
     */
    below?: boolean;
    /** Leave waiting on an Executive would take them off the queue if approved. */
    held?: boolean;
}

/** Which buttons a row draws, in order. Empty means the row is inert. */
export function rowButtons(facts: RowFacts): ReviewAction[] {
    if (facts.outcome) return ["reopen"];
    // Leave approved since has taken the row off the queue, so there is
    // nothing left to decide on it.
    if (facts.below === false) return [];
    // A departed member can be excused or dismissed so the queue can be closed
    // out, but not warned: there is nobody left to serve it on. A held row is
    // the same until its leave is decided: warning somebody for a fortnight
    // their pending leave may yet excuse is a decision made on half the facts.
    return facts.departed || facts.held
        ? ["excuse", "dismiss"]
        : ["warn", "excuse", "dismiss"];
}

export type Refusal = { ok: false; reason: string };
export type Permitted = { ok: true };

/**
 * Whether this person may take this action on this row.
 *
 * Executives are measured like everyone else and so appear in the queue, but
 * their rank outranks the requirement in practice, so the assessment carries no
 * weight for them. They may therefore close out their own row by excusing or
 * dismissing it. They may not warn themselves: a self-issued warning is either
 * theatre or a way to pre-empt somebody else's, and neither belongs on a
 * disciplinary record.
 */
export function decisionPermitted(options: {
    action: ReviewAction;
    isExecutive: boolean;
    actorStaffId: ObjectId;
    subjectStaffId: ObjectId;
    departed: boolean;
    /** Absent reads as below. */
    below?: boolean;
    held?: boolean;
}): Permitted | Refusal {
    if (!options.isExecutive) {
        return {
            ok: false,
            reason:
                "Review decisions are Executive only. Leads can view the queue and " +
                "warning history."
        };
    }

    if (options.below === false && options.action !== "reopen") {
        return {
            ok: false,
            reason:
                "Leave approved since this row was posted takes them off the queue, so there " +
                "is nothing to decide."
        };
    }

    const ownRow = options.actorStaffId.equals(options.subjectStaffId);

    if (ownRow && options.action === "warn") {
        return {
            ok: false,
            reason:
                "You cannot warn yourself. Another Executive has to take this one. You can " +
                "still excuse or dismiss your own row to clear it from the queue."
        };
    }

    if (options.held && options.action === "warn") {
        return {
            ok: false,
            reason:
                "They have a leave request waiting on an Executive that would take them off " +
                "the queue if approved. Decide the leave first. You can still excuse or " +
                "dismiss the row now."
        };
    }

    if (options.departed && options.action === "warn") {
        return {
            ok: false,
            reason:
                "They have left the team, so they cannot be warned. Excuse or dismiss the " +
                "row to close it."
        };
    }

    return { ok: true };
}

/**
 * Whether withdrawing a decision is worth telling the member about.
 *
 * Only if they were told about the decision in the first place. A dismissal is
 * never raised with them — it decides that nothing happened — so announcing
 * that one has been reopened would raise the very issue the silence existed to
 * avoid, and would be the first they ever heard of it. A warning or an excusal
 * they were told about, so leaving them believing the old outcome still stands
 * is the worse failure.
 */
export function reopenNotifies(previousOutcome: ReviewOutcome | null): boolean {
    return previousOutcome === "warned" || previousOutcome === "excused";
}

/**
 * What the Executive's own confirmation says about whether the member heard.
 *
 * Four different things can be true and they used to collapse into two. The
 * card said "They have been messaged" whenever the bot was *permitted* to send
 * one, which is not the same as sending it: a member with closed DMs generated
 * exactly the same sentence as one who read it. An Executive deciding whether
 * somebody has ignored a warning or never received it is the last person who
 * should be guessing.
 *
 * `attempted` is permission, `messaged` is arrival, and they are reported apart.
 */
export function deliveryLine(options: {
    action: ReviewAction;
    attempted: boolean;
    messaged: boolean;
    rehearsal: boolean;
}): string {
    if (options.action === "dismiss") {
        return "They were not told; a dismissal is not raised with them.";
    }
    if (options.messaged) return "They have been messaged.";
    if (options.attempted) {
        return (
            "❗ **They could not be messaged.** Their direct messages are closed, so they " +
            "have not seen this. It is still on the record."
        );
    }
    if (options.rehearsal) {
        return "Rehearsal: they were not messaged, because they are not an Executive.";
    }
    return "They could not be messaged.";
}

/**
 * What the row says about whether the warning reached the member.
 *
 * Three states, and they used to be two. "Not yet acknowledged" was drawn for
 * a member who had read it and not pressed the button *and* for a member whose
 * DMs are closed, who never saw it at all. An Executive deciding whether
 * somebody has ignored a warning needs those apart.
 *
 * A warning issued before delivery was recorded has neither timestamp. That
 * reads as unknown, not as delivered: the bot did not observe it either way,
 * and claiming a delivery it never saw is the mistake this whole change is
 * about.
 */
export function deliveryState(warning: {
    deliveredAt?: Date | null;
    deliveryFailedAt?: Date | null;
    acknowledgedAt: Date | null;
}): "acknowledged" | "delivered" | "failed" | "unknown" {
    if (warning.acknowledgedAt) return "acknowledged";
    if (warning.deliveryFailedAt) return "failed";
    if (warning.deliveredAt) return "delivered";
    return "unknown";
}

/**
 * A warning past its expiry is spent: still on the record, still readable, and
 * no longer counted. Nobody should carry one bad fortnight for ever, and a
 * total that only ever grows stops meaning anything.
 */
export interface WarningLike {
    issuedAt: Date;
    kind?: "activity" | "conduct";
    tier?: ConductTier | null;
    rehearsal?: boolean;
    withdrawnAt?: Date | null;
}

/**
 * How long this particular warning counts for, in days. Zero means never spent.
 *
 * An activity warning uses `warningExpiryDays`. A conduct warning has no
 * lifetime at all, whatever its rung — a tier is a severity judgement, not a
 * countdown, so every conduct warning reads as permanent regardless of
 * `tier`, including one with no tier at all (which nothing writes, but a
 * hand-edited document could).
 */
export function lifetimeDaysFor(warning: WarningLike, config: WarningExpiryConfig): number {
    if (warning.kind !== "conduct") return config.warningExpiryDays;
    return 0;
}

/** The keys these rules read. Narrowed so the tests need no whole config. */
export interface WarningExpiryConfig {
    warningExpiryDays: number;
}

/**
 * A warning past its expiry is spent: still on the record, still readable, and
 * no longer counted. Nobody should carry one bad activity fortnight for ever,
 * and a total that only ever grows stops meaning anything.
 *
 * That only applies to activity warnings. A conduct warning's lifetime is
 * always zero, which **means never spent** — some conduct should not quietly
 * stop counting because enough months went by.
 */
export function warningIsSpent(
    warning: WarningLike,
    now: Date,
    config: WarningExpiryConfig
): boolean {
    const days = lifetimeDaysFor(warning, config);
    if (days <= 0) return false;
    return now.getTime() - warning.issuedAt.getTime() > days * 86_400_000;
}

/** Warnings that still count: not spent, and not written by a rehearsal. */
export function activeWarningCount(
    warnings: WarningLike[],
    now: Date,
    config: WarningExpiryConfig
): number {
    return warnings.filter((warning) => countsNow(warning, now, config)).length;
}

/**
 * Whether one warning counts against somebody right now.
 *
 * Three ways it does not: it was written by a rehearsal and was never real, it
 * has been withdrawn, or it is spent. Withdrawal beats every clock — a warning
 * taken back counts nowhere whatever its lifetime says.
 */
export function countsNow(
    warning: WarningLike,
    now: Date,
    config: WarningExpiryConfig
): boolean {
    if (warning.rehearsal) return false;
    if (warning.withdrawnAt) return false;
    return !warningIsSpent(warning, now, config);
}

/**
 * The same count, split by kind.
 *
 * One total is what a member is told they have, because a warning is a warning.
 * The breakdown exists because activity and conduct are not the same thing, and
 * a card that showed only the total would be saying they were.
 */
export function warningTally(
    warnings: WarningLike[],
    now: Date,
    config: WarningExpiryConfig
): {
    total: number;
    conduct: number;
    activity: number;
    /** Counting conduct warnings, per rung. Absent rungs are zero. */
    tiers: Record<ConductTier, number>;
} {
    const counting = warnings.filter((warning) => countsNow(warning, now, config));
    const conduct = counting.filter((warning) => warning.kind === "conduct");

    const tiers: Record<ConductTier, number> = {
        caution: 0,
        misconduct: 0
    };
    for (const warning of conduct) {
        // A conduct warning with no rung reads as the lower one rather than
        // dropped or guessed at the worse rung: a data error should not read
        // harsher than any decision anybody took.
        tiers[warning.tier ?? "caution"] += 1;
    }

    return {
        total: counting.length,
        conduct: conduct.length,
        activity: counting.length - conduct.length,
        tiers
    };
}

/**
 * The line a row shows before anyone clicks: what this warning would be, if
 * issued. The bot counts and surfaces; it never escalates by itself, the same
 * way it never issues a warning by itself.
 */
export function warningWeightLine(tally: {
    total: number;
    conduct: number;
    activity: number;
    tiers?: Record<ConductTier, number>;
}): string {
    if (tally.total === 0) return "No warnings currently count against them.";

    // One total, because a warning is a warning and that is what the member is
    // told they have. The breakdown names the rungs rather than saying "2
    // conduct", because an Executive deciding an attendance shortfall should
    // see whether that conduct history is two Cautions or a Serious Misconduct
    // — those are different facts and the card should not flatten them.
    const parts: string[] = [];
    if (tally.tiers) {
        for (const tier of ["misconduct", "caution"] as const) {
            const count = tally.tiers[tier];
            if (count > 0) parts.push(`${count} ${TIER_NAME[tier]}`);
        }
    } else if (tally.conduct > 0) {
        parts.push(`${tally.conduct} conduct`);
    }
    if (tally.activity > 0) parts.push(`${tally.activity} activity`);

    return (
        `${tally.total} warning${tally.total === 1 ? "" : "s"} currently count` +
        `${tally.total === 1 ? "s" : ""} against them (${parts.join(", ")}). ` +
        `This would be their ${ordinal(tally.total + 1)}.`
    );
}

/**
 * Rung names for the one line in the domain layer that has to say them.
 *
 * Duplicated from `render/tiers.ts` on purpose: `domain/` holds no rendering
 * and imports nothing from `render/`, and one line of prose is a smaller cost
 * than pointing the dependency arrow backwards. The test asserts they match.
 */
const TIER_NAME: Record<ConductTier, string> = {
    caution: "Caution",
    misconduct: "Misconduct"
};

function ordinal(value: number): string {
    const tens = value % 100;
    if (tens >= 11 && tens <= 13) return `${value}th`;
    switch (value % 10) {
        case 1:
            return `${value}st`;
        case 2:
            return `${value}nd`;
        case 3:
            return `${value}rd`;
        default:
            return `${value}th`;
    }
}

export interface QueueCounts {
    below: number;
    decided: number;
    /** Undecided rows an Executive can decide now, the bulk buttons' count. */
    remaining: number;
    /** Undecided rows waiting on a leave decision first. */
    held: number;
}

export function queueCounts(
    rows: { outcome: ReviewOutcome | null; held?: boolean }[]
): QueueCounts {
    const decided = rows.filter((row) => row.outcome !== null).length;
    const held = rows.filter((row) => row.outcome === null && row.held === true).length;
    return {
        below: rows.length,
        decided,
        remaining: rows.length - decided - held,
        held
    };
}

/**
 * The header's own sentence, which has to read correctly at every count. It
 * names no minute figure, because leave gives members different requirements
 * in the same fortnight and each row states its own.
 */
export function queueHeadline(counts: QueueCounts): string {
    if (counts.below === 0) {
        return "Every active member met their fortnight requirement. Nothing to review.";
    }
    const heldNote =
        counts.held > 0
            ? ` ${counts.held} ${counts.held === 1 ? "waits" : "wait"} on a leave decision first.`
            : "";
    if (counts.remaining === 0 && counts.held === 0) {
        return (
            `${counts.below} ${counts.below === 1 ? "member was" : "members were"} under ` +
            "their fortnight requirement. All reviewed."
        );
    }
    return (
        `${counts.below} ${counts.below === 1 ? "member is" : "members are"} under their ` +
        `fortnight requirement. ${counts.remaining} still to decide` +
        (counts.decided > 0 ? `, ${counts.decided} done.` : ".") +
        heldNote
    );
}

/**
 * Whether the queue is owed its one reminder.
 *
 * Once, never repeated: `remindedAt` is set when it fires and is never reset, so
 * a queue that is worked slowly is chased a single time rather than nagged
 * every day until somebody clicks something to make it stop.
 */
export function reminderDue(options: {
    postedAt: Date;
    remindedAt: Date | null;
    remaining: number;
    now: Date;
    afterDays: number;
}): boolean {
    if (options.remindedAt !== null) return false;
    if (options.remaining === 0) return false;
    return (
        options.now.getTime() - options.postedAt.getTime() >= options.afterDays * 86_400_000
    );
}

export interface PriorOutcome {
    windowStart: Date;
    totalMinutes: number;
    requiredMinutes: number;
    outcome: ReviewOutcome | null;
    status: string;
}

/**
 * The "previous outcomes" line, in English.
 *
 * It used to read `F-3 0m below, F-4 0m below, F-5 0m warned`, which asks the
 * reader to know what a fortnight index is, that a negative one is possible,
 * and that "below" is a status while "warned" is a decision about a status. It
 * is the line an Executive reads immediately before deciding somebody's record,
 * so it says the date, the shortfall and what was decided, in words.
 */
export function priorOutcomesLine(
    entries: PriorOutcome[],
    formatMonthDay: (date: Date) => string
): string {
    if (entries.length === 0) return "No earlier fortnight has been reviewed.";

    return entries
        .map((entry) => {
            const when = formatMonthDay(entry.windowStart);
            if (entry.outcome) return `${when}: ${OUTCOME_LABEL[entry.outcome].toLowerCase()}`;
            if (entry.status === "exempt") return `${when}: on leave`;
            if (entry.status === "met") return `${when}: met`;
            return `${when}: ${entry.totalMinutes} of ${entry.requiredMinutes} min, undecided`;
        })
        .join(" · ");
}
