import { MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { belowThresholdFor, findAssessment } from "../domain/assessments.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { decisionPermitted, type ReviewAction } from "../domain/review.js";
import { isAssessableFortnight } from "../domain/assessments.js";
import { errorCard, noticeCard, reviewBulkConfirmCard } from "../render/cards.js";
import { COLOUR } from "../render/theme.js";
import { reviewDecisionModal, reviewBulkModal } from "../render/modals.js";
import { respond, sendOptions } from "../discord/respond.js";
import { staffDisplayName } from "../discord/displayName.js";

/**
 * Every button on a review row and on the queue header.
 *
 * A button's whole job here is to check what it can and then open a modal.
 * Nothing is written on the click, because every outcome now requires a written
 * reason and `showModal` cannot follow a defer: the modal has to be the first
 * and only response to the interaction. The writes happen in reviewModals.ts.
 *
 * The old handler wrote on the click and then disabled buttons by walking
 * `interaction.message.components`, which disabled every row in the message
 * rather than the one that was clicked. Rows now live in their own messages, so
 * there is nothing to walk and nothing to get wrong.
 */

const ACTIONS: ReviewAction[] = ["warn", "excuse", "dismiss", "reopen"];

/**
 * Answer on the card that was pressed, when the card is the caller's own.
 *
 * A button on an ephemeral card is a step in a conversation with one person, and
 * the answer belongs in place of the question: a pressed button that stays
 * pressable is an invitation to run the thing twice, and a reply underneath
 * reads as two things having happened. That is the rule everywhere else in this
 * bot, and the bulk confirmation was the one place still stacking messages.
 *
 * A button on a public card — the queue header's "Decide all remaining" — must
 * NOT be answered this way: editing it would overwrite the header everybody
 * reads with one Executive's ephemeral confirmation.
 */
async function answerInPlace(
    interaction: ButtonInteraction,
    card: import("../render/cards.js").RenderedMessage
): Promise<void> {
    if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await interaction.update(sendOptions(card) as never);
        return;
    }
    await respond(interaction, card);
}

export async function handleReviewButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    assessmentId: ObjectId,
    rawAction: string
): Promise<void> {
    const action = rawAction as ReviewAction;
    if (!ACTIONS.includes(action)) {
        await respond(interaction, errorCard("Unknown review action."));
        return;
    }

    const assessment = await findAssessment(assessmentId);
    if (!assessment) {
        await respond(interaction, errorCard("That assessment no longer exists."));
        return;
    }

    if (!isAssessableFortnight(assessment.fortnightIndex)) {
        await respond(
            interaction,
            errorCard(
                "That fortnight is before the anchor this cycle counts from, so it is not a " +
                    "fortnight of it and there is nothing to decide. The card was posted in " +
                    "error and can be ignored."
            )
        );
        return;
    }

    // Reopen is the only thing a decided row offers, and the only thing an
    // undecided row does not. Checked here so a stale card cannot be used to
    // decide the same row twice.
    if (action === "reopen" && !assessment.reviewOutcome) {
        await respond(
            interaction,
            errorCard("That row has no decision on it, so there is nothing to reopen.")
        );
        return;
    }
    if (action !== "reopen" && assessment.reviewOutcome) {
        await respond(
            interaction,
            errorCard(
                `That row is already **${assessment.reviewOutcome}**. Reopen it first if the ` +
                    "decision should change."
            )
        );
        return;
    }

    const member = await fetchPublicMember(client, config, interaction.user.id);
    const executive = isExecutive(resolveTier(interaction.user.id, member, config));
    const actor = await ensureStaff(interaction.user.id);
    const subject = await findStaffById(assessment.staffId);

    const permitted = decisionPermitted({
        action,
        isExecutive: executive,
        actorStaffId: actor._id,
        subjectStaffId: assessment.staffId,
        departed: subject ? subject.active === false : true
    });
    if (!permitted.ok) {
        await respond(interaction, errorCard(permitted.reason));
        return;
    }

    const name = subject
        ? await staffDisplayName(client, config, subject.discordId, "this member")
        : "this member";

    // The modal is the reply. Nothing above this line may defer or respond on
    // the happy path, or Discord refuses to show it.
    await interaction.showModal(
        reviewDecisionModal(assessmentId.toHexString(), action, name)
    );
}

/**
 * The header's bulk button.
 *
 * `ask` confirms on a card naming everybody it would touch; the three outcome
 * buttons open one modal for the shared reason. A bulk action writes to several
 * people's records at once, which is exactly why it names them first rather
 * than counting them.
 */
export async function handleReviewBulkButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    fortnightIndex: number,
    action: string
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(
            interaction,
            errorCard(
                "Review decisions are Executive only. Leads can read the queue and the " +
                    "warning history, and that is the whole of it."
            )
        );
        return;
    }

    if (action === "cancel") {
        await answerInPlace(
            interaction,
            noticeCard("Left as they were", "Nothing was changed. The queue is as it was.", {
                colour: COLOUR.settled
            })
        );
        return;
    }

    const actor = await ensureStaff(interaction.user.id);
    const remaining = (await belowThresholdFor(fortnightIndex)).filter(
        (row) => !row.reviewOutcome
    );

    if (remaining.length === 0) {
        await answerInPlace(
            interaction,
            noticeCard(
                "Nothing left",
                "Every row in that fortnight has already been decided.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    if (action === "ask") {
        const names: string[] = [];
        const skipped: string[] = [];
        for (const row of remaining) {
            const staff = await findStaffById(row.staffId);
            const label = staff
                ? await staffDisplayName(client, config, staff.discordId, "a departed member")
                : "an unknown member";
            // Named in the skipped list rather than dropped, so the count on
            // the confirmation matches what the buttons will actually do.
            if (row.staffId.equals(actor._id)) skipped.push(label);
            else names.push(label);
        }

        await respond(
            interaction,
            reviewBulkConfirmCard({ fortnightIndex, names, skipped })
        );
        return;
    }

    if (action !== "warn" && action !== "excuse" && action !== "dismiss") return;

    await interaction.showModal(
        reviewBulkModal(fortnightIndex, action as Exclude<ReviewAction, "reopen">, remaining.length)
    );
}
