import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ComponentType } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { collections } from "../db/client.js";
import { TIER_STYLE } from "../render/tiers.js";
import { conductWarningPermitted, isConductTier } from "../domain/conduct.js";
import { lifetimeDaysFor } from "../domain/review.js";
import { withdrawWarning } from "../domain/assessments.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, isExecutive, resolveTier } from "../domain/permissions.js";
import { audit } from "../domain/audit.js";
import { tryDm } from "../discord/roles.js";
import {
    deliverConductWarning,
    issueConductWarning,
    upsertWarningCard
} from "../services/conductService.js";
import { errorCard, noticeCard } from "../render/cards.js";
import {
    CONDUCT_WITHDRAW_MODAL,
    FIELD_REASON,
    FIELD_TIER,
    conductWithdrawModal
} from "../render/modals.js";
import { defer, respond } from "../discord/respond.js";
import { staffDisplayName } from "../discord/displayName.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * Issuing a conduct warning, and taking one back.
 *
 * The command checks and opens the modal; every write happens here, which is the
 * same split every review outcome already follows because `showModal` cannot
 * follow a defer.
 *
 * The eligibility rules are re-derived on submission rather than carried from
 * the command. A modal can sit open for as long as anybody likes, and the
 * subject can be promoted, demoted or leave the team while it does.
 */

export async function handleConductWarnModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction,
    subjectDiscordId: string
): Promise<void> {
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
    const rawTier = interaction.fields.getField(FIELD_TIER, ComponentType.RadioGroup).value;

    if (!isConductTier(rawTier)) {
        await respond(interaction, errorCard("Pick how serious the warning is."));
        return;
    }

    const issuerMember = await fetchPublicMember(client, config, interaction.user.id);
    const issuerTier = resolveTier(interaction.user.id, issuerMember, config);
    const issuer = await ensureStaff(interaction.user.id);

    const subjectMember = await fetchPublicMember(client, config, subjectDiscordId);
    const subjectTier = resolveTier(subjectDiscordId, subjectMember, config);
    const subject = await ensureStaff(subjectDiscordId);

    const permitted = conductWarningPermitted({
        issuerTier,
        subjectTier,
        issuerStaffId: issuer._id,
        subjectStaffId: subject._id,
        subjectDeparted: subject.active === false || subjectMember === null
    });
    if (!permitted.ok) {
        await respond(interaction, errorCard(permitted.reason));
        return;
    }

    await defer(interaction, true);

    const warning = await issueConductWarning({
        subjectStaffId: subject._id,
        issuedBy: issuer._id,
        tier: rawTier,
        note: reason
    });

    await audit("warning.conduct.issued", {
        actorId: interaction.user.id,
        targetStaffId: subject._id,
        detail: {
            warningId: warning._id.toHexString(),
            tier: rawTier,
            reason
        }
    });

    const delivered = await deliverConductWarning(client, config, warning, subject);
    await upsertWarningCard(client, config, warning._id);

    const days = lifetimeDaysFor(warning, config);
    const name = await staffDisplayName(
        client,
        config,
        subjectDiscordId,
        "That member"
    );

    await respond(
        interaction,
        noticeCard(
            `${TIER_STYLE[rawTier].emoji} ${TIER_STYLE[rawTier].label} issued`,
            `**${name}** (<@${subjectDiscordId}>)\n\n` +
                `**Why:** ${reason}\n\n` +
                (days <= 0
                    ? "It never stops counting against them."
                    : `It counts against them for ${days} days.`) +
                "\n\n" +
                (delivered
                    ? "They have the message and can appeal it."
                    : "⚠️ **Their direct messages are closed, so they did not get it.** The " +
                      "warning stands on their record. Their appeal window stays shut until " +
                      "something reaches them, so tell them yourself.") +
                (config.warningChannelId ? "" : "\n\n-# No warning channel is configured, so " +
                    "there is no card for this in the log."),
            { colour: delivered ? COLOUR.pending : COLOUR.adverse, ephemeral: true }
        )
    );
}

/** The Withdraw button on a warning's card in the log. */
export async function handleConductButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    warningId: string,
    action: string
): Promise<void> {
    if (action !== "withdraw") return;

    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Withdrawing a warning is Executive only."));
        return;
    }

    if (!ObjectId.isValid(warningId)) return;
    const warning = await collections.warnings().findOne({ _id: new ObjectId(warningId) });

    if (!warning || warning.withdrawnAt) {
        await respond(
            interaction,
            noticeCard(
                "Already withdrawn",
                "Another Executive withdrew it. Its card shows where it stands.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    const subject = await findStaffById(warning.staffId);
    await interaction.showModal(
        conductWithdrawModal(
            warningId,
            subject
                ? await staffDisplayName(client, config, subject.discordId, "The member")
                : "The member"
        )
    );
}

export async function handleConductWithdrawModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const warningId = interaction.customId.slice(`${CONDUCT_WITHDRAW_MODAL}:`.length);
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();

    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Withdrawing a warning is Executive only."));
        return;
    }

    if (!ObjectId.isValid(warningId)) return;
    await defer(interaction, true);

    const actor = await ensureStaff(interaction.user.id);

    // Re-checked, and the write itself refuses an already-withdrawn record, so
    // two Executives clicking at once cannot overwrite one reason with another.
    const withdrawn = await withdrawWarning(new ObjectId(warningId), actor._id, reason);
    if (!withdrawn) {
        await respond(
            interaction,
            noticeCard(
                "Already withdrawn",
                "Another Executive withdrew it first, and their reason is the one on record.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    const warning = await collections.warnings().findOne({ _id: new ObjectId(warningId) });
    if (!warning) return;

    await audit("warning.withdrawn", {
        actorId: interaction.user.id,
        targetStaffId: warning.staffId,
        detail: { warningId, reason, kind: warning.kind ?? "activity" }
    });

    const subject = await findStaffById(warning.staffId);
    const told = subject
        ? await tryDm(client, subject.discordId, {
              ...noticeCard(
                  "An Executive has withdrawn a warning against you",
                  "It no longer counts against you.\n\n" +
                      `**Why:** ${reason}\n\n` +
                      "-# Your record still lists it, marked withdrawn, so it shows what " +
                      "happened instead of a gap.",
                  { colour: COLOUR.settled }
              )
          })
        : false;

    await upsertWarningCard(client, config, warning._id);

    await respond(
        interaction,
        noticeCard(
            "Withdrawn",
            `It no longer counts against them.\n\n**Why:** ${reason}\n\n` +
                "-# Their record keeps both reasons, yours and the one it was issued for.\n\n" +
                (told
                    ? "They have the message."
                    : "⚠️ Their direct messages are closed, so they did not get the message."),
            { colour: COLOUR.settled, ephemeral: true }
        )
    );

    log.info(`Warning ${warningId} withdrawn by ${interaction.user.id}`);
}
