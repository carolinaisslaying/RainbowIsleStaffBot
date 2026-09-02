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
    /** Leave covered the WHOLE week. Only this greys the rings. */
    onLeave: boolean;
    /** Leave touched the week without covering it. Display only. */
    partialLeave: boolean;
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
    /** Snapshot of config at assessment time. Never re-read from live config. */
    requiredMinutes: number;
    status: AssessmentStatus;
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
 * The three rungs a conduct warning can be issued at.
 *
 * They differ by the gravity of the conduct, never by how formal they are:
 * everything issued through this bot is a formal written warning, and informal
 * correction happens in a DM and never reaches this record. The bottom two are
 * New Zealand employment terms, so they mean something outside this bot as well.
 *
 * A tier decides how long a warning counts for and nothing else. Every warning
 * weighs one, whatever its tier — the bot has never escalated on its own and
 * does not start by summing these into an action.
 */
export type ConductTier = "caution" | "misconduct" | "seriousMisconduct";

export const CONDUCT_TIERS: readonly ConductTier[] = [
    "caution",
    "misconduct",
    "seriousMisconduct"
];

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
     * The member's answer, if they gave one. One per warning, inside
     * `appealWindowDays`; the window runs from delivery, because a warning
     * nobody received is not one anybody could have contested.
     */
    appeal?: WarningAppeal | null;
}

export interface WarningAppeal {
    text: string;
    filedAt: Date;
    /** Set when an Executive has answered it, either way. */
    decidedAt: Date | null;
    /** `upheld` deletes the warning through the existing reopen path. */
    decision: "upheld" | "declined" | null;
    decidedBy: ObjectId | null;
    decisionNote: string | null;
}

export type LeaveStatus = "pending" | "approved" | "declined" | "active" | "ended";

export interface LeaveDoc {
    _id: ObjectId;
    staffId: ObjectId;
    requestedAt: Date;
    startDate: Date;
    /** null = open ended. */
    endDate: Date | null;
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
}

/** Server load, for the heatmap. No identity attached, ever. */
export interface DemandBucketDoc {
    _id: ObjectId;
    channelId: string;
    hourStart: Date;
    messages: number;
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
