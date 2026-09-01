import type { Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { FortnightAssessmentDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    belowThresholdFor,
    clearReview,
    deleteWarningsFor,
    findAssessment,
    isAssessableFortnight,
    issueWarning,
    recordReview,
    windowForIndex
} from "../domain/assessments.js";
import {
    OUTCOME_FOR,
    decisionPermitted,
    reopenNotifies,
    type ReviewAction
} from "../domain/review.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { audit } from "../domain/audit.js";
import { tryDm } from "../discord/roles.js";
import { postReviewQueue } from "../services/assessmentService.js";
import { errorCard, noticeCard, warningDmCard } from "../render/cards.js";
import { FIELD_REASON, REVIEW_BULK_MODAL, REVIEW_DECISION_MODAL } from "../render/modals.js";
import { defer, respond } from "../discord/respond.js";
import { labelWindow } from "../time/format.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * Where a review decision is actually written.
 *
 * The button opens the modal and writes nothing; this does the work once the
 * reason has been typed. Every path finishes by redrawing the whole queue, so
 * the row that was decided, the rows that were not, and the header's count all
 * end up agreeing with the database rather than with whatever the card happened
 * to say when it was posted.
 */

/**
 * Whether a rehearsal may message this person.
 *
 * A rehearsal exercises the real write path, so it really would DM somebody.
 * Only Executives are testing, so only Executives hear from one; everybody else
 * is silently skipped and the card says so. A rehearsal that messaged the whole
 * roster would be worse than no rehearsal at all.
 */
async function mayNotify(
    client: Client,
    config: StaffBotConfig,
    rehearsal: boolean,
    discordId: string
): Promise<boolean> {
    if (!rehearsal) return true;
    const member = await fetchPublicMember(client, config, discordId);
    return isExecutive(resolveTier(discordId, member, config));
}

export async function handleReviewModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const [namespace, first, second] = interaction.customId.split(":");
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();

    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Review decisions are Executive only."));
        return;
    }
    const actor = await ensureStaff(interaction.user.id);

    if (namespace === REVIEW_DECISION_MODAL) {
        const assessment = await findAssessment(new ObjectId(first));
        if (!assessment) {
            await respond(interaction, errorCard("That assessment no longer exists."));
            return;
        }
        // Re-checked here rather than trusted from the button: a modal can sit
        // open for as long as anyone likes, and somebody else may have decided
        // the row in the meantime.
        const action = second as ReviewAction;
        const subject = await findStaffById(assessment.staffId);
        const permitted = decisionPermitted({
            action,
            isExecutive: true,
            actorStaffId: actor._id,
            subjectStaffId: assessment.staffId,
            departed: subject ? subject.active === false : true
        });
        if (!permitted.ok) {
            await respond(interaction, errorCard(permitted.reason));
            return;
        }

        await defer(interaction, true);
        const summary = await applyDecision(
            client,
            config,
            assessment,
            action,
            reason,
            actor._id,
            interaction.user.id
        );
        await postReviewQueue(client, config, assessment.fortnightIndex, {
            rehearsal: assessment.rehearsal === true
        });
        await respond(
            interaction,
            noticeCard(summary.title, summary.body, {
                colour: summary.colour,
                ephemeral: true
            })
        );
        return;
    }

    if (namespace !== REVIEW_BULK_MODAL) return;

    const fortnightIndex = Number(first);
    const action = second as Exclude<ReviewAction, "reopen">;
    if (!isAssessableFortnight(fortnightIndex)) {
        await respond(interaction, errorCard("That fortnight is not one this cycle counts."));
        return;
    }

    await defer(interaction, true);

    const remaining = (await belowThresholdFor(fortnightIndex)).filter(
        (row) => !row.reviewOutcome
    );

    const done: string[] = [];
    const skipped: string[] = [];

    for (const row of remaining) {
        const subject = await findStaffById(row.staffId);
        const permitted = decisionPermitted({
            action,
            isExecutive: true,
            actorStaffId: actor._id,
            subjectStaffId: row.staffId,
            departed: subject ? subject.active === false : true
        });
        if (!permitted.ok) {
            skipped.push(`<@${subject?.discordId ?? "unknown"}>`);
            continue;
        }
        try {
            await applyDecision(
                client,
                config,
                row,
                action,
                reason,
                actor._id,
                interaction.user.id
            );
            done.push(`<@${subject?.discordId ?? "unknown"}>`);
        } catch (error) {
            log.error(`Bulk ${action} failed for assessment ${row._id.toHexString()}`, error);
            skipped.push(`<@${subject?.discordId ?? "unknown"}>`);
        }
    }

    await postReviewQueue(client, config, fortnightIndex, {
        rehearsal: remaining[0]?.rehearsal === true
    });

    await audit(`assessment.bulk.${action}`, {
        actorId: interaction.user.id,
        detail: { fortnightIndex, decided: done.length, skipped: skipped.length, reason }
    });

    await respond(
        interaction,
        noticeCard(
            `${done.length} ${done.length === 1 ? "row" : "rows"} decided`,
            (done.length > 0 ? `${OUTCOME_FOR[action]}: ${done.join(", ")}.\n\n` : "") +
                (skipped.length > 0
                    ? `Skipped: ${skipped.join(", ")}. You cannot warn yourself, and a ` +
                      "member who has left cannot be warned.\n\n"
                    : "") +
                `Reason recorded against each: ${reason}`,
            {
                colour: done.length > 0 ? COLOUR.approved : COLOUR.adverse,
                ephemeral: true
            }
        )
    );
}

/**
 * One decision, applied. Shared by the single row and the bulk path so the two
 * cannot drift: a bulk warning is the same warning, written the same way.
 */
async function applyDecision(
    client: Client,
    config: StaffBotConfig,
    assessment: FortnightAssessmentDoc,
    action: ReviewAction,
    reason: string,
    actorStaffId: ObjectId,
    actorDiscordId: string
): Promise<{ title: string; body: string; colour: number }> {
    const rehearsal = assessment.rehearsal === true;
    const subject = await findStaffById(assessment.staffId);
    const window = windowForIndex(assessment.fortnightIndex, config);
    const label = labelWindow(window.week1Start, window.end, config.accountingTimezone);

    if (action === "reopen") {
        const removed = await deleteWarningsFor(assessment._id);
        await clearReview(assessment._id);
        await audit("assessment.reopen", {
            actorId: actorDiscordId,
            targetStaffId: assessment.staffId,
            detail: {
                assessmentId: assessment._id.toHexString(),
                previousOutcome: assessment.reviewOutcome,
                warningsDeleted: removed,
                reason
            }
        });

        // Only if they were told about the decision in the first place. A
        // dismissal is never raised with them, so announcing its reopening
        // would be the first they heard of the whole thing.
        const tell =
            reopenNotifies(assessment.reviewOutcome) &&
            subject !== null &&
            (await mayNotify(client, config, rehearsal, subject.discordId));

        if (tell && subject) {
            await tryDm(client, subject.discordId, {
                ...noticeCard(
                    "A decision about you has been withdrawn",
                    `Fortnight ${label}. The outcome recorded against you has been reopened` +
                        (removed > 0
                            ? " and the warning it carried has been deleted."
                            : ".") +
                        `\n\n**Why:** ${reason}\n\n` +
                        "The fortnight is back with the Executives to decide again.",
                    { colour: COLOUR.settled }
                )
            });
        }

        return {
            title: "Reopened",
            body:
                "The row is back in the queue" +
                (removed > 0
                    ? `, and the warning it carried ${removed === 1 ? "was" : "warnings were"} ` +
                      "deleted"
                    : "") +
                ".\n\n" +
                (assessment.reviewOutcome === "dismissed"
                    ? "They were not told. They were never told about the dismissal either, " +
                      "so there is nothing for them to have stopped believing."
                    : tell
                      ? "They have been told it was withdrawn."
                      : "They could not be told it was withdrawn."),
            colour: COLOUR.settled
        };
    }

    const outcome = OUTCOME_FOR[action];
    await recordReview(assessment._id, actorStaffId, outcome, reason);

    if (action === "warn" && subject) {
        await issueWarning(subject._id, assessment._id, actorStaffId, reason, rehearsal);
    }

    await audit(`assessment.${action}`, {
        actorId: actorDiscordId,
        targetStaffId: assessment.staffId,
        detail: {
            assessmentId: assessment._id.toHexString(),
            outcome,
            reason,
            rehearsal,
            totalMinutes: assessment.totalMinutes,
            requiredMinutes: assessment.requiredMinutes
        }
    });

    // Dismissal tells nobody. It decides that nothing happened, and raising an
    // issue with somebody purely to say it has been dropped is worse than never
    // raising it.
    const notify = action !== "dismiss";
    let messaged = false;

    if (notify && subject && (await mayNotify(client, config, rehearsal, subject.discordId))) {
        messaged = true;
        if (action === "warn") {
            await tryDm(client, subject.discordId, {
                ...warningDmCard({
                    warningId: assessment._id.toHexString(),
                    windowLabel: label,
                    totalMinutes: assessment.totalMinutes,
                    requiredMinutes: assessment.requiredMinutes,
                    reason
                })
            });
        } else {
            await tryDm(client, subject.discordId, {
                ...noticeCard(
                    "Fortnight excused",
                    `Fortnight ${label}. You were below the requirement and an Executive ` +
                        `excused it, so you have no warning on record.\n\n**Why:** ${reason}`,
                    { colour: COLOUR.approved }
                )
            });
        }
    }

    return {
        title: `${outcome[0].toUpperCase()}${outcome.slice(1)}`,
        body:
            `<@${subject?.discordId ?? "unknown"}>, fortnight ${label}.\n\n` +
            `**Reason:** ${reason}\n\n` +
            (action === "dismiss"
                ? "They were not told; a dismissal is not raised with them."
                : messaged
                  ? "They have been messaged."
                  : rehearsal
                    ? "Rehearsal: they were not messaged, because they are not an Executive."
                    : "They could not be messaged."),
        colour: action === "warn" ? COLOUR.pending : COLOUR.approved
    };
}
