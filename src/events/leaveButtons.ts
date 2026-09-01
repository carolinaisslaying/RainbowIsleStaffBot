import { MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { decideLeave, findLeave } from "../domain/leave.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { tryDm } from "../discord/roles.js";
import { staffDisplayName } from "../discord/displayName.js";
import {
    activateLeave,
    endLeave,
    leaveCardFor,
    rememberLeaveCard
} from "../services/leaveService.js";
import { errorCard, leaveEndConfirmCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { audit } from "../domain/audit.js";
import { ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";

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

        await interaction.deferUpdate();
        const executive = await ensureStaff(interaction.user.id);
        await endLeave(client, config, leave, {
            kind: "executive",
            discordId: interaction.user.id,
            staffId: executive._id
        });

        await interaction.editReply(
            sendOptions(
                noticeCard(
                    leave.status === "active" ? "They are back" : "Leave cancelled",
                    (leave.status === "active"
                        ? "Their ranks are restored and they have been told they are back."
                        : "The leave will not start. Their ranks were never set aside.") +
                        "\n\nThe request card in this channel now shows the outcome.",
                    { colour: COLOUR.approved }
                )
            ) as never
        );
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
                          `${leave.endDate ? ts(leave.endDate, "f") : "an open ended return"} ` +
                          "has been approved.\n\nYour ranks go aside when it starts and come " +
                          "back on their own when it ends. No fortnight assessment applies to " +
                          "you while away, and your streak freezes where it stands."
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

    // The card this button sits on is the one just edited. Records created
    // before the location was stored learn it here, so a later end can still
    // find the card and take it to its final state, whether that end comes from
    // the scheduler, from `/leave end`, or from the button above.
    if (!current.logMessageId) {
        await rememberLeaveCard(leaveId, interaction.channelId, interaction.message.id);
    }
}
