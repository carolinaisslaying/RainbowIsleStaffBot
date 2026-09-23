import type { Binary, ObjectId } from "mongodb";

/**
 * Every collection keys on staffId (ObjectId), never on Discord ID.
 * That is what makes account migration a one-field update.
 */

export interface StaffDoc {
    _id: ObjectId;
    discordId: string;
    previousDiscordIds: string[];
    timezone: string | null;
    timezoneSetAt: Date | null;
    joinedTeamAt: Date;
    active: boolean;
    leaderboardOptOut: boolean;
    /**
     * Chosen ring face, by id. Null until they pick one, which the onboarding
     * gate makes them do; unknown ids fall back rather than failing, so
     * retiring a face cannot break a member's cards.
     */
    ringFace?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/** One document per staff member per UTC day. The raw store. */
export interface ActivityDayDoc {
    _id: ObjectId;
    staffId: ObjectId;
    /** "2026-09-28", UTC day. */
    date: string;
    /** 180 byte buffer, 1440 bits, bit N = minute N of the UTC day. */
    minutes: Binary;
    /** Popcount cache. Advisory: authoritative value is popcount(minutes). */
    count: number;
}

export type ShiftEndReason =
    | "manual"
    | "max_duration"
    | "auto_ended_away"
    | "leave_started"
    | "reconciled";

export type PauseCause = "presence" | "inactivity";

export interface ShiftPause {
    from: Date;
    to: Date | null;
    cause: PauseCause;
}

export interface ShiftDoc {
    _id: ObjectId;
    staffId: ObjectId;
    startedAt: Date;
    endedAt: Date | null;
    endReason: ShiftEndReason | null;
    pauses: ShiftPause[];
    /** Computed on close: total elapsed minus paused. */
    availableMs: number;
    /** Computed on close: activity minutes credited during this shift. */
    activityMinutes: number;
}

export type RingState = "green" | "amber" | "red" | "leave";

/** Materialised rollup. Never the source of truth. */
export interface WeeklyStatsDoc {
    _id: ObjectId;
    staffId: ObjectId;
    weekStart: Date;
    activityMinutes: number;
    shiftMs: number;
    activeDays: number;
    /** Enough leave to exempt the week (`minimumLeaveDays`). Only this greys the rings. */
    onLeave: boolean;
    /** Leave in the week, in whole days (hours / 24, rounded). */
    leaveDays: number;
    ringState: RingState;
}

export type AssessmentStatus = "met" | "below" | "exempt";
export type ReviewOutcome = "warned" | "excused" | "dismissed";

export interface FortnightAssessmentDoc {
    _id: ObjectId;
    staffId: ObjectId;
    fortnightIndex: number;
    windowStart: Date;
    windowEnd: Date;
    week1Minutes: number;
    week2Minutes: number;
    totalMinutes: number;
    /**
     * The policy this fortnight is measured against, snapshotted on first
     * assessment and never re-read from live config, so changing a target does
     * not rewrite past outcomes. Leave can still move the requirement, because
     * leave approved or ended later reassesses the fortnight against these.
     */
    weeklyTargetMinutes: number;
    minimumLeaveDays: number;
    /** Leave in each week, in whole days, and whether it exempted that week. */
    week1LeaveDays: number;
    week2LeaveDays: number;
    week1Exempt: boolean;
    week2Exempt: boolean;
    /** One weekly target per week that still counts: two, one or none. */
    requiredMinutes: number;
    status: AssessmentStatus;
    /**
     * Below, but a leave request still waiting on an Executive would change
     * that if approved. The row offers no Warn until the leave is decided.
     */
    heldForLeave: boolean;
    /** When a leave change last reassessed this fortnight after it closed. */
    leaveChangedAt: Date | null;
    reviewedBy: ObjectId | null;
    reviewOutcome: ReviewOutcome | null;
    reviewedAt: Date | null;
    /** Why the Executive decided what they decided. Their words, not generated. */
    reviewNote: string | null;
    /**
     * Where this member's row card lives, so every later state edits that one
     * message instead of posting a second one about the same fortnight. Same
     * role as logChannelId/logMessageId on LeaveDoc.
     */
    reviewChannelId?: string | null;
    reviewMessageId?: string | null;
    /**
     * Written by a rehearsal. Filtered out of every read that feeds a real
     * decision. A rehearsal exercises the real write path because one that
     * skips the writes tests nothing, which only works if nothing real ever
     * reads what it wrote.
     */
    rehearsal?: boolean;
}

/**
 * The header above a fortnight's row cards, and the fortnight's own review
 * state. Keyed by the fortnight index rather than by an ObjectId so posting a
 * queue twice is an upsert and never a duplicate.
 */
export interface FortnightReviewDoc {
    _id: number;
    headerChannelId: string;
    headerMessageId: string;
    postedAt: Date;
    /** When the one reminder was sent. Null until it is, and never reset. */
    remindedAt: Date | null;
}

/**
 * The two rungs a conduct warning can be issued at.
 *
 * They differ by the gravity of the conduct, never by how formal they are:
 * everything issued through this bot is a formal written warning, and informal
 * correction happens in a DM and never reaches this record. Both are New
 * Zealand employment terms, so they mean something outside this bot as well.
 *
 * Neither rung expires. A tier used to also decide how long a warning counted
 * for, which made "Serious Misconduct" read as a termination-level judgement
 * no Executive actually made — that rung is retired rather than made
 * permanent alongside the other two. Every warning weighs one, whatever its
 * tier — the bot has never escalated on its own and does not start by summing
 * these into an action.
 */
export type ConductTier = "caution" | "misconduct";

export const CONDUCT_TIERS: readonly ConductTier[] = ["caution", "misconduct"];

export interface WarningDoc {
    _id: ObjectId;
    staffId: ObjectId;

    /**
     * What kind of warning this is.
     *
     * Absent on every warning written before conduct warnings existed, and read
     * as `activity` when absent — which is what all of them were.
     */
    kind?: "activity" | "conduct";

    /**
     * The assessment that issued it. **Null for a conduct warning**, which
     * belongs to no fortnight.
     *
     * This was required, and several paths still assume they can dereference
     * it. Each of those now guards explicitly rather than trusting the shape.
     */
    assessmentId: ObjectId | null;

    /** The rung. Null for an activity warning, which has no ladder. */
    tier?: ConductTier | null;

    issuedBy: ObjectId;
    issuedAt: Date;
    note: string;
    acknowledgedAt: Date | null;

    /**
     * Withdrawal, which is the only way a warning leaves somebody's total.
     *
     * The record is kept and marked rather than deleted, so it says what
     * happened: issued for this reason, taken back for that one. A withdrawn
     * warning counts nowhere, whatever its clock says.
     */
    withdrawnAt?: Date | null;
    withdrawnBy?: ObjectId | null;
    withdrawalReason?: string | null;

    /**
     * Where its card lives in the warning channel. The same pair `LeaveDoc`
     * carries, and for the same reason: one card, edited in place for the whole
     * life of the record rather than replaced.
     */
    logChannelId?: string | null;
    logMessageId?: string | null;
    /** Written by a rehearsal, and never counted against anyone. */
    rehearsal?: boolean;

    /**
     * Whether the DM carrying this warning actually arrived.
     *
     * Both absent on a warning written before these existed, which reads as
     * "unknown" rather than as a failure — the bot did not record it either way
     * then, and inventing a delivery it never observed would be worse than
     * saying so. Exactly one is set on every warning issued since.
     */
    deliveredAt?: Date | null;
    deliveryFailedAt?: Date | null;

    /**
     * Set when leave approved or changed after the warning took the fortnight
     * it was issued for off the review queue. The warning still stands: an
     * Executive decides whether to withdraw it, and the log card says so.
     */
    coveredByLeaveAt?: Date | null;
}

/**
 * `cancelled` is leave called off before it started: withdrawn by the member
 * while it waited on a decision, or cancelled after approval by them or by an
 * Executive. It
 * is its own state rather than an `ended` leave with no length, because the two
 * read differently to everybody: nobody was away, no roles were removed, and
 * there is nobody to welcome back.
 */
export type LeaveStatus = "pending" | "approved" | "declined" | "active" | "ended" | "cancelled";

export interface LeaveDoc {
    _id: ObjectId;
    staffId: ObjectId;
    requestedAt: Date;
    startDate: Date;
    /**
     * When the leave ends. Required: every leave is booked with a return date.
     * Ending leave early moves this to the moment it ended, so exemption
     * follows the leave actually taken, and keeps the booked date below.
     */
    endDate: Date;
    /** The return date as booked, when the leave ended before it. */
    plannedEndDate: Date | null;
    /**
     * A later return date the member asked for, waiting on an Executive. The
     * leave keeps running on `endDate` until somebody decides.
     */
    pendingExtension: PendingExtension | null;
    reason: string;
    status: LeaveStatus;
    decidedBy: ObjectId | null;
    decidedAt: Date | null;
    /** Snapshot of role IDs removed on activation. */
    removedRoles: string[];
    rolesRestoredAt: Date | null;
    /** Role IDs that no longer exist on return. */
    restoreErrors: string[];
    /**
     * The card in the leave channel. Stored so that any later change of state
     * can edit that one card in place, whether a decision, an early end, or the
     * scheduler closing it on time, instead of posting a second message about
     * the same leave.
     */
    logChannelId?: string | null;
    logMessageId?: string | null;
    /**
     * Set when an Executive ended the leave before its own end date. Null for
     * leave that ran its course or that the member ended themselves, so the
     * three cases can be told apart on the record and in the wording.
     */
    endedEarlyBy?: ObjectId | null;
    /** What the Executive who ended it early gave as the reason. The member is told it. */
    endedEarlyReason?: string | null;
    /**
     * Who called approved leave off before it started, and when. The booked
     * dates stay as they were: a cancelled leave covers nothing because its
     * status never counts, not because its dates were moved.
     */
    cancelledBy?: ObjectId | null;
    cancelledAt?: Date | null;
    /**
     * Why. Required from an Executive, who tells the member; optional from the
     * member themselves, whose reason goes on the card for the Executives.
     */
    cancellationReason?: string | null;
}

export interface PendingExtension {
    endDate: Date;
    reason: string;
    requestedAt: Date;
}

/**
 * A reply that pinged the Executives about a card, kept so it can be deleted
 * once the card no longer needs them. Keyed by what it is about
 * (`leave:<id>`, `row:<id>`, `review:<index>` and so on), so there is at most
 * one outstanding ping per thing and a newer one replaces the older.
 */
export interface PingDoc {
    _id: string;
    channelId: string;
    messageId: string;
    at: Date;
}

/** Server load, for the heatmap. No identity attached, ever. */
export interface DemandBucketDoc {
    _id: ObjectId;
    channelId: string;
    hourStart: Date;
    messages: number;
}

/**
 * Which minutes of an hour the bot was connected to the gateway and so able to
 * hear messages. Keyed by the UTC hour start. No identity attached, ever.
 *
 * A set of minute numbers rather than a counter so that recording a minute is
 * idempotent: a timer that fires twice in one minute cannot make an hour look
 * longer than sixty.
 */
export interface UptimeHourDoc {
    _id: Date;
    minutes: number[];
}

export interface AuditLogDoc {
    _id: ObjectId;
    actorId: string | null;
    action: string;
    targetStaffId: ObjectId | null;
    detail: Record<string, unknown>;
    at: Date;
}

/**
 * One-shot delivery receipts: ring closure DMs, recaps, milestones. Keyed by a
 * deterministic string so a duplicate key error is the "already sent" signal.
 * State lives here rather than in memory because the container restarts and a
 * recap must be sent neither twice nor not at all.
 */
export interface DeliveryDoc {
    _id: string;
    at: Date;
}

export interface GuildConfigDoc {
    _id: string;
    [key: string]: unknown;
}
