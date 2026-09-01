import type { ButtonInteraction, Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { acknowledgeWarning, findAssessment, findWarning } from "../domain/assessments.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { audit } from "../domain/audit.js";
import { upsertReviewRow } from "../services/assessmentService.js";
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
    assessmentId: ObjectId,
    action: string
): Promise<void> {
    if (action !== "ack") return;

    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) {
        await respond(interaction, errorCard("You have no staff record."));
        return;
    }

    const assessment = await findAssessment(assessmentId);
    if (!assessment || !assessment.staffId.equals(staff._id)) {
        await respond(interaction, errorCard("That warning is not yours."));
        return;
    }

    const warning = await findWarning(assessmentId, staff._id);
    if (!warning) {
        await respond(
            interaction,
            errorCard("That warning has been withdrawn. There is nothing left to acknowledge.")
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

    await upsertReviewRow(
        client,
        config,
        assessment,
        assessment.fortnightIndex,
        assessment.rehearsal === true
    );
}
