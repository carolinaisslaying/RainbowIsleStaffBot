import type { ButtonInteraction, Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    acknowledgeWarning,
    findAssessment,
    findWarning,
    findWarningById
} from "../domain/assessments.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { audit } from "../domain/audit.js";
import { upsertReviewRow } from "../services/assessmentService.js";
import { upsertWarningCard } from "../services/conductService.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { COLOUR } from "../render/theme.js";
import { EMOJI } from "../render/emoji.js";

/**
 * The member acknowledging their own warning.
 *
 * The button is on the DM, so the person pressing it is the person it is about,
 * and the only check that matters is that it is their warning. Acknowledgement
 * is the difference between a warning somebody has not seen and one they have
 * ignored, which is the only one of those an Executive can fairly act on later.
 *
 * The custom ID carries the assessment id rather than the warning id: the DM is
 * composed at the moment the decision is applied, and the assessment is what
 * both ends already know.
 */
export async function handleWarningButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    id: ObjectId,
    action: string
): Promise<void> {
    if (action !== "ack") return;

    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) {
        await respond(interaction, errorCard("You have no staff record."));
        return;
    }

    // The id is a WARNING id on a conduct warning, and an ASSESSMENT id on an
    // activity one — including every activity DM already sitting in somebody's
    // inbox, which must keep working. Try the warning first, fall back to the
    // assessment. Both lookups are scoped to the caller, so neither can be used
    // to reach somebody else's record.
    const byWarning = await findWarningById(id);
    const warning =
        byWarning && byWarning.staffId.equals(staff._id)
            ? byWarning
            : await findWarning(id, staff._id);

    if (!warning || !warning.staffId.equals(staff._id)) {
        await respond(
            interaction,
            errorCard(
                "That warning is not yours, or it has been withdrawn and there is nothing " +
                    "left to acknowledge."
            )
        );
        return;
    }

    // A withdrawn warning is finished. Acknowledging one would record that they
    // read something that no longer counts against them.
    if (warning.withdrawnAt) {
        await respond(
            interaction,
            noticeCard(
                "Already withdrawn",
                "This warning has been withdrawn. It counts against you nowhere and there is " +
                    "nothing left to acknowledge.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    if (!warning.acknowledgedAt) {
        await acknowledgeWarning(warning._id);
        await audit("warning.acknowledge", {
            actorId: interaction.user.id,
            targetStaffId: staff._id,
            detail: { warningId: warning._id.toHexString() }
        });
    }

    // The card that carried the button is replaced, so it cannot be pressed
    // again to no effect, and the Executives' copy is redrawn so the review
    // channel shows that it landed.
    await interaction.update(
        sendOptions(
            noticeCard(
                "Thank you",
                "Your Executives can see that you have read it. If you disagree with it, " +
                    "reply to them: acknowledging it is not agreeing with it.",
                { colour: COLOUR.settled, emoji: EMOJI.welcome }
            )
        ) as never
    );

    // Both copies the Executives can see. A conduct warning has no review row;
    // an activity one has both a row and a card in the log.
    if (warning.assessmentId) {
        const assessment = await findAssessment(warning.assessmentId);
        if (assessment) {
            await upsertReviewRow(
                client,
                config,
                assessment,
                assessment.fortnightIndex,
                assessment.rehearsal === true
            );
        }
    }
    await upsertWarningCard(client, config, warning._id);
}
