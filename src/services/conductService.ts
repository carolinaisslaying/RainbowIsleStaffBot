import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { ConductTier, StaffDoc, WarningDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { collections } from "../db/client.js";
import { deliveryState, lifetimeDaysFor } from "../domain/review.js";
import { findStaffById } from "../domain/staff.js";
import { recordWarningDelivery } from "../domain/assessments.js";
import { staffChannel } from "./leaveService.js";
import {
    conductWarnDmCard,
    warningLogCard,
    type RenderedMessage
} from "../render/cards.js";
import { tierConsequenceLine } from "../render/tiers.js";
import { sendOptions } from "../discord/respond.js";
import { tryDm } from "../discord/roles.js";
import { staffDisplayName } from "../discord/displayName.js";
import { log } from "../log.js";

/**
 * Warnings that are not about attendance, and the log every warning lives in.
 *
 * The bot still issues nothing by itself. An Executive decides and writes why;
 * this records it, tells the member, and draws the card.
 */

/** Write the record. Delivery is recorded separately, once it is known. */
export async function issueConductWarning(options: {
    subjectStaffId: ObjectId;
    issuedBy: ObjectId;
    tier: ConductTier;
    note: string;
    at?: Date;
}): Promise<WarningDoc> {
    const now = options.at ?? new Date();
    const warning: WarningDoc = {
        _id: new ObjectId(),
        staffId: options.subjectStaffId,
        kind: "conduct",
        // A conduct warning belongs to no fortnight. Every path that reads this
        // guards for null instead of assuming a fortnight exists.
        assessmentId: null,
        tier: options.tier,
        issuedBy: options.issuedBy,
        issuedAt: now,
        note: options.note,
        acknowledgedAt: null,
        deliveredAt: null,
        deliveryFailedAt: null,
        appeal: null,
        withdrawnAt: null,
        withdrawnBy: null,
        withdrawalReason: null,
        logChannelId: null,
        logMessageId: null
    };
    await collections.warnings().insertOne(warning);
    return warning;
}

/** Tell them. Returns whether it arrived, which the card then reports. */
export async function deliverConductWarning(
    client: Client,
    config: StaffBotConfig,
    warning: WarningDoc,
    subject: StaffDoc
): Promise<boolean> {
    const tier = warning.tier as ConductTier;
    const issuer = await findStaffById(warning.issuedBy);
    const delivered = await tryDm(client, subject.discordId, {
        ...conductWarnDmCard({
            warningId: warning._id.toHexString(),
            tier,
            // Named. "You have been issued a warning" hides the fact that a
            // person decided this, and the member is owed that name.
            issuedBy: issuer ? `<@${issuer.discordId}>` : "An Executive",
            consequence: tierConsequenceLine(lifetimeDaysFor(warning, config)),
            reason: warning.note,
            appealWindowDays: config.appealWindowDays,
            // The appeal window runs from delivery, so a warning that never
            // arrived has no live window and the button would only refuse.
            appealable: true
        })
    });

    await recordWarningDelivery(warning._id, delivered);
    return delivered;
}

/**
 * Draw a warning's card, wherever it is being drawn.
 *
 * The only thing that renders one, so the record and the card cannot disagree.
 * Same reason `leaveCardFor` and `reviewRowFor` exist.
 */
export async function warningCardFor(
    client: Client,
    config: StaffBotConfig,
    warning: WarningDoc
): Promise<RenderedMessage> {
    const subject = await findStaffById(warning.staffId);
    const issuer = await findStaffById(warning.issuedBy);
    const withdrawnBy = warning.withdrawnBy
        ? await findStaffById(warning.withdrawnBy)
        : null;

    const lifetimeDays = lifetimeDaysFor(warning, config);

    return warningLogCard({
        warningId: warning._id.toHexString(),
        displayName: subject
            ? await staffDisplayName(client, config, subject.discordId, "A departed member")
            : "An unknown member",
        mention: subject ? `<@${subject.discordId}>` : "unknown",
        kind: warning.kind === "conduct" ? "conduct" : "activity",
        tier: warning.tier ?? null,
        issuedAt: warning.issuedAt,
        issuedBy: issuer ? `<@${issuer.discordId}>` : "an Executive who has since left",
        reason: warning.note,
        permanent: lifetimeDays <= 0,
        lifetimeDays,
        acknowledgedAt: warning.acknowledgedAt,
        delivery: deliveryState(warning) === "failed"
            ? "failed"
            : warning.deliveredAt
              ? "delivered"
              : "unknown",
        appeal:
            warning.appeal && !warning.appeal.decidedAt
                ? { text: warning.appeal.text, filedAt: warning.appeal.filedAt }
                : null,
        withdrawn: warning.withdrawnAt
            ? {
                  at: warning.withdrawnAt,
                  by: withdrawnBy
                      ? `<@${withdrawnBy.discordId}>`
                      : "an Executive who has since left",
                  reason: warning.withdrawalReason ?? ""
              }
            : null
    });
}

/**
 * Post or refresh a warning's card in the log.
 *
 * Converges instead of appending. A card that exists gets edited; one that has
 * gone gets reposted and its location updated. One warning keeps one card for
 * its whole life, from issued through acknowledged, appealed and withdrawn.
 *
 * Does nothing when no channel is configured. The warning still issues and
 * still counts, and only the channel copy goes missing, which is how
 * `recapChannelId` already behaves.
 */
export async function upsertWarningCard(
    client: Client,
    config: StaffBotConfig,
    warningId: ObjectId
): Promise<void> {
    const warning = await collections.warnings().findOne({ _id: warningId });
    if (!warning) return;

    // A rehearsal's warning was never real, and this channel is where people
    // look to find out what has been issued.
    if (warning.rehearsal) return;

    const channel = await staffChannel(client, config, config.warningChannelId);
    if (!channel) return;

    const card = await warningCardFor(client, config, warning);

    if (warning.logChannelId && warning.logMessageId) {
        try {
            const target = await client.channels.fetch(warning.logChannelId);
            if (target?.isTextBased()) {
                const message = await target.messages.fetch(warning.logMessageId);
                await message.edit(sendOptions(card) as never);
                return;
            }
        } catch {
            // Deleted by hand, or the channel moved. Fall through and repost.
        }
    }

    try {
        const posted = await channel.send(sendOptions(card));
        await collections
            .warnings()
            .updateOne(
                { _id: warningId },
                { $set: { logChannelId: posted.channelId, logMessageId: posted.id } }
            );
    } catch (error) {
        // The warning is issued either way. Losing the card loses the card.
        log.error(`Could not post the warning card for ${warningId.toHexString()}`, error);
    }
}
