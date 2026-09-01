import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import type { ButtonInteraction, Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { collections } from "../db/client.js";
import { findLeave, purgeLeaveRecord } from "../domain/leave.js";
import { exemptionsLostByPurging, holdsUnrestoredRoles } from "../domain/leavePurge.js";
import { findStaffById } from "../domain/staff.js";
import { fetchPublicMember, isExecutive, resolveTier } from "../domain/permissions.js";
import { errorCard, noticeCard, purgeConfirmCard } from "../render/cards.js";
import { leaveCardFor } from "../services/leaveService.js";
import { respond, sendOptions } from "../discord/respond.js";
import { ts } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * Purging one leave record.
 *
 * This is the only thing in the bot that destroys anything, so it is built to
 * be hard to do by accident and impossible to do quietly:
 *
 *  - Executive only, checked again on the second click rather than trusted from
 *    the first;
 *  - refused outright while the member is away and holding roles the record is
 *    the only description of;
 *  - the fortnights that lose their exemption are named before the click, not
 *    discovered weeks later in a recompute;
 *  - the audit row is written before the delete and its failure aborts the
 *    purge, so there is no path that removes a record without a trace of who
 *    removed it and what it said.
 *
 * The log card is then edited in place. The channel keeps its record of the
 * request and the decision, and gains a line saying the record behind it is
 * gone. A purged card carries no buttons: there is nothing left to act on.
 */

/** How long a confirmation stays clickable. */
const TTL_MS = 5 * 60_000;

interface PendingPurge {
    leaveId: ObjectId;
    executiveId: string;
    /** The log card to edit once the record is gone. */
    channelId: string;
    messageId: string;
    expiresAt: number;
}

const pending = new Map<string, PendingPurge>();

function sweep(): void {
    const now = Date.now();
    for (const [token, entry] of pending) {
        if (entry.expiresAt <= now) pending.delete(token);
    }
}

export async function handleLeavePurgeButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    reference: string,
    action: string
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Purging a leave record is Executive only."));
        return;
    }

    if (action === "ask") {
        await askForConfirmation(interaction, config, reference);
        return;
    }

    sweep();
    const entry = pending.get(reference);
    if (!entry) {
        // The buttons are dead, so the card holding them is replaced rather
        // than answered beside: a live-looking button that can only fail again
        // is worse than no button.
        await interaction.update(
            sendOptions(
                noticeCard(
                    "That confirmation expired",
                    "Nothing was removed. Press **Purge this record** on the log card again.",
                    { colour: COLOUR.settled }
                )
            ) as never
        );
        return;
    }

    if (entry.executiveId !== interaction.user.id) {
        await respond(interaction, errorCard("That confirmation is not yours."));
        return;
    }

    if (action === "cancel") {
        pending.delete(reference);
        await interaction.update(
            sendOptions(
                noticeCard("Left alone", "Nothing was removed.", { colour: COLOUR.settled })
            ) as never
        );
        return;
    }

    if (action !== "go") return;
    pending.delete(reference);
    await purge(client, config, interaction, entry);
}

async function askForConfirmation(
    interaction: ButtonInteraction,
    config: StaffBotConfig,
    leaveIdHex: string
): Promise<void> {
    const leave = await findLeave(new ObjectId(leaveIdHex));
    if (!leave) {
        // Purged from elsewhere while this card sat in the channel. Correct the
        // card rather than leaving a button that can only ever fail.
        await interaction.update(sendOptions(alreadyGoneCard()) as never);
        return;
    }

    if (holdsUnrestoredRoles(leave)) {
        const subject = await findStaffById(leave.staffId);
        await respond(
            interaction,
            errorCard(
                `That member is on leave right now, and this record holds the only list of ` +
                    `the **${leave.removedRoles.length}** role` +
                    `${leave.removedRoles.length === 1 ? "" : "s"} the bot set aside for them. ` +
                    "Purging it would leave them stripped with nothing saying what to give " +
                    `back.\n\nEnd the leave first with ${cmd("leave end", interaction.guildId)}, ` +
                    `or wait for it to close on ${leave.endDate ? ts(leave.endDate, "D") : "its own"}. ` +
                    `Purge it after that.` +
                    (subject ? `\n\n-# Member: <@${subject.discordId}>` : "")
            )
        );
        return;
    }

    const [subject, exemptions] = await Promise.all([
        findStaffById(leave.staffId),
        exemptionsLostByPurging(leave, config)
    ]);

    sweep();
    const token = randomBytes(8).toString("hex");
    pending.set(token, {
        leaveId: leave._id,
        executiveId: interaction.user.id,
        channelId: interaction.channelId,
        messageId: interaction.message.id,
        expiresAt: Date.now() + TTL_MS
    });

    await respond(
        interaction,
        purgeConfirmCard({
            leaveId: token,
            displayName: subject ? `<@${subject.discordId}>` : "an unknown member",
            startDate: leave.startDate,
            endDate: leave.endDate,
            status: leave.status,
            exemptions: exemptions.map(
                (lost) =>
                    `Fortnight ${lost.index}, ${ts(lost.windowStart, "D")} to ` +
                    `${ts(lost.windowEnd, "D")}`
            )
        })
    );
}

function alreadyGoneCard() {
    return noticeCard(
        "Already purged",
        "That leave record is no longer in the database.",
        { colour: COLOUR.settled }
    );
}

async function purge(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    entry: PendingPurge
): Promise<void> {
    await interaction.deferUpdate();

    const leave = await findLeave(entry.leaveId);
    if (!leave) {
        await interaction.editReply(sendOptions(alreadyGoneCard()) as never);
        return;
    }

    // Re-checked on the second click. The state can change while a confirmation
    // sits unread, and this is the one guard with no way back if it is wrong.
    if (holdsUnrestoredRoles(leave)) {
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "That leave became active while this confirmation was open, and it now " +
                        "holds roles that have not been given back. Nothing was removed."
                )
            ) as never
        );
        return;
    }

    const subject = await findStaffById(leave.staffId);

    // Written before the delete, and deliberately not through audit(), which
    // swallows its own failures so that it can never take down the action it
    // records. Here that rule is backwards: a purge with no audit row is a
    // record destroyed with no trace, so a failure to write it stops the purge.
    try {
        await collections.auditLog().insertOne({
            _id: new ObjectId(),
            actorId: interaction.user.id,
            action: "leave.purge",
            targetStaffId: leave.staffId,
            // The whole record, so the audit log is the way back from a mistake.
            detail: {
                leaveId: leave._id.toHexString(),
                purged: {
                    staffId: leave.staffId.toHexString(),
                    requestedAt: leave.requestedAt,
                    startDate: leave.startDate,
                    endDate: leave.endDate,
                    reason: leave.reason,
                    status: leave.status,
                    decidedBy: leave.decidedBy?.toHexString() ?? null,
                    decidedAt: leave.decidedAt,
                    removedRoles: leave.removedRoles,
                    rolesRestoredAt: leave.rolesRestoredAt,
                    restoreErrors: leave.restoreErrors
                }
            },
            at: new Date()
        });
    } catch (error) {
        log.error("Refusing to purge leave: the audit row could not be written", error);
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "The audit entry could not be written, so nothing was removed. A purge " +
                        "that leaves no record of itself is not one this bot will make. The " +
                        "error is in the logs."
                )
            ) as never
        );
        return;
    }

    const removed = await purgeLeaveRecord(leave._id);
    if (!removed) {
        await interaction.editReply(sendOptions(alreadyGoneCard()) as never);
        return;
    }

    await editLogCard(client, config, entry, leave, interaction.user.id);

    const exemptionNote =
        leave.status === "ended" || leave.status === "active"
            ? `\n\nIf that leave was exempting an assessment, run ` +
              `${cmd("admin recompute", interaction.guildId)} so the affected fortnights are ` +
              "reassessed now rather than at the next sweep."
            : "";

    await interaction.editReply(
        sendOptions(
            noticeCard(
                "Purged",
                `The leave record is gone from the database.\n\nThe audit log holds what it ` +
                    `said, including the reason given, and is the only way back.${exemptionNote}`,
                { colour: COLOUR.settled }
            )
        ) as never
    );
}

/** Rewrite the card in the log channel so the record does not go quiet. */
async function editLogCard(
    client: Client,
    config: StaffBotConfig,
    entry: PendingPurge,
    leave: Awaited<ReturnType<typeof findLeave>>,
    executiveId: string
): Promise<void> {
    if (!leave) return;
    try {
        const channel = await client.channels.fetch(entry.channelId);
        if (!channel || !channel.isTextBased()) return;
        const message = await channel.messages.fetch(entry.messageId);

        await message.edit(
            sendOptions(
                await leaveCardFor(client, config, leave, {
                    purged: `Purged by <@${executiveId}> ${ts(new Date(), "R")}.`
                })
            ) as never
        );
    } catch (error) {
        // The record is already gone; failing to annotate the card must not
        // turn a completed purge into an error the executive has to interpret.
        log.warn("Purged a leave record but could not edit its log card", error);
    }
}
