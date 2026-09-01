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
    reviewNote: string | null;
}

export interface WarningDoc {
    _id: ObjectId;
    staffId: ObjectId;
    assessmentId: ObjectId;
    issuedBy: ObjectId;
    issuedAt: Date;
    note: string;
    acknowledgedAt: Date | null;
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
