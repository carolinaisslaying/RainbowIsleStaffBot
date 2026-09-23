import {
    MessageFlags,
    type ButtonInteraction,
    type Client,
    type ModalSubmitInteraction
} from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { decideExtension, decideLeave, findLeave } from "../domain/leave.js";
import type { LeaveDoc } from "../db/types.js";
import { reassessAfterLeaveChange } from "../services/leaveReassess.js";
import { pingKey, resolvePing } from "../services/pings.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { tryDm } from "../discord/roles.js";
import { staffDisplayName } from "../discord/displayName.js";
import {
    activateLeave,
    cancelLeave,
    endLeave,
    leaveCardFor,
    rememberLeaveCard
} from "../services/leaveService.js";
import { errorCard, leaveEndConfirmCard, noticeCard } from "../render/cards.js";
import { deferOntoOwnCard, respond, sendOptions } from "../discord/respond.js";
import { FIELD_REASON, leaveEndModal } from "../render/modals.js";
import { audit } from "../domain/audit.js";
import { ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";
import { leaveTermsText } from "../render/leaveTerms.js";

/**
 * Every button on a leave card. Executive only, all of them.
 *
 * The card walks one record from "pending" to "back" without ever posting a
 * second message: a decision replaces the decision buttons, an active leave
 * offers the one action left on it, and each state re-renders through
 * `leaveCardFor` so the colour and the buttons cannot disagree with the record.
 */
export async function handleLeaveButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    leaveId: ObjectId,
    action: string
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Leave decisions are Executive only."));
        return;
    }

    const leave = await findLeave(leaveId);
    if (!leave) {
        await respond(interaction, errorCard("That leave request no longer exists."));
        return;
    }

    if (action === "endCancel") {
        await interaction.update(
            sendOptions(
                noticeCard("Left running", "Nothing changed. The leave is still in force.", {
                    colour: COLOUR.settled
                })
            ) as never
        );
        return;
    }

    if (action === "end") {
        // Ask before acting. Ending someone's leave restores their ranks,
        // restarts assessment and tells them they are back, all at once and all
        // to somebody who is not in the room.
        if (leave.status !== "active" && leave.status !== "approved") {
            await respond(
                interaction,
                errorCard(`That leave is **${leave.status}**, so there is nothing to end.`)
            );
            return;
        }
        const subject = await findStaffById(leave.staffId);
        await respond(
            interaction,
            leaveEndConfirmCard({
                leaveId: leaveId.toHexString(),
                displayName: subject
                    ? `**${await staffDisplayName(
                          client,
                          config,
                          subject.discordId,
                          "This member"
                      )}** (<@${subject.discordId}>)`
                    : "This member",
                endDate: leave.endDate,
                active: leave.status === "active"
            })
        );
        return;
    }

    if (action === "endConfirm") {
        // Re-checked on the second click rather than trusted from the first:
        // the state can have moved between the two, and the confirmation card
        // is ephemeral and can be sat on for as long as anyone likes.
        if (leave.status !== "active" && leave.status !== "approved") {
            await interaction.update(
                sendOptions(
                    errorCard(`That leave is already **${leave.status}**. Nothing was changed.`)
                ) as never
            );
            return;
        }

        // Both ask why, because the member is told the reason. A modal cannot
        // follow a defer, so this is all the button does; the write happens
        // when the reason comes back.
        const subject = await findStaffById(leave.staffId);
        await interaction.showModal(
            leaveEndModal(
                leaveId.toHexString(),
                subject
                    ? await staffDisplayName(client, config, subject.discordId, "This member")
                    : "This member",
                leave.status === "approved" ? "cancel" : "return"
            )
        );
        return;
    }

    if (action === "extApprove" || action === "extDecline") {
        await decideExtensionFromCard(client, config, interaction, leave, action === "extApprove");
        return;
    }

    if (action !== "approve" && action !== "decline") return;

    if (leave.status !== "pending") {
        await respond(interaction, errorCard(`That request is already **${leave.status}**.`));
        return;
    }

    // Everything above this line could still refuse, and a refusal wants its own
    // ephemeral reply. From here the decision is going through, so the button
    // press is acknowledged as an edit to the card it sits on. Without this,
    // activating leave and sending DMs takes longer than the three seconds
    // Discord allows an un-acknowledged interaction, the token expires, and the
    // card stays showing Approve and Decline for a request that was decided.
    await interaction.deferUpdate();

    const decider = await ensureStaff(interaction.user.id);
    const approved = action === "approve";
    const decided = await decideLeave(leaveId, approved, decider._id);
    if (!decided) {
        await interaction.followUp({
            ...sendOptions(errorCard("Someone else decided that request first.")),
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        } as never);
        return;
    }

    const subject = await findStaffById(leave.staffId);

    await audit(approved ? "leave.approve" : "leave.decline", {
        actorId: interaction.user.id,
        targetStaffId: leave.staffId,
        detail: { leaveId: leaveId.toHexString() }
    });

    if (subject) {
        await tryDm(client, subject.discordId, {
            ...noticeCard(
                approved ? "Leave approved" : "Leave declined",
                approved
                    ? `Your leave from ${ts(leave.startDate, "f")} to ` +
                          `${ts(leave.endDate, "f")} has been approved.\n\n` +
                          leaveTermsText(config.minimumLeaveDays)
                    : "An Executive declined your leave request. Speak to them if you want to " +
                          "discuss it.",
                { colour: approved ? COLOUR.approved : COLOUR.adverse }
            )
        });
    }

    // Start date already passed: activate immediately rather than waiting for
    // the next boundary sweep. Re-read afterwards so the card is drawn from
    // what the record now says rather than from what it said a moment ago.
    if (approved && decided.startDate <= new Date()) {
        await activateLeave(client, config, decided);
    }

    const current = (await findLeave(leaveId)) ?? decided;

    await interaction.editReply(sendOptions(await leaveCardFor(client, config, current)) as never);
    await resolvePing(client, pingKey.leave(leaveId));

    // A request still pending when a fortnight it touches closed holds that
    // fortnight's row. Deciding it, either way, settles the row.
    await reassessAfterLeaveChange(
        client,
        config,
        leave.staffId,
        [{ startDate: leave.startDate, endDate: leave.endDate }],
        approved ? "leave approved" : "leave declined"
    );

    // The card this button sits on is the one just edited. Records created
    // before the location was stored learn it here, so a later end can still
    // find the card and take it to its final state, whether that end comes from
    // the scheduler, from `/leave end`, or from the button above.
    if (!current.logMessageId) {
        await rememberLeaveCard(leaveId, interaction.channelId, interaction.message.id);
    }
}

/**
 * Approve or decline an extension from the leave card.
 *
 * The card this sits on is edited in place, as every leave decision is, and the
 * member hears either way: a declined extension means their return date has
 * not moved, which they need to know before the day arrives.
 */
async function decideExtensionFromCard(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    leave: LeaveDoc,
    approved: boolean
): Promise<void> {
    const extension = leave.pendingExtension;
    if (!extension) {
        await respond(interaction, errorCard("There is no extension waiting on that leave."));
        return;
    }

    await interaction.deferUpdate();
    const decider = await ensureStaff(interaction.user.id);
    const decided = await decideExtension(leave, approved, decider._id);
    if (!decided) {
        await interaction.followUp({
            ...sendOptions(errorCard("Someone else decided that extension first.")),
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
        } as never);
        return;
    }

    await audit(approved ? "leave.extensionApproved" : "leave.extensionDeclined", {
        actorId: interaction.user.id,
        targetStaffId: leave.staffId,
        detail: {
            leaveId: leave._id.toHexString(),
            from: leave.endDate,
            to: extension.endDate,
            requestedAt: extension.requestedAt,
            reason: extension.reason
        }
    });

    const subject = await findStaffById(leave.staffId);
    if (subject) {
        await tryDm(client, subject.discordId, {
            ...noticeCard(
                approved ? "Extension approved" : "Extension declined",
                approved
                    ? `You are now due back ${ts(extension.endDate, "f")}, ` +
                          `${ts(extension.endDate, "R")}. Your leave closes itself then and your ` +
                          "staff roles come back."
                    : `An Executive declined your extension. You are still due back ` +
                          `${ts(leave.endDate, "f")}, ${ts(leave.endDate, "R")}. Speak to them ` +
                          "if you want to discuss it.",
                { colour: approved ? COLOUR.approved : COLOUR.adverse }
            )
        });
    }

    await interaction.editReply(sendOptions(await leaveCardFor(client, config, decided)) as never);
    await resolvePing(client, pingKey.extension(leave._id));

    await reassessAfterLeaveChange(
        client,
        config,
        leave.staffId,
        [{ startDate: leave.endDate, endDate: extension.endDate }],
        approved ? "leave extension approved" : "leave extension declined"
    );
}

/**
 * The reason an Executive gave for cancelling approved leave or bringing
 * somebody back early, and the change itself.
 *
 * Everything is re-derived here rather than carried from the button: the form
 * can sit open while the sweep activates the leave or another Executive acts
 * on it. Leave opened as a cancellation that started in the meantime is ended
 * instead, because by then there are roles to give back, and the reply says so.
 */
export async function handleLeaveEndModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Leave decisions are Executive only."));
        return;
    }

    const [, id, mode] = interaction.customId.split(":");
    if (!ObjectId.isValid(id)) return;
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();

    await deferOntoOwnCard(interaction);
    const leave = await findLeave(new ObjectId(id));
    if (!leave) {
        await respond(interaction, errorCard("That leave request no longer exists."));
        return;
    }

    const executive = await ensureStaff(interaction.user.id);
    const by = { discordId: interaction.user.id, staffId: executive._id };

    const cancelled =
        leave.status === "approved" && (await cancelLeave(client, config, leave, by, reason));
    if (cancelled) {
        await respond(
            interaction,
            noticeCard(
                "Leave cancelled",
                "The leave will not start. Their staff roles were never removed, and they " +
                    `have been told it is off.\n\n**Why:** ${reason}\n\n` +
                    "The request card in this channel now shows the outcome.",
                { colour: COLOUR.settled }
            )
        );
        return;
    }

    const current = (await findLeave(leave._id)) ?? leave;
    if (current.status !== "active") {
        await respond(
            interaction,
            errorCard(`That leave is already **${current.status}**. Nothing was changed.`)
        );
        return;
    }
    await endLeave(client, config, current, { kind: "executive", ...by, reason });
    await respond(
        interaction,
        noticeCard(
            mode === "cancel" ? "It had already started" : "They are back",
            (mode === "cancel"
                ? "The leave began while you were writing, so it has been ended rather than " +
                  "cancelled: their staff roles are restored and they have been told they are " +
                  "back."
                : "Their staff roles are restored and they have been told they are back.") +
                `\n\n**Why:** ${reason}\n\nThe request card in this channel now shows the outcome.`,
            { colour: COLOUR.approved }
        )
    );
}
