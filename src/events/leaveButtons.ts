import { MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { decideLeave, findLeave } from "../domain/leave.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { tryDm } from "../discord/roles.js";
import { activateLeave } from "../services/leaveService.js";
import { errorCard, leaveRequestCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { audit } from "../domain/audit.js";
import { ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";

/** Executive only may decide leave. */
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
    // the next boundary sweep.
    if (approved && decided.startDate <= new Date()) {
        await activateLeave(client, config, decided);
    }

    // The log card keeps every detail it had and swaps its buttons for the
    // decision, so the channel reads as a record rather than as a stub.
    const card = leaveRequestCard({
        leaveId: leaveId.toHexString(),
        displayName: `<@${subject?.discordId ?? "unknown"}>`,
        startDate: leave.startDate,
        endDate: leave.endDate,
        reason: leave.reason,
        decided:
            `**${approved ? "Approved" : "Declined"}** by <@${interaction.user.id}> ` +
            `${ts(new Date(), "R")}`
    });

    await interaction.editReply(sendOptions(card) as never);
}
