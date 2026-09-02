import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    declineAppeal,
    fileAppeal,
    findAssessment,
    findWarningById,
    windowForIndex
} from "../domain/assessments.js";
import { appealPermitted, appealWindowCloses } from "../domain/review.js";
import { ensureStaff, findStaffByDiscordId, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, isExecutive, resolveTier } from "../domain/permissions.js";
import { audit } from "../domain/audit.js";
import { tryDm } from "../discord/roles.js";
import { upsertReviewRow } from "../services/assessmentService.js";
import { errorCard, noticeCard } from "../render/cards.js";
import {
    APPEAL_DECLINE_MODAL,
    APPEAL_MODAL,
    FIELD_APPEAL,
    FIELD_REASON,
    appealDeclineModal,
    appealModal
} from "../render/modals.js";
import { defer, respond } from "../discord/respond.js";
import { staffDisplayName } from "../discord/displayName.js";
import { labelWindow, ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * A member answering back.
 *
 * The button lives on the warning DM, so the person pressing it is the person
 * it is about — but that is checked rather than assumed, the same way the
 * acknowledgement button checks it. The window and the one-appeal limit are
 * re-derived here and again on the modal submission, never carried from where
 * the button was drawn: a DM sits in an inbox indefinitely, and a guard
 * enforced only at render time is not a guard.
 *
 * Nothing about the appeal is announced. The row turns amber and the header
 * counts it, which is where an Executive is already looking. A ping would be a
 * second message about one assessment, and the one-card rule exists to stop
 * exactly that.
 */

/** Both entry points need the same four facts, resolved the same way. */
async function resolveAppeal(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    config: StaffBotConfig,
    warningId: string
) {
    if (!ObjectId.isValid(warningId)) return { ok: false as const, card: errorCard("That warning no longer exists.") };

    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return { ok: false as const, card: errorCard("You have no staff record.") };

    const warning = await findWarningById(new ObjectId(warningId));
    if (!warning) {
        return {
            ok: false as const,
            card: noticeCard(
                "Nothing to appeal",
                "That warning has been withdrawn. There is nothing left to contest, and " +
                    "nothing on your record.",
                { colour: COLOUR.settled }
            )
        };
    }

    // The button is on their own DM, but a customId is just a string and this
    // is somebody's disciplinary record.
    if (!warning.staffId.equals(staff._id)) {
        return { ok: false as const, card: errorCard("That warning is not yours.") };
    }

    const permitted = appealPermitted({
        deliveredAt: warning.deliveredAt,
        appealFiled: Boolean(warning.appeal),
        windowDays: config.appealWindowDays,
        now: new Date()
    });

    if (!permitted.ok) {
        const closes = appealWindowCloses(warning.deliveredAt, config.appealWindowDays);
        const card =
            permitted.reason === "already-filed"
                ? noticeCard(
                      "Already appealed",
                      "You have appealed this one. Your Executives have it and will decide " +
                          "again; there is one appeal per warning so that a decision can " +
                          "actually be reached.",
                      { colour: COLOUR.settled }
                  )
                : permitted.reason === "window-closed"
                  ? noticeCard(
                        "The window has closed",
                        `Appeals close ${config.appealWindowDays} days after the warning ` +
                            `reaches you, and this one closed${closes ? ` ${ts(closes, "R")}` : ""}.` +
                            "\n\nYou can still raise it with the Executive team directly.",
                        { colour: COLOUR.settled }
                    )
                  : noticeCard(
                        "Nothing to appeal yet",
                        "This warning was never delivered to you, so the appeal window has " +
                            "not opened. Speak to the Executive team.",
                        { colour: COLOUR.settled }
                    );
        return { ok: false as const, card };
    }

    return { ok: true as const, staff, warning };
}

export async function handleAppealButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    warningId: string,
    action: string
): Promise<void> {
    // The Executive's half, on the review row rather than on the DM. Its own
    // gate: the row sits in a staff channel anybody with access can click in.
    if (action === "decline") {
        const member = await fetchPublicMember(client, config, interaction.user.id);
        if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
            await respond(interaction, errorCard("Deciding an appeal is Executive only."));
            return;
        }

        if (!ObjectId.isValid(warningId)) return;
        const warning = await findWarningById(new ObjectId(warningId));
        if (!warning?.appeal || warning.appeal.decidedAt) {
            await respond(
                interaction,
                noticeCard(
                    "Already answered",
                    "This appeal has been decided, or the warning it was about is gone.",
                    { colour: COLOUR.settled }
                )
            );
            return;
        }

        const subject = await findStaffById(warning.staffId);
        await interaction.showModal(
            appealDeclineModal(
                warningId,
                subject
                    ? await staffDisplayName(client, config, subject.discordId, "The member")
                    : "The member"
            )
        );
        return;
    }

    if (action !== "open") return;

    const resolved = await resolveAppeal(interaction, config, warningId);
    if (!resolved.ok) {
        await respond(interaction, resolved.card);
        return;
    }

    const assessment = await findAssessment(resolved.warning.assessmentId);
    const label = assessment
        ? labelWindow(
              windowForIndex(assessment.fortnightIndex, config).week1Start,
              windowForIndex(assessment.fortnightIndex, config).end,
              config.accountingTimezone
          )
        : "this fortnight";

    // A modal is the reply and cannot follow a defer, so the checks above are
    // the only thing allowed to touch this interaction first.
    await interaction.showModal(appealModal(warningId, label));
}

export async function handleAppealModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const warningId = interaction.customId.slice(`${APPEAL_MODAL}:`.length);
    const text = interaction.fields.getTextInputValue(FIELD_APPEAL).trim();

    // Checked again. The modal can sit open for as long as anybody likes, and
    // the window can close or the warning be withdrawn while it does.
    const resolved = await resolveAppeal(interaction, config, warningId);
    if (!resolved.ok) {
        await respond(interaction, resolved.card);
        return;
    }

    await fileAppeal(resolved.warning._id, text);
    await audit("warning.appeal", {
        actorId: interaction.user.id,
        targetStaffId: resolved.staff._id,
        detail: { warningId: resolved.warning._id.toHexString(), text }
    });

    // The row is the only notification. It turns amber and the header counts
    // it, which is where an Executive working the queue is already looking.
    const assessment = await findAssessment(resolved.warning.assessmentId);
    if (assessment) {
        try {
            await upsertReviewRow(
                client,
                config,
                assessment,
                assessment.fortnightIndex,
                assessment.rehearsal === true
            );
        } catch (error) {
            // The appeal is filed either way. A card that could not be redrawn
            // is a card that is out of date, not an appeal that did not happen.
            log.error("Could not redraw the review row after an appeal", error);
        }
    }

    await respond(
        interaction,
        noticeCard(
            "Appeal filed",
            "Your Executives can see it on the record beside the warning, and will decide " +
                "again.\n\nThey may uphold it, which deletes the warning, or leave it standing " +
                "and tell you why. Either way you will hear back here.",
            { colour: COLOUR.settled }
        )
    );
}


/**
 * The Executive's answer, when the warning stands.
 *
 * The appeal is marked decided, the outcome is untouched, and the member is
 * told why — they asked a question and the silence would be its own answer.
 * Upholding an appeal does not come through here: that is reopen, which deletes
 * the warning and writes its own audit row, and remains the only path in this
 * codebase that removes one.
 */
export async function handleAppealDeclineModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const warningId = interaction.customId.slice(`${APPEAL_DECLINE_MODAL}:`.length);
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();

    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Deciding an appeal is Executive only."));
        return;
    }

    if (!ObjectId.isValid(warningId)) return;
    const warning = await findWarningById(new ObjectId(warningId));

    // Re-checked, because a modal can sit open while somebody else answers it
    // or reopens the row out from under it.
    if (!warning?.appeal || warning.appeal.decidedAt) {
        await respond(
            interaction,
            noticeCard(
                "Already answered",
                "Somebody got to this one first, or the warning has been withdrawn.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    await defer(interaction, true);
    const actor = await ensureStaff(interaction.user.id);
    await declineAppeal(warning._id, actor._id, reason);

    await audit("warning.appeal.declined", {
        actorId: interaction.user.id,
        targetStaffId: warning.staffId,
        detail: { warningId: warning._id.toHexString(), reason }
    });

    const subject = await findStaffById(warning.staffId);
    const told = subject
        ? await tryDm(client, subject.discordId, {
              ...noticeCard(
                  "Your appeal has been decided",
                  "The warning stands.\n\n" +
                      `**Why:** ${reason}\n\n` +
                      "It expires on its own in time, and you can still raise it with the " +
                      "Executive team if you want to take it further.",
                  { colour: COLOUR.pending }
              )
          })
        : false;

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

    await respond(
        interaction,
        noticeCard(
            "Appeal declined",
            `The warning stands and the row is settled again.\n\n**Why:** ${reason}\n\n` +
                (told
                    ? "They have been told."
                    : "⚠️ They could not be told: their direct messages are closed."),
            { colour: COLOUR.settled, ephemeral: true }
        )
    );
}
