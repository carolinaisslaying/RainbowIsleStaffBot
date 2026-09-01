import type { ObjectId } from "mongodb";
import type { ReviewOutcome } from "../db/types.js";

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
}

/** Which buttons a row draws, in order. Empty means the row is inert. */
export function rowButtons(facts: RowFacts): ReviewAction[] {
    if (facts.outcome) return ["reopen"];
    // A departed member can be excused or dismissed so the queue can be closed
    // out, but not warned: there is nobody left to serve it on.
    return facts.departed ? ["excuse", "dismiss"] : ["warn", "excuse", "dismiss"];
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
}): Permitted | Refusal {
    if (!options.isExecutive) {
        return {
            ok: false,
            reason:
                "Review decisions are Executive only. Leads can read the queue and the " +
                "warning history, and that is the whole of it."
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

    if (options.departed && options.action === "warn") {
        return {
            ok: false,
            reason:
                "They are no longer in the server, so there is nobody to serve a warning on. " +
                "Excuse or dismiss the row to close it out."
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
 * A warning past its expiry is spent: still on the record, still readable, and
 * no longer counted. Nobody should carry one bad fortnight for ever, and a
 * total that only ever grows stops meaning anything.
 */
export function warningIsSpent(issuedAt: Date, now: Date, expiryDays: number): boolean {
    return now.getTime() - issuedAt.getTime() > expiryDays * 86_400_000;
}

/** Warnings that still count: not spent, and not written by a rehearsal. */
export function activeWarningCount(
    warnings: { issuedAt: Date; rehearsal?: boolean }[],
    now: Date,
    expiryDays: number
): number {
    return warnings.filter(
        (warning) => !warning.rehearsal && !warningIsSpent(warning.issuedAt, now, expiryDays)
    ).length;
}

/**
 * The line a row shows before anyone clicks: what this warning would be, if
 * issued. The bot counts and surfaces; it never escalates by itself, the same
 * way it never issues a warning by itself.
 */
export function warningWeightLine(activeWarnings: number): string {
    if (activeWarnings === 0) return "No warnings currently count against them.";
    const next = activeWarnings + 1;
    return (
        `${activeWarnings} warning${activeWarnings === 1 ? "" : "s"} currently count` +
        `${activeWarnings === 1 ? "s" : ""} against them. This would be their ${ordinal(next)}.`
    );
}

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
    remaining: number;
}

export function queueCounts(rows: { outcome: ReviewOutcome | null }[]): QueueCounts {
    const decided = rows.filter((row) => row.outcome !== null).length;
    return { below: rows.length, decided, remaining: rows.length - decided };
}

/** The header's own sentence, which has to read correctly at every count. */
export function queueHeadline(counts: QueueCounts, requiredMinutes: number): string {
    if (counts.below === 0) {
        return `Every active member met the ${requiredMinutes} minute requirement. Nothing to review.`;
    }
    if (counts.remaining === 0) {
        return (
            `${counts.below} ${counts.below === 1 ? "member was" : "members were"} below the ` +
            `${requiredMinutes} minute requirement. All reviewed.`
        );
    }
    return (
        `${counts.below} ${counts.below === 1 ? "member is" : "members are"} below the ` +
        `${requiredMinutes} minute requirement. ` +
        `${counts.remaining} still to decide` +
        (counts.decided > 0 ? `, ${counts.decided} done.` : ".")
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
