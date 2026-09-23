import type { Client } from "discord.js";
import type { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { FortnightAssessmentDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fortnightAnchorDate } from "../config/guildConfig.js";
import {
    computeAssessment,
    findAssessmentFor,
    isAssessableFortnight,
    rulesOf,
    saveAssessment,
    warningsForAssessment
} from "../domain/assessments.js";
import { fortnightsTouching, type LeaveSpan } from "../domain/leaveDays.js";
import { rebuildWeek } from "../domain/weekly.js";
import { findStaffById } from "../domain/staff.js";
import { audit } from "../domain/audit.js";
import { refreshQueueHeader, rowAttention, upsertReviewRow } from "./assessmentService.js";
import { upsertWarningCard } from "./conductService.js";
import { pingExecutives, pingKey, resolvePing } from "./pings.js";
import { log } from "../log.js";

/**
 * Leave changed after a fortnight closed, so the fortnight is assessed again.
 *
 * Approving, declining, extending, ending early and purging all move how much
 * leave a closed week holds, and so its requirement and its verdict. Each of
 * them calls this with the stretch of time the change touched, and every
 * closed, real assessment in that stretch is recomputed against the rules it
 * was first assessed under.
 *
 * Nobody is messaged: the fortnight was announced once already. What changes
 * is the review channel, which has to keep telling the truth:
 *
 *  - a row that newly falls below is posted, and the Executives are pinged;
 *  - a row held for pending leave says so and pings, and stops once the leave
 *    is decided;
 *  - a row leave takes off the queue is redrawn with nothing to decide;
 *  - a warning already issued on such a row is flagged on its log card for an
 *    Executive to withdraw or keep. The bot never withdraws one by itself.
 */
export async function reassessAfterLeaveChange(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    spans: LeaveSpan[],
    cause: string,
    now = new Date()
): Promise<void> {
    const calendar = {
        anchor: fortnightAnchorDate(config),
        timeZone: config.accountingTimezone,
        weekStartDay: config.weekStartDay
    };

    const windows = new Map<number, ReturnType<typeof fortnightsTouching>[number]>();
    for (const span of spans) {
        for (const window of fortnightsTouching(span, calendar)) windows.set(window.index, window);
    }

    for (const window of [...windows.values()].sort((left, right) => left.index - right.index)) {
        // Closed weeks keep a stored rollup, and the rings drawn from it should
        // grey or un-grey with the leave, whatever the fortnight does.
        for (const [start, end] of [
            [window.week1Start, window.week2Start],
            [window.week2Start, window.end]
        ] as const) {
            if (end.getTime() <= now.getTime()) {
                await rebuildWeek(staffId, { start, end }, config, now);
            }
        }

        if (window.end.getTime() > now.getTime()) continue;
        if (!isAssessableFortnight(window.index)) continue;

        try {
            await reassessOne(client, config, staffId, window.index, cause, now);
        } catch (error) {
            log.error(
                `Could not reassess fortnight ${window.index} for ${staffId.toHexString()}`,
                error
            );
        }
    }
}

async function reassessOne(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    index: number,
    cause: string,
    now: Date
): Promise<void> {
    const before = await findAssessmentFor(staffId, index);
    // Never assessed, or only rehearsed: there is no verdict for leave to move.
    if (!before || before.rehearsal) return;

    const computation = await computeAssessment(staffId, index, config, rulesOf(before));
    // Leave days are compared as well as the verdict, because the row prints
    // them: two days of leave that became one would otherwise go unredrawn.
    if (
        computation.status === before.status &&
        computation.requiredMinutes === before.requiredMinutes &&
        computation.heldForLeave === before.heldForLeave &&
        computation.week1LeaveDays === before.week1LeaveDays &&
        computation.week2LeaveDays === before.week2LeaveDays
    ) {
        return;
    }

    const after = await saveAssessment(computation, false, now);

    await audit("assessment.leaveChanged", {
        targetStaffId: staffId,
        detail: {
            fortnightIndex: index,
            cause,
            before: {
                status: before.status,
                requiredMinutes: before.requiredMinutes,
                held: before.heldForLeave
            },
            after: {
                status: after.status,
                requiredMinutes: after.requiredMinutes,
                held: after.heldForLeave
            }
        }
    });

    // A row is only ever drawn for a fortnight that was once below. One that
    // never was has no card to correct, and posting one to say "nothing to
    // decide" would be noise.
    const hasRow = Boolean(after.reviewMessageId);
    if (after.status === "below" || hasRow) {
        await upsertReviewRow(client, config, after, index, false);
    }

    // Pinged when what the row asks of an Executive changes: it joined or left
    // the queue, or became decidable or held. A requirement that moved while
    // the row stayed where it was only needs the redraw above.
    if (
        (before.status === "below") !== (after.status === "below") ||
        before.heldForLeave !== after.heldForLeave
    ) {
        await rowAttention(client, config, after, before.status !== "below");
    }
    await flagWarnings(client, config, before, after);
    await refreshQueueHeader(client, config, index);
}

/**
 * A warning issued on a row that leave has since taken off the queue.
 *
 * Flagged, never withdrawn: whether a late leave approval excuses a warning
 * somebody already decided is a judgement, and the bot does not make those.
 * The flag clears by itself if a later change puts the row back below.
 */
async function flagWarnings(
    client: Client,
    config: StaffBotConfig,
    before: FortnightAssessmentDoc,
    after: FortnightAssessmentDoc
): Promise<void> {
    const covered = after.status !== "below";
    if ((before.status === "below") === (after.status === "below")) return;

    for (const warning of await warningsForAssessment(after._id)) {
        if (warning.withdrawnAt || warning.rehearsal) continue;

        await collections
            .warnings()
            .updateOne(
                { _id: warning._id },
                { $set: { coveredByLeaveAt: covered ? new Date() : null } }
            );
        await upsertWarningCard(client, config, warning._id);

        const key = pingKey.warning(warning._id);
        if (!covered) {
            await resolvePing(client, key);
            continue;
        }

        const card = await collections.warnings().findOne({ _id: warning._id });
        const target =
            card?.logChannelId && card.logMessageId
                ? { channelId: card.logChannelId, messageId: card.logMessageId }
                : after.reviewChannelId && after.reviewMessageId
                  ? { channelId: after.reviewChannelId, messageId: after.reviewMessageId }
                  : null;
        if (!target) continue;

        const staff = await findStaffById(after.staffId);
        await pingExecutives(
            client,
            config,
            key,
            target,
            `The warning on ${staff ? `<@${staff.discordId}>` : "a departed member"} for ` +
                `fortnight ${after.fortnightIndex} is on a fortnight their leave has since ` +
                "taken off the queue. Withdraw it if it should not stand."
        );
    }
}
