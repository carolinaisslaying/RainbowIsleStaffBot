import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type {
    AssessmentStatus,
    FortnightAssessmentDoc,
    ReviewOutcome,
    WarningDoc
} from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fortnightAnchorDate } from "../config/guildConfig.js";
import { completesFortnight, fortnightIndexFor, fortnightWindow } from "../time/calendar.js";
import { countMinutesBetween } from "./activity.js";
import { leaveCoverageFor } from "./leave.js";
import { listActiveStaff } from "./staff.js";
import { weekWindowFor, type WeekWindow } from "./weekly.js";
import { audit } from "./audit.js";

/**
 * The enforcement unit is a fortnight, never a week. Weekly figures are display
 * only and trigger nothing.
 *
 * A member may record 0 minutes in week one and the full target in week two and
 * pass. That is intended.
 *
 * The bot never issues a warning by itself. It assesses, posts one review card,
 * and waits for an Executive.
 */

export function fortnightIndexForWeek(weekStart: Date, config: StaffBotConfig): number {
    return fortnightIndexFor(weekStart, fortnightAnchorDate(config));
}

/** True when the week closing at this week's end completes a fortnight. */
export function weekClosesFortnight(weekStart: Date, config: StaffBotConfig): boolean {
    return completesFortnight(weekStart, fortnightAnchorDate(config));
}

export function windowForIndex(index: number, config: StaffBotConfig) {
    return fortnightWindow(
        index,
        fortnightAnchorDate(config),
        config.accountingTimezone,
        config.weekStartDay
    );
}

export interface AssessmentComputation {
    staffId: ObjectId;
    fortnightIndex: number;
    windowStart: Date;
    windowEnd: Date;
    week1Minutes: number;
    week2Minutes: number;
    totalMinutes: number;
    requiredMinutes: number;
    status: AssessmentStatus;
}

export async function computeAssessment(
    staffId: ObjectId,
    index: number,
    config: StaffBotConfig
): Promise<AssessmentComputation> {
    const window = windowForIndex(index, config);

    const [week1Minutes, week2Minutes, week1Leave, week2Leave] = await Promise.all([
        countMinutesBetween(staffId, window.week1Start, window.week2Start),
        countMinutesBetween(staffId, window.week2Start, window.end),
        leaveCoverageFor(staffId, window.week1Start, window.week2Start),
        leaveCoverageFor(staffId, window.week2Start, window.end)
    ]);

    const totalMinutes = week1Minutes + week2Minutes;
    const requiredMinutes = config.fortnightRequiredMinutes;

    // Exemption follows whole weeks, not any overlap at all.
    //
    // A day of leave used to exempt an entire fortnight, which was too generous
    // in one direction and, because the same test greyed the member's rings,
    // misleading in the other: it told everyone they had been away when they
    // had worked thirteen of the fourteen days. A member who loses a full week
    // cannot reasonably make up a fortnight's target in the week that remains,
    // so a full week of leave, in either half, is what exempts them.
    const exempt = week1Leave.full || week2Leave.full;

    const status: AssessmentStatus = exempt
        ? "exempt"
        : totalMinutes >= requiredMinutes
          ? "met"
          : "below";

    return {
        staffId,
        fortnightIndex: index,
        windowStart: window.week1Start,
        windowEnd: window.end,
        week1Minutes,
        week2Minutes,
        totalMinutes,
        requiredMinutes,
        status
    };
}

/**
 * Persist an assessment. requiredMinutes is snapshotted here and never re-read
 * from live config: changing the target must not retroactively rewrite past
 * outcomes. A re-run refreshes the figures but leaves any review decision alone.
 */
export async function saveAssessment(
    computation: AssessmentComputation,
    rehearsal = false
): Promise<FortnightAssessmentDoc> {
    const result = await collections.fortnightAssessments().findOneAndUpdate(
        { staffId: computation.staffId, fortnightIndex: computation.fortnightIndex },
        {
            $set: {
                windowStart: computation.windowStart,
                windowEnd: computation.windowEnd,
                week1Minutes: computation.week1Minutes,
                week2Minutes: computation.week2Minutes,
                totalMinutes: computation.totalMinutes,
                status: computation.status
            },
            $setOnInsert: {
                _id: new ObjectId(),
                staffId: computation.staffId,
                fortnightIndex: computation.fortnightIndex,
                requiredMinutes: computation.requiredMinutes,
                reviewedBy: null,
                reviewOutcome: null,
                reviewedAt: null,
                reviewNote: null,
                reviewChannelId: null,
                reviewMessageId: null,
                rehearsal
            }
        },
        { upsert: true, returnDocument: "after" }
    );
    if (!result) throw new Error("Failed to persist fortnight assessment");
    return result;
}

/** Assess every active staff member for the fortnight that just closed. */
export async function assessFortnight(
    index: number,
    config: StaffBotConfig,
    rehearsal = false
): Promise<FortnightAssessmentDoc[]> {
    const staff = await listActiveStaff();
    const saved: FortnightAssessmentDoc[] = [];
    for (const member of staff) {
        const computation = await computeAssessment(member._id, index, config);
        saved.push(await saveAssessment(computation, rehearsal));
    }
    await audit("assessment.run", {
        detail: { fortnightIndex: index, assessed: saved.length }
    });
    return saved;
}

/**
 * Whether an index names a real fortnight of the cycle.
 *
 * `fortnightAnchor` is the origin the cycle counts from, and `fortnightIndexFor`
 * floors an unbounded division, so weeks before the anchor come back as
 * negative indices. Those are arithmetic, not fortnights: they describe windows
 * that closed before the cycle began, and on a deployment whose anchor is still
 * in the future that is every window there is. A restart assessed four of them,
 * found every member at 0 of 240 because no data existed yet, and DMed all of
 * them about it. There is no fortnight -6 to have an opinion about.
 */
export function isAssessableFortnight(index: number): boolean {
    return index >= 0;
}

/** The fortnight a closing week completes, or null when it does not complete one. */
export function closingFortnightIndex(
    closingWeek: WeekWindow,
    config: StaffBotConfig
): number | null {
    if (!weekClosesFortnight(closingWeek.start, config)) return null;
    const index = fortnightIndexForWeek(closingWeek.start, config);
    return isAssessableFortnight(index) ? index : null;
}

/** What a run of the assessment is allowed to send. */
export type AnnouncementPlan =
    /** Post the review card and DM each member their outcome. Once, ever. */
    | "announce"
    /** Post the card marked as a rehearsal. No DMs, no receipt, nothing issued. */
    | "rehearse"
    /** Compute and store, tell nobody. */
    | "silent";

/**
 * Whether this run may speak, given the fortnight, the dry run and whether the
 * fortnight has been announced before.
 *
 * A rehearsal deliberately ignores the receipt: the point of a dry run is to be
 * repeatable. It writes no receipt either, so turning the dry run off later
 * still announces the fortnight properly, exactly once.
 */
export function announcementPlan(options: {
    index: number;
    dryRun: boolean;
    alreadyAnnounced: boolean;
}): AnnouncementPlan {
    if (!isAssessableFortnight(options.index)) return "silent";
    if (options.dryRun) return "rehearse";
    return options.alreadyAnnounced ? "silent" : "announce";
}

/**
 * What the boot backfill may do about a fortnight it just rebuilt.
 *
 * Rebuilding a rollup is free: `weeklyStats` is derived and recomputing it
 * writes the same numbers. Announcing is not, and `catchUpMissedWeeks` used to
 * treat "no rollup exists for this week" as "the process was down when that
 * week closed". On a first boot that is true of every week in the lookback, so
 * a fresh deployment announced its own pre-history.
 *
 * A database with no rollups at all is a cold start, not eight weeks of
 * downtime. Its fortnights are seeded: the receipt is written so they are never
 * announced later either, and nobody is told about a fortnight that ended
 * before the bot could measure it.
 */
export function backfillPlan(options: {
    coldStart: boolean;
    index: number;
    alreadyAnnounced: boolean;
}): "announce" | "seed" | "skip" {
    if (!isAssessableFortnight(options.index)) return "skip";
    if (options.alreadyAnnounced) return "skip";
    return options.coldStart ? "seed" : "announce";
}

export function currentFortnightIndex(config: StaffBotConfig, now = new Date()): number {
    return fortnightIndexForWeek(weekWindowFor(now, config).start, config);
}

export async function assessmentsForFortnight(
    index: number
): Promise<FortnightAssessmentDoc[]> {
    return collections
        .fortnightAssessments()
        .find({ fortnightIndex: index })
        .sort({ totalMinutes: 1 })
        .toArray();
}

export async function belowThresholdFor(index: number): Promise<FortnightAssessmentDoc[]> {
    return collections
        .fortnightAssessments()
        .find({ fortnightIndex: index, status: "below" })
        .sort({ totalMinutes: 1 })
        .toArray();
}

export async function findAssessment(id: ObjectId): Promise<FortnightAssessmentDoc | null> {
    return collections.fortnightAssessments().findOne({ _id: id });
}

/**
 * A member's own history, as anything real is allowed to see it.
 *
 * Rehearsals are excluded because they were never real, and fortnights before
 * the anchor because they were never fortnights: an earlier boot assessed four
 * of them against a database that held no data, and those rows would otherwise
 * read as four shortfalls on somebody's record for ever.
 */
export async function assessmentHistory(
    staffId: ObjectId,
    limit = 10
): Promise<FortnightAssessmentDoc[]> {
    return collections
        .fortnightAssessments()
        .find({ staffId, rehearsal: { $ne: true }, fortnightIndex: { $gte: 0 } })
        .sort({ fortnightIndex: -1 })
        .limit(limit)
        .toArray();
}

/** Set, or move, where this row's card lives. */
export async function setReviewCard(
    assessmentId: ObjectId,
    channelId: string,
    messageId: string
): Promise<void> {
    await collections
        .fortnightAssessments()
        .updateOne({ _id: assessmentId }, { $set: { reviewChannelId: channelId, reviewMessageId: messageId } });
}

/**
 * Undo a decision, returning the row to the queue.
 *
 * The warning it issued goes with it: a withdrawn warning that stays on the
 * record is not withdrawn. This is the only path that deletes a warning, so
 * every removal is a reviewed decision with an audit row behind it.
 */
export async function clearReview(assessmentId: ObjectId): Promise<FortnightAssessmentDoc | null> {
    return collections.fortnightAssessments().findOneAndUpdate(
        { _id: assessmentId },
        {
            $set: {
                reviewedBy: null,
                reviewOutcome: null,
                reviewedAt: null,
                reviewNote: null
            }
        },
        { returnDocument: "after" }
    );
}

/** Remove the warnings an assessment issued. Returns how many went. */
export async function deleteWarningsFor(assessmentId: ObjectId): Promise<number> {
    const result = await collections.warnings().deleteMany({ assessmentId });
    return result.deletedCount;
}

export async function recordReview(
    assessmentId: ObjectId,
    reviewerStaffId: ObjectId,
    outcome: ReviewOutcome,
    note: string | null
): Promise<FortnightAssessmentDoc | null> {
    return collections.fortnightAssessments().findOneAndUpdate(
        { _id: assessmentId },
        {
            $set: {
                reviewedBy: reviewerStaffId,
                reviewOutcome: outcome,
                reviewedAt: new Date(),
                reviewNote: note
            }
        },
        { returnDocument: "after" }
    );
}

export async function issueWarning(
    staffId: ObjectId,
    assessmentId: ObjectId,
    issuedBy: ObjectId,
    note: string,
    rehearsal = false
): Promise<WarningDoc> {
    const warning: WarningDoc = {
        _id: new ObjectId(),
        staffId,
        assessmentId,
        issuedBy,
        issuedAt: new Date(),
        note,
        acknowledgedAt: null,
        rehearsal
    };
    await collections.warnings().insertOne(warning);
    return warning;
}

/** Every real warning against a member, newest first. Rehearsals are not real. */
export async function warningsFor(staffId: ObjectId): Promise<WarningDoc[]> {
    return collections
        .warnings()
        .find({ staffId, rehearsal: { $ne: true } })
        .sort({ issuedAt: -1 })
        .toArray();
}

/** The warning an assessment issued against a member, if it still exists. */
export async function findWarning(
    assessmentId: ObjectId,
    staffId: ObjectId
): Promise<WarningDoc | null> {
    return collections.warnings().findOne({ assessmentId, staffId });
}

export async function acknowledgeWarning(warningId: ObjectId): Promise<void> {
    await collections
        .warnings()
        .updateOne({ _id: warningId }, { $set: { acknowledgedAt: new Date() } });
}
