import { randomBytes } from "node:crypto";
import type { ButtonInteraction, Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    createLeaveRequest,
    findLeave,
    pendingOrApprovedLeaveFor,
    requestExtension
} from "../domain/leave.js";
import { audit } from "../domain/audit.js";
import {
    leaveCardFor,
    rememberLeaveCard,
    staffChannel,
    updateLeaveCard
} from "../services/leaveService.js";
import { pingExecutives, pingKey } from "../services/pings.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { ts } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";

/**
 * The step between typing a date and being committed to it.
 *
 * Plain English input means the bot is interpreting rather than reading, and an
 * interpretation belongs in front of the member before it becomes a request an
 * Executive has to decide on. Nothing touches the database until the member
 * agrees with what the parser made of their words.
 *
 * The half-finished request waits here rather than in Mongo. It is worth
 * nothing until confirmed, it belongs to one member for the couple of minutes
 * they take to read a card, and a collection of abandoned drafts is a liability
 * nobody asked for. The cost is that a restart forgets them, which is why an
 * unknown token says so plainly instead of failing.
 */

export interface PendingLeave {
    kind: "request" | "extend";
    staffId: ObjectId;
    discordId: string;
    displayName: string;
    /** Extensions only: the leave being pushed out. */
    leaveId?: ObjectId;
    /** Requests only. */
    startDate?: Date;
    endDate: Date;
    reason: string;
    expiresAt: number;
}

/** Long enough to read a card and think, short enough not to be a store. */
const TTL_MS = 15 * 60_000;

const pending = new Map<string, PendingLeave>();

/** Drop anything expired. Called on every touch, so no timer is needed. */
function sweep(): void {
    const now = Date.now();
    for (const [token, draft] of pending) {
        if (draft.expiresAt <= now) pending.delete(token);
    }
}

export function stage(draft: Omit<PendingLeave, "expiresAt">): string {
    sweep();
    const token = randomBytes(8).toString("hex");
    pending.set(token, { ...draft, expiresAt: Date.now() + TTL_MS });
    return token;
}

/** Test seam: how many drafts are waiting. */
export function pendingCount(): number {
    sweep();
    return pending.size;
}

export async function handleLeaveConfirmButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    token: string,
    action: string
): Promise<void> {
    sweep();
    const draft = pending.get(token);

    // The buttons stop working when the draft goes, so the card they sit on is
    // replaced rather than answered beside. Leaving a live-looking card above a
    // refusal invites a second click that fails the same way.
    if (!draft) {
        await interaction.update(
            sendOptions(
                noticeCard(
                    "That form has expired",
                    `Nothing was recorded. Run ${cmd("leave request", interaction.guildId)} ` +
                        "again when you are ready.",
                    { colour: COLOUR.settled }
                )
            ) as never
        );
        return;
    }

    if (draft.discordId !== interaction.user.id) {
        await respond(interaction, errorCard("That form is not yours."));
        return;
    }

    if (action === "redo") {
        pending.delete(token);
        await interaction.update(
            sendOptions(
                noticeCard(
                    "Discarded",
                    "Nothing was recorded. Run " +
                        `${cmd(draft.kind === "extend" ? "leave extend" : "leave request", interaction.guildId)} ` +
                        "again and word the dates however you like.",
                    { colour: COLOUR.settled }
                )
            ) as never
        );
        return;
    }

    if (action !== "ok") return;
    pending.delete(token);

    // Acknowledged as an edit to the card that was clicked: posting to the log
    // channel and writing the audit row takes longer than the three seconds
    // Discord allows an unacknowledged interaction.
    await interaction.deferUpdate();

    if (draft.kind === "request") {
        await commitRequest(client, config, interaction, draft);
        return;
    }
    await commitExtension(client, config, interaction, draft);
}

async function commitRequest(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    draft: PendingLeave
): Promise<void> {
    // Re-checked at the last moment: a member can sit on the confirmation while
    // a second request of theirs lands, and two open requests is the one state
    // the rest of the leave code is not written to expect.
    const existing = await pendingOrApprovedLeaveFor(draft.staffId);
    if (existing.length > 0) {
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "You already have a leave request pending or approved. Use " +
                        `${cmd("leave extend", interaction.guildId)} to change its end date.`
                )
            ) as never
        );
        return;
    }

    const leave = await createLeaveRequest(
        draft.staffId,
        draft.startDate as Date,
        draft.endDate,
        draft.reason
    );

    const channel = await staffChannel(client, config, config.leaveChannelId);
    if (!channel) {
        // The request is on record either way, but nobody can act on it, so say
        // so rather than letting them wait for a decision nobody will ever see.
        log.warn("No leaveChannelId configured; the request has nowhere to post.");
    } else {
        const posted = await channel.send(sendOptions(await leaveCardFor(client, config, leave)));
        // Everything that happens to this leave later edits this one message,
        // so the record has to know where it is.
        await rememberLeaveCard(leave._id, posted.channelId, posted.id);
        await pingExecutives(
            client,
            config,
            pingKey.leave(leave._id),
            { channelId: posted.channelId, messageId: posted.id },
            `<@${draft.discordId}> has requested leave. Approve or decline it above.`
        );
    }

    await audit("leave.request", {
        actorId: draft.discordId,
        targetStaffId: draft.staffId,
        detail: {
            leaveId: leave._id.toHexString(),
            start: draft.startDate,
            end: draft.endDate
        }
    });

    await interaction.editReply(
        sendOptions(
            noticeCard(
                "Leave requested",
                `From ${ts(draft.startDate as Date, "f")} until ${ts(draft.endDate, "f")}.\n\n` +
                    "An Executive decides, and you hear back either way. Your staff roles stay as " +
                    "they are until the leave is approved and starts, and they come back on " +
                    "their own when it ends.\n\n" +
                    `-# Need longer once it has started? ${cmd("leave extend", interaction.guildId)}.`,
                { colour: COLOUR.leave }
            )
        ) as never
    );
}

async function commitExtension(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    draft: PendingLeave
): Promise<void> {
    const leave = await findLeave(draft.leaveId as ObjectId);
    if (!leave || (leave.status !== "approved" && leave.status !== "active")) {
        await interaction.editReply(
            sendOptions(
                errorCard("That leave can no longer be extended. It has ended or been withdrawn.")
            ) as never
        );
        return;
    }

    const updated = await requestExtension(leave._id, draft.endDate, draft.reason);
    if (!updated) {
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "That leave could not be extended. It may have ended, or an extension is " +
                        `already waiting on an Executive. Check ${cmd("leave list", interaction.guildId)}.`
                )
            ) as never
        );
        return;
    }

    await audit("leave.extensionRequested", {
        actorId: draft.discordId,
        targetStaffId: draft.staffId,
        detail: {
            leaveId: updated._id.toHexString(),
            from: leave.endDate,
            to: draft.endDate,
            note: draft.reason
        }
    });

    // The card carries the request and its two buttons, and the ping points
    // at it, because an edit alone would notify nobody.
    await updateLeaveCard(client, config, updated);
    if (updated.logChannelId && updated.logMessageId) {
        await pingExecutives(
            client,
            config,
            pingKey.extension(updated._id),
            { channelId: updated.logChannelId, messageId: updated.logMessageId },
            `<@${draft.discordId}> has asked to extend their leave to ${ts(draft.endDate, "f")}. ` +
                "Approve or decline it above."
        );
    }

    await interaction.editReply(
        sendOptions(
            noticeCard(
                "Extension requested",
                `You asked to come back ${ts(draft.endDate, "f")} instead of ` +
                    `${ts(leave.endDate, "f")}.\n\nAn Executive decides, and you hear back ` +
                    "either way. Until then your leave still ends on its current date.",
                { colour: COLOUR.leave }
            )
        ) as never
    );
}
