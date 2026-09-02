import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { FortnightAssessmentDoc, ReviewOutcome, WarningDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    announcementPlan,
    assessFortnight,
    assessmentHistory,
    appealedAssessmentIds,
    assessmentsForFortnight,
    belowThresholdFor,
    isAssessableFortnight,
    setReviewCard,
    warningsFor,
    windowForIndex,
    type AnnouncementPlan
} from "../domain/assessments.js";
import {
    activeWarningCount,
    deliveryState,
    priorOutcomesLine,
    queueCounts,
    queueHeadline,
    reminderDue,
    rowButtons,
    warningWeightLine
} from "../domain/review.js";
import {
    findReview,
    forgetReview,
    markReminded,
    rememberHeader,
    unremindedReviews
} from "../domain/reviewQueue.js";
import { findStaffById } from "../domain/staff.js";
import { staffChannel } from "./leaveService.js";
import {
    noticeCard,
    reviewHeaderCard,
    reviewRowMessage,
    type RenderedMessage
} from "../render/cards.js";
import { claimFortnightAnnouncement, sendFortnightOutcome } from "./notifications.js";
import { labelDate, labelWindow, formatMinutes, ts } from "../time/format.js";
import { sendOptions } from "../discord/respond.js";
import {
    renderSpread,
    renderTrend,
    type SpreadEntry,
    type TrendPoint
} from "../render/trend.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";
import { staffDisplayName } from "../discord/displayName.js";


/**
 * The bot never issues a warning by itself. It assesses, posts one review card
 * listing everyone below threshold, and waits for an Executive to decide.
 */


/** Past tense, for the line a decided card carries. */
const OUTCOME_LABEL_PAST: Record<ReviewOutcome, string> = {
    warned: "Warned",
    excused: "Excused",
    dismissed: "Dismissed"
};

/**
 * The member's earlier fortnights, in words.
 *
 * `assessmentHistory` already drops rehearsals and pre-anchor fortnights; this
 * turns what is left into a sentence. The old version printed
 * `F-3 0m below, F-5 0m warned`, which needs the reader to know what a
 * fortnight index is, that a negative one exists, and that "below" is a status
 * while "warned" is a decision about one. It is the line somebody reads
 * immediately before deciding a colleague's record.
 */
async function priorOutcomesFor(
    staffId: ObjectId,
    excludeIndex: number,
    config: StaffBotConfig
): Promise<string> {
    const history = await assessmentHistory(staffId, 6);
    const relevant = history.filter((entry) => entry.fortnightIndex !== excludeIndex);
    return priorOutcomesLine(
        relevant.map((entry) => ({
            windowStart: entry.windowStart,
            totalMinutes: entry.totalMinutes,
            requiredMinutes: entry.requiredMinutes,
            outcome: entry.reviewOutcome,
            status: entry.status
        })),
        (date) => labelDate(date, config.accountingTimezone)
    );
}


/**
 * Run the assessment for a closed fortnight and post the review card.
 *
 * What it is allowed to *say* is decided once, up front, by `announcementPlan`.
 * The figures are recomputed on every run by design; the DMs are not, and used
 * not to know the difference. A restart with an empty database announced four
 * fortnights of pre-history to everybody, and re-running an assessment to page
 * through a review backlog re-notified every member each time.
 */
export async function runFortnightAssessment(
    client: Client,
    config: StaffBotConfig,
    index: number,
    options: { dryRun?: boolean } = {}
): Promise<AnnouncementPlan> {
    const dryRun = options.dryRun ?? config.assessmentDryRun;

    if (!isAssessableFortnight(index)) {
        // Nothing is computed either: the window predates the anchor, so every
        // member would be measured over days the deployment did not exist for.
        log.warn(
            `Refusing to assess fortnight ${index}: it precedes the fortnight anchor, ` +
                "so it is not a fortnight of this cycle."
        );
        return "silent";
    }

    const assessments = await assessFortnight(index, config, dryRun);
    const window = windowForIndex(index, config);
    const label = labelWindow(window.week1Start, window.end, config.accountingTimezone);

    // Claimed before anything is sent, and never during a rehearsal: a dry run
    // has to be repeatable, and must not consume the one announcement the
    // fortnight gets for real.
    const plan = announcementPlan({
        index,
        dryRun,
        alreadyAnnounced: dryRun ? false : !(await claimFortnightAnnouncement(index))
    });

    if (plan === "silent") {
        log.info(`Fortnight ${index} already announced; figures refreshed, nobody notified.`);
        return plan;
    }

    // Every member gets their own outcome, met or not. A rehearsal tells none
    // of them: the point is to read the card, not to wake the roster.
    let undelivered = 0;
    for (const assessment of plan === "rehearse" ? [] : assessments) {
        const staff = await findStaffById(assessment.staffId);
        if (!staff) continue;

        const body =
            assessment.status === "exempt"
                ? `Fortnight ${label}. You were on approved leave, so this assessment does ` +
                  "not apply to you."
                : assessment.status === "met"
                  ? `Fortnight ${label}. You recorded ${formatMinutes(assessment.totalMinutes)} ` +
                    `against a requirement of ${assessment.requiredMinutes}. Target met.`
                  : `Fortnight ${label}. You recorded ${formatMinutes(assessment.totalMinutes)} ` +
                    `against a requirement of ${assessment.requiredMinutes}, a shortfall of ` +
                    `${assessment.requiredMinutes - assessment.totalMinutes}. An Executive ` +
                    "will review it and decide what happens.";

        const delivered = await sendFortnightOutcome(
            client,
            staff.discordId,
            body,
            assessment.status === "met"
                ? COLOUR.approved
                : assessment.status === "exempt"
                  ? COLOUR.settled
                  : COLOUR.pending
        );
        if (!delivered) undelivered += 1;
    }

    // Said once, at info, rather than per member at debug. A fortnight where a
    // third of the roster never heard the outcome is a fact about the
    // deployment, not a detail of one send.
    if (undelivered > 0) {
        log.warn(
            `Fortnight ${index}: ${undelivered} member(s) could not be DMed their outcome. ` +
                "Their direct messages are closed."
        );
    }

    await postReviewQueue(client, config, index, { rehearsal: plan === "rehearse" });
    return plan;
}

/**
 * Post or refresh a fortnight's queue: one header, then one message per member.
 *
 * Converges rather than appends. A row whose card already exists is edited; one
 * whose card has gone is reposted and its location updated. Re-running an
 * assessment therefore corrects the channel instead of stacking another copy of
 * it on top, which is what made the old card look like a fresh queue every time
 * anyone recomputed.
 *
 * Decided rows are kept and redrawn in their outcome, because the card is the
 * log. Dropping them was what made the review look like it forgot decisions.
 */
export async function postReviewQueue(
    client: Client,
    config: StaffBotConfig,
    index: number,
    options: { rehearsal?: boolean } = {}
): Promise<void> {
    const below = await refreshQueueHeader(client, config, index, options);
    if (below === null) return;

    for (const assessment of below) {
        await upsertReviewRow(client, config, assessment, index, options.rehearsal ?? false);
    }
}

/**
 * Redraw the header alone, and hand back the rows it counted.
 *
 * Split out because a decision changes the header on every click but changes
 * one row, and a bulk run changes the header repeatedly while it works. Redoing
 * every row each time is a Discord edit per member per decision, which on a
 * queue of any size is slow enough that the card looks stuck.
 *
 * Returns null when there is nowhere to post, so callers stop rather than
 * carrying on and failing once per row.
 */
export async function refreshQueueHeader(
    client: Client,
    config: StaffBotConfig,
    index: number,
    options: { rehearsal?: boolean } = {}
): Promise<FortnightAssessmentDoc[] | null> {
    const channel = await staffChannel(client, config, config.reportChannelId);
    if (!channel) {
        log.warn("No reportChannelId configured; skipping the fortnight review queue.");
        return null;
    }

    const below = await belowThresholdFor(index);
    const window = windowForIndex(index, config);
    const label = labelWindow(window.week1Start, window.end, config.accountingTimezone);
    // An appeal is the one thing that can be outstanding on a queue where every
    // row already has an outcome, so the header has to know about them or a
    // finished-looking queue silently holds somebody waiting for an answer.
    const appealed = await appealedAssessmentIds(below.map((row) => row._id));
    const counts = queueCounts(
        below.map((row) => ({
            outcome: row.reviewOutcome,
            underAppeal: appealed.has(row._id.toHexString())
        }))
    );

    // The header first, so it sits above the rows on a first posting.
    const existing = await findReview(index);

    // Every member assessed, not just the ones below: the point of the chart is
    // to say whether this was a bad fortnight for two people or for everybody.
    const everyone = await assessmentsForFortnight(index);
    const spreadEntries = everyone
        .filter((entry) => entry.status !== "exempt")
        .map((entry) => ({
            minutes: entry.totalMinutes,
            below: entry.status === "below"
        }));

    const header = reviewHeaderCard({
        fortnightIndex: index,
        windowLabel: label,
        headline: queueHeadline(counts, config.fortnightRequiredMinutes),
        remaining: counts.remaining,
        rehearsal: options.rehearsal ?? false,
        spread:
            spreadEntries.length > 0
                ? {
                      png: renderSpread({
                          entries: spreadEntries,
                          requiredMinutes: config.fortnightRequiredMinutes,
                          title: "Everyone this fortnight"
                      }),
                      alt: describeSpread(spreadEntries, config.fortnightRequiredMinutes)
                  }
                : null
    });

    let headerMessageId = existing?.headerMessageId ?? null;
    if (headerMessageId && existing) {
        try {
            const message = await channel.messages.fetch(existing.headerMessageId);
            await message.edit(sendOptions(header) as never);
        } catch {
            headerMessageId = null; // deleted by hand; post a new one below
        }
    }
    if (!headerMessageId) {
        const posted = await channel.send(sendOptions(header));
        headerMessageId = posted.id;
    }
    await rememberHeader(index, channel.id, headerMessageId);

    // No rows at all still gets a header, which reads "nothing to review". A
    // separate "assessed" notice for that case was a second message saying the
    // same thing.
    return below;
}

/** Draw one member's row, editing its own message if it already has one. */
export async function upsertReviewRow(
    client: Client,
    config: StaffBotConfig,
    assessment: FortnightAssessmentDoc,
    index: number,
    rehearsal: boolean
): Promise<void> {
    const channel = await staffChannel(client, config, config.reportChannelId);
    if (!channel) return;

    const row = await reviewRowFor(client, config, assessment, index, rehearsal);

    if (assessment.reviewChannelId && assessment.reviewMessageId) {
        try {
            const target = await client.channels.fetch(assessment.reviewChannelId);
            if (target?.isTextBased()) {
                const message = await target.messages.fetch(assessment.reviewMessageId);
                await message.edit(sendOptions(row) as never);
                return;
            }
        } catch {
            // Deleted by hand, or the channel moved. Fall through and repost.
        }
    }

    const posted = await channel.send(sendOptions(row));
    await setReviewCard(assessment._id, posted.channelId, posted.id);
}

/**
 * The one renderer for a review row, wherever it is being drawn.
 *
 * Every state change goes through this, so the colour, the buttons and the
 * record cannot disagree. Same reason `leaveCardFor` exists.
 */
export async function reviewRowFor(
    client: Client,
    config: StaffBotConfig,
    assessment: FortnightAssessmentDoc,
    index: number,
    rehearsal: boolean
): Promise<RenderedMessage> {
    const staff = await findStaffById(assessment.staffId);
    const departed = staff ? staff.active === false : true;
    const now = new Date();

    const warnings = staff ? await warningsFor(staff._id) : [];
    // The count that matters is what already counts, so a warning issued by
    // this very assessment is left out of "this would be their nth".
    // A conduct warning belongs to no assessment, so it is never the one this
    // row issued and always counts toward "this would be their nth". That is
    // the point of one total: an Executive deciding an attendance shortfall
    // should see that the member also has conduct history.
    const others = warnings.filter(
        (warning) => !warning.assessmentId?.equals(assessment._id)
    );
    const active = activeWarningCount(others, now, config);

    const decider = assessment.reviewedBy ? await findStaffById(assessment.reviewedBy) : null;
    // The live warning this assessment issued, if it has one.
    //
    // Withdrawn ones are skipped deliberately. Reopening no longer deletes the
    // warning, so a row that was warned, reopened and warned again has two
    // records against it — and the acknowledgement and appeal lines belong to
    // the one that still stands, not to the one that was taken back.
    const issued = warnings.find(
        (warning) => warning.assessmentId?.equals(assessment._id) && !warning.withdrawnAt
    );
    const trend = await trendFor(assessment.staffId, index, config);

    const decidedLine =
        assessment.reviewOutcome && assessment.reviewedAt
            ? `${OUTCOME_LABEL_PAST[assessment.reviewOutcome]}` +
              (decider ? ` by <@${decider.discordId}>` : "") +
              `, ${ts(assessment.reviewedAt, "R")}`
            : null;

    return reviewRowMessage({
        assessmentId: assessment._id.toHexString(),
        // The mention is appended rather than used as the fallback, so somebody
        // who has left both servers reads as a named row an Executive can still
        // click through, not as the same mention printed twice.
        displayName: staff
            ? `${await staffDisplayName(
                  client,
                  config,
                  staff.discordId,
                  "Departed member"
              )} (<@${staff.discordId}>)`
            : "unknown member",
        week1Minutes: assessment.week1Minutes,
        week2Minutes: assessment.week2Minutes,
        totalMinutes: assessment.totalMinutes,
        requiredMinutes: assessment.requiredMinutes,
        priorOutcomes: await priorOutcomesFor(assessment.staffId, index, config),
        warningWeight: warningWeightLine(active),
        buttons: rowButtons({
            outcome: assessment.reviewOutcome,
            departed,
            rehearsal
        }),
        outcome: assessment.reviewOutcome,
        decidedLine,
        reason: assessment.reviewNote,
        // Three states where there used to be two. "Not yet acknowledged" was
        // drawn both for a member who read it and never pressed the button and
        // for one whose DMs are closed, who never saw it at all — the same
        // silence, and opposite facts to anybody deciding whether a warning has
        // been ignored.
        acknowledgedLine: issued ? acknowledgementLine(issued) : null,
        appeal:
            issued?.appeal && !issued.appeal.decidedAt
                ? {
                      text: issued.appeal.text,
                      filedLine: `Appealed ${ts(issued.appeal.filedAt, "R")}`,
                      warningId: issued._id.toHexString()
                  }
                : null,
        departed,
        rehearsal: assessment.rehearsal === true,
        trend: trend.points.length > 0
            ? {
                  png: renderTrend({
                      points: trend.points,
                      requiredMinutes: config.fortnightRequiredMinutes,
                      title: "Recent fortnights"
                  }),
                  alt: trend.alt
              }
            : null,
        // A recompute can lift somebody above the requirement after they were
        // decided. The figures move; the decision is a human's and stays put,
        // flagged so a human can reopen it if they want to.
        contradiction:
            assessment.reviewOutcome && assessment.totalMinutes >= assessment.requiredMinutes
                ? "⚠️ A recompute has since put them above the requirement. The decision " +
                  "above still stands; reopen it if it should not."
                : null
    });
}

/**
 * What the row says about a warning's delivery, in one place.
 *
 * A warning issued before delivery was recorded carries neither timestamp, and
 * reads as unknown rather than as delivered: the bot did not observe it either
 * way, and asserting a delivery it never saw is the whole mistake this replaced.
 */
function acknowledgementLine(warning: WarningDoc): string {
    switch (deliveryState(warning)) {
        case "acknowledged":
            return `Acknowledged ${ts(warning.acknowledgedAt as Date, "R")}`;
        case "failed":
            return "⚠️ Never delivered — their direct messages are closed, so they have not seen this";
        case "delivered":
            return "Delivered, not yet acknowledged";
        default:
            return "Not yet acknowledged";
    }
}

export async function fortnightSummary(index: number): Promise<{
    total: number;
    met: number;
    below: number;
    exempt: number;
    assessments: FortnightAssessmentDoc[];
}> {
    const assessments = await assessmentsForFortnight(index);
    return {
        total: assessments.length,
        met: assessments.filter((entry) => entry.status === "met").length,
        below: assessments.filter((entry) => entry.status === "below").length,
        exempt: assessments.filter((entry) => entry.status === "exempt").length,
        assessments
    };
}


/**
 * The queue's one reminder.
 *
 * Once, `reviewReminderDays` after posting, if anything is still undecided.
 * `remindedAt` is set when it fires and never reset, so a queue worked slowly is
 * chased a single time rather than nagged daily until somebody clicks something
 * to make it stop.
 */
export async function chaseUnworkedQueues(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    const channel = await staffChannel(client, config, config.reportChannelId);
    if (!channel) return 0;

    let sent = 0;
    for (const review of await unremindedReviews()) {
        const below = await belowThresholdFor(review._id);
        const counts = queueCounts(below.map((row) => ({ outcome: row.reviewOutcome })));

        if (
            !reminderDue({
                postedAt: review.postedAt,
                remindedAt: review.remindedAt,
                remaining: counts.remaining,
                now,
                afterDays: config.reviewReminderDays
            })
        ) {
            continue;
        }

        const window = windowForIndex(review._id, config);
        await channel.send({
            ...noticeCard(
                "A review is still waiting",
                `${labelWindow(window.week1Start, window.end, config.accountingTimezone)}: ` +
                    `**${counts.remaining}** of ${counts.below} ` +
                    `${counts.below === 1 ? "row" : "rows"} still has no decision, ` +
                    `${ts(review.postedAt, "R")} after it was posted.\n\n` +
                    "The cards are above. This is the only reminder.",
                { colour: COLOUR.pending }
            )
        });

        await markReminded(review._id, now);
        sent += 1;
    }

    return sent;
}


/**
 * The member's last six fortnights, oldest first, ready to plot.
 *
 * Oldest first because a chart of time reads left to right, while
 * `assessmentHistory` returns newest first for the text line. Exempt fortnights
 * are kept and marked rather than dropped: a gap in the row would read as a
 * fortnight nobody measured, when in fact it is one they were excused from.
 */
async function trendFor(
    staffId: ObjectId,
    currentIndex: number,
    config: StaffBotConfig
): Promise<{ points: TrendPoint[]; alt: string }> {
    const history = await assessmentHistory(staffId, 6);
    const points: TrendPoint[] = history
        .slice()
        .reverse()
        .map((entry) => ({
            label: labelDate(entry.windowStart, config.accountingTimezone),
            minutes: entry.totalMinutes,
            exempt: entry.status === "exempt",
            current: entry.fortnightIndex === currentIndex
        }));

    return { points, alt: describeTrend(points, config.fortnightRequiredMinutes) };
}

/**
 * The chart in words, for the alt text.
 *
 * A screen reader gets the shape, not a list of numbers: the shape is what the
 * chart is for, and the figures are already in the card above it.
 */
function describeTrend(points: TrendPoint[], required: number): string {
    if (points.length === 0) return "No earlier fortnight to compare against.";
    const measured = points.filter((point) => !point.exempt);
    const met = measured.filter((point) => point.minutes >= required).length;
    const exempt = points.length - measured.length;

    return (
        `Their last ${points.length} fortnights against a ${required} minute requirement: ` +
        `${met} met, ${measured.length - met} below` +
        (exempt > 0 ? `, ${exempt} on leave` : "") +
        `. Most recent first to last: ` +
        points
            .map((point) =>
                point.exempt ? `${point.label} on leave` : `${point.label} ${point.minutes}`
            )
            .join(", ") +
        "."
    );
}

function describeSpread(entries: SpreadEntry[], required: number): string {
    const below = entries.filter((entry) => entry.below).length;
    const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    const median = [...entries].sort((left, right) => left.minutes - right.minutes)[
        Math.floor(entries.length / 2)
    ];
    return (
        `${entries.length} members assessed against a ${required} minute requirement. ` +
        `${below} below the line. Median ${median?.minutes ?? 0} minutes, ` +
        `${Math.round(total / entries.length)} on average.`
    );
}


/**
 * Delete a review from the channel: every row card, and the header above them.
 *
 * Takes the assessments rather than a fortnight index, because the caller is
 * about to delete those documents and the documents are the only record of
 * where their cards are. Looking them up afterwards returns nothing and leaves
 * a channel full of orphaned cards for members whose records no longer exist,
 * which is exactly what happened the first time this was written.
 *
 * Best effort per message, as `updateLeaveCard` is: a card somebody already
 * deleted by hand must not stop the rest from going.
 */
export async function deleteReviewMessages(
    client: Client,
    assessments: FortnightAssessmentDoc[]
): Promise<number> {
    let removed = 0;

    const drop = async (channelId: string, messageId: string): Promise<void> => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.isTextBased()) return;
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            removed += 1;
        } catch (error) {
            log.debug(`Could not delete review message ${messageId}`, error);
        }
    };

    for (const assessment of assessments) {
        if (assessment.reviewChannelId && assessment.reviewMessageId) {
            await drop(assessment.reviewChannelId, assessment.reviewMessageId);
        }
    }

    // One header per fortnight, and a purge can span several of them: clearing
    // every pre-anchor fortnight at once is four headers, not one.
    for (const index of new Set(assessments.map((entry) => entry.fortnightIndex))) {
        const review = await findReview(index);
        if (!review) continue;
        await drop(review.headerChannelId, review.headerMessageId);
        // The header's location goes with it, so a re-run posts a fresh one
        // rather than trying to edit a message that is no longer there.
        await forgetReview(index);
    }

    return removed;
}
