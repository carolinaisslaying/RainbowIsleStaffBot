import {
    ComponentType,
    MessageFlags,
    type Client,
    type ModalSubmitInteraction
} from "discord.js";
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
    recordWarningDelivery,
    windowForIndex
} from "../domain/assessments.js";
import {
    OUTCOME_FOR,
    decisionPermitted,
    deliveryLine,
    reopenNotifies,
    type ReviewAction
} from "../domain/review.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { audit } from "../domain/audit.js";
import { tryDm } from "../discord/roles.js";
import { refreshQueueHeader, upsertReviewRow } from "../services/assessmentService.js";
import {
    errorCard,
    noticeCard,
    reviewBulkProgressCard,
    warningDmCard
} from "../render/cards.js";
import {
    FIELD_REASON,
    FIELD_SUBSET_ACTION,
    FIELD_SUBSET_ROWS,
    REVIEW_BULK_MODAL,
    REVIEW_DECISION_MODAL,
    REVIEW_SUBSET_MODAL
} from "../render/modals.js";
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
        // The row that changed, then the header's count. Redrawing every other
        // row rewrites cards nobody touched and makes one decision cost a
        // Discord edit per member in the queue.
        const decided = await findAssessment(assessment._id);
        if (decided) {
            await upsertReviewRow(
                client,
                config,
                decided,
                decided.fortnightIndex,
                decided.rehearsal === true
            );
        }
        await refreshQueueHeader(client, config, assessment.fortnightIndex, {
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

    // Deciding everybody. The subset path below chooses its own rows; both hand
    // the same set to the same runner, so a bulk warning and a subset warning
    // are the same warning written the same way.
    if (namespace === REVIEW_BULK_MODAL) {
        const [, , , expectedRaw] = interaction.customId.split(":");
        const fortnightIndex = Number(first);
        const action = second as Exclude<ReviewAction, "reopen">;
        const expected = Number(expectedRaw);

        if (!isAssessableFortnight(fortnightIndex)) {
            await respond(interaction, errorCard("That fortnight is not one this cycle counts."));
            return;
        }

        await deferOntoOwnCard(interaction);

        const rows = (await belowThresholdFor(fortnightIndex)).filter(
            (row) => !row.reviewOutcome
        );

        // The confirmation named a set, and a modal can sit open while somebody
        // else works the queue. Acting on the current set is right; letting the
        // reader think they acted on the set they read is not, so the difference
        // is reported rather than quietly absorbed.
        const movedOn =
            Number.isFinite(expected) && expected > 0 ? expected - rows.length : 0;

        await runDecisions({
            client,
            config,
            interaction,
            rows,
            action,
            reason,
            actor,
            fortnightIndex,
            movedOn: movedOn > 0 ? movedOn : 0,
            auditAction: `assessment.bulk.${action}`
        });
        return;
    }

    if (namespace !== REVIEW_SUBSET_MODAL) return;

    // Deciding a chosen few. One modal carried who, what and why, so everything
    // needed is here and there is no confirmation card to reconcile against.
    const fortnightIndex = Number(first);
    if (!isAssessableFortnight(fortnightIndex)) {
        await respond(interaction, errorCard("That fortnight is not one this cycle counts."));
        return;
    }

    const chosen = interaction.fields.getField(
        FIELD_SUBSET_ROWS,
        ComponentType.CheckboxGroup
    ).values;
    const action = interaction.fields.getField(
        FIELD_SUBSET_ACTION,
        ComponentType.RadioGroup
    ).value as Exclude<ReviewAction, "reopen"> | null;

    if (!action || !(action in OUTCOME_FOR)) {
        await respond(interaction, errorCard("Pick an outcome for the rows you ticked."));
        return;
    }
    if (chosen.length === 0) {
        await respond(
            interaction,
            errorCard("Nothing was ticked, so nothing was decided. The queue is as it was.")
        );
        return;
    }

    await deferOntoOwnCard(interaction);

    // Read back from the database rather than trusted from the modal, and
    // filtered to rows that are still undecided: the modal can sit open for as
    // long as anybody likes, and somebody else may have worked the queue while
    // it did. A row decided in the meantime is reported as moved on, not
    // decided twice.
    const ticked = new Set(chosen);
    const live = (await belowThresholdFor(fortnightIndex)).filter((row) =>
        ticked.has(row._id.toHexString())
    );
    const rows = live.filter((row) => !row.reviewOutcome);

    await runDecisions({
        client,
        config,
        interaction,
        rows,
        action,
        reason,
        actor,
        fortnightIndex,
        movedOn: ticked.size - rows.length,
        auditAction: `assessment.subset.${action}`
    });
}

/**
 * Answer on the card the modal was opened from.
 *
 * A modal submitted from a button is its own interaction, so deferring a *reply*
 * opens a second ephemeral message and leaves the card that asked sitting above
 * it — with its buttons still live, so the same run could be started again over
 * rows the first had just decided. Deferring an *update* edits that card
 * instead, which is the rule every other card here follows.
 *
 * Guarded rather than assumed: a modal that arrived without a message, or from a
 * public one, must not have that message overwritten with somebody's ephemeral
 * progress card.
 */
async function deferOntoOwnCard(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.isFromMessage() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.deferUpdate();
        return;
    }
    await defer(interaction, true);
}

/**
 * The run itself, shared by "decide everybody" and "decide these ones".
 *
 * Both paths differ only in how they choose their rows. Writing the loop twice
 * would be two copies of the decision path free to drift, which is the thing
 * `applyDecision` and `reviewRowFor` already exist to prevent — a subset warning
 * has to be the same warning, written the same way, as a bulk one.
 */
async function runDecisions(options: {
    client: Client;
    config: StaffBotConfig;
    interaction: ModalSubmitInteraction;
    rows: FortnightAssessmentDoc[];
    action: Exclude<ReviewAction, "reopen">;
    reason: string;
    actor: { _id: ObjectId };
    fortnightIndex: number;
    movedOn: number;
    auditAction: string;
}): Promise<void> {
    const { client, config, interaction, rows, action, reason, actor, fortnightIndex } = options;

    const done: string[] = [];
    const skipped: string[] = [];

    // The card is edited as the run goes rather than once at the end. Twelve
    // rows is twelve records, twelve messages and twelve card edits, which is
    // long enough that a reply saying nothing reads as one that has died.
    //
    // Throttled, because editing an interaction reply once per row on a long
    // queue is a rate limit waiting to happen and nobody can read it that fast
    // anyway. The first tick always goes, because lastTick starts at zero. The
    // finished card is not a tick at all: it is sent once below, after the
    // header has been redrawn, and carries the names.
    let lastTick = 0;
    const tick = async (): Promise<void> => {
        const now = Date.now();
        if (now - lastTick < 1500) return;
        lastTick = now;
        try {
            await respond(
                interaction,
                reviewBulkProgressCard({
                    outcome: OUTCOME_FOR[action],
                    done: done.length,
                    skipped: skipped.length,
                    total: rows.length,
                    finished: false
                })
            );
        } catch (error) {
            // Progress is a courtesy. Losing it must not stop the run.
            log.debug("Could not update bulk progress", error);
        }
    };

    await tick();

    for (const row of rows) {
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

            // The row's own card, straight away, so the channel shows the run
            // moving rather than changing all at once when it finishes.
            const decided = await findAssessment(row._id);
            if (decided) {
                await upsertReviewRow(
                    client,
                    config,
                    decided,
                    fortnightIndex,
                    decided.rehearsal === true
                );
            }
        } catch (error) {
            log.error(`Bulk ${action} failed for assessment ${row._id.toHexString()}`, error);
            skipped.push(`<@${subject?.discordId ?? "unknown"}>`);
        }
        await tick();
    }

    // The header once at the end. It carries a count, and a count that ticks
    // down in the channel is a dozen edits nobody is watching.
    await refreshQueueHeader(client, config, fortnightIndex, {
        rehearsal: rows[0]?.rehearsal === true
    });

    await audit(options.auditAction, {
        actorId: interaction.user.id,
        detail: {
            fortnightIndex,
            decided: done.length,
            skipped: skipped.length,
            reason
        }
    });

    await respond(
        interaction,
        reviewBulkProgressCard({
            outcome: OUTCOME_FOR[action],
            done: done.length,
            skipped: skipped.length,
            total: rows.length,
            finished: true,
            doneNames: done,
            skippedNames: skipped,
            reason,
            movedOn: options.movedOn > 0 ? options.movedOn : 0
        })
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
        // Permission to tell them, which is not the same as having told them.
        const mayTell =
            reopenNotifies(assessment.reviewOutcome) &&
            subject !== null &&
            (await mayNotify(client, config, rehearsal, subject.discordId));

        let told = false;
        if (mayTell && subject) {
            told = await tryDm(client, subject.discordId, {
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
                    : told
                      ? "They have been told it was withdrawn."
                      : mayTell
                        ? "⚠️ They could not be told it was withdrawn: their direct messages " +
                          "are closed. They may still believe the original decision stands."
                        : "They could not be told it was withdrawn."),
            colour: COLOUR.settled
        };
    }

    const outcome = OUTCOME_FOR[action];
    await recordReview(assessment._id, actorStaffId, outcome, reason);

    // Held, because the DM below carries its id on the appeal button and the
    // delivery result is written back against it afterwards.
    const issued =
        action === "warn" && subject
            ? await issueWarning(subject._id, assessment._id, actorStaffId, reason, rehearsal)
            : null;

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

    // Two different facts, and they used to be one variable. `attempted` is
    // whether we were allowed to message them; `messaged` is whether the
    // message actually arrived. Setting a single flag before calling `tryDm`
    // and discarding what it returned meant an Executive who warned somebody
    // with closed DMs read "They have been messaged" — and the branch below
    // saying otherwise could never run.
    let attempted = false;
    let messaged = false;

    if (notify && subject && (await mayNotify(client, config, rehearsal, subject.discordId))) {
        attempted = true;
        messaged =
            action === "warn"
                ? await tryDm(client, subject.discordId, {
                      ...warningDmCard({
                          warningId: assessment._id.toHexString(),
                          // A rehearsal's warning is not real, so it gets no
                          // appeal: there would be nothing to decide and the
                          // row it points at is going to be purged.
                          appealId: rehearsal ? null : (issued?._id.toHexString() ?? null),
                          appealWindowDays: config.appealWindowDays,
                          windowLabel: label,
                          totalMinutes: assessment.totalMinutes,
                          requiredMinutes: assessment.requiredMinutes,
                          reason
                      })
                  })
                : await tryDm(client, subject.discordId, {
                      ...noticeCard(
                          "Fortnight excused",
                          `Fortnight ${label}. You were below the requirement and an Executive ` +
                              `excused it, so you have no warning on record.\n\n**Why:** ${reason}`,
                          { colour: COLOUR.approved }
                      )
                  });
    }

    // What actually happened to the DM, against the warning it carried. This is
    // what lets the row say "never delivered" instead of "not yet
    // acknowledged", which is the same silence and a completely different fact.
    if (issued) await recordWarningDelivery(issued._id, messaged);

    return {
        title: `${outcome[0].toUpperCase()}${outcome.slice(1)}`,
        body:
            `<@${subject?.discordId ?? "unknown"}>, fortnight ${label}.\n\n` +
            `**Reason:** ${reason}\n\n` +
            deliveryLine({ action, attempted, messaged, rehearsal }),
        colour: action === "warn" ? COLOUR.pending : COLOUR.approved
    };
}
