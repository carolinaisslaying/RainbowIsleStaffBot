import type { Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { findLeave, pendingOrApprovedLeaveFor } from "../domain/leave.js";
import { errorCard, leaveInterpretationCard } from "../render/cards.js";
import {
    FIELD_END,
    FIELD_REASON,
    FIELD_START,
    LEAVE_EXTEND_MODAL,
    LEAVE_REQUEST_MODAL
} from "../render/modals.js";
import { respond } from "../discord/respond.js";
import { parseInstant } from "../time/input.js";
import { ts } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { stage } from "./leaveConfirm.js";

/**
 * Leave form submissions.
 *
 * Every rule about what a valid leave window is lives here and nowhere else,
 * so requesting and extending cannot drift apart.
 *
 * The rules:
 *  - the text has to read as a date, in the member's own timezone and their own
 *    words;
 *  - nothing may start or end in the past, because leave is an arrangement
 *    about the future and back-dating it would silently rewrite a fortnight
 *    that has already been assessed;
 *  - the end has to be after the start, and an extension has to be after the
 *    end it replaces, or it is not an extension.
 *
 * Nothing here writes to the database. A valid submission is staged and shown
 * back to the member as a sentence they can check, and leaveConfirm.ts commits
 * it only once they agree. That division exists because the parser now guesses:
 * "Tuesday" is an interpretation, and an interpretation should be visible
 * before it becomes a request an Executive has to decide.
 */

/** A minute of slack, so a form submitted at the moment named is not refused. */
const GRACE_MS = 60_000;

interface Parsed {
    ok: true;
    at: Date;
}
interface Failed {
    ok: false;
    error: string;
}

/**
 * The refusal a member sees when nothing in their text read as a date.
 *
 * It leads with plain English rather than with the ISO format, because plain
 * English is what most of them will try first and the examples are the only
 * documentation the field has.
 */
function unreadable(label: string, example: string): string {
    return (
        `**${label}** did not read as a date.\n\n` +
        "Write it however you would say it out loud: " +
        `\`${example}\`, \`Tuesday at 10.16 pm\`, \`tomorrow at 9am\`, ` +
        "`the 6th`, `6 October`, `in 2 weeks`, `next Monday morning`.\n\n" +
        "`2026-10-06 09:00` works too, if you would rather be exact.\n\n" +
        "-# Dates like `06/10/2026` are refused on purpose: half the world reads that " +
        "as 6 October and half as 10 June, and leave is too easy to get four months wrong."
    );
}

function readInstant(
    raw: string,
    label: string,
    timeZone: string,
    now: Date,
    example: string
): Parsed | Failed {
    const at = parseInstant(raw, timeZone, now);
    if (!at) {
        return { ok: false, error: unreadable(label, example) };
    }
    if (at.getTime() < now.getTime() - GRACE_MS) {
        return {
            ok: false,
            error:
                `**${label}** reads as ${ts(at, "f")}, which has gone. Leave is arranged ` +
                "ahead of time, so pick a moment still to come. If you are already away and " +
                "need it recorded, ask an Executive."
        };
    }
    return { ok: true, at };
}

export async function handleLeaveModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction,
    staff: StaffDoc,
    displayName: string
): Promise<void> {
    const [namespace, leaveId] = interaction.customId.split(":");
    const zone = staff.timezone ?? config.accountingTimezone;
    const now = new Date();
    const example = "Tuesday at 9am";

    if (namespace === LEAVE_REQUEST_MODAL) {
        const typedStart = interaction.fields.getTextInputValue(FIELD_START).trim();
        const typedEnd = interaction.fields.getTextInputValue(FIELD_END).trim();

        const start = readInstant(typedStart, "Leave starts", zone, now, example);
        if (!start.ok) {
            await respond(interaction, errorCard(start.error));
            return;
        }

        const end = readInstant(typedEnd, "Leave ends", zone, now, example);
        if (!end.ok) {
            await respond(interaction, errorCard(end.error));
            return;
        }

        if (end.at <= start.at) {
            await respond(
                interaction,
                errorCard(
                    `Your leave ends before it starts. **${typedStart}** reads as ` +
                        `${ts(start.at, "f")} and **${typedEnd}** as ${ts(end.at, "f")}.`
                )
            );
            return;
        }

        // Re-checked here as well as in the command: a member can open the form,
        // leave it sitting, and submit it after a request has already landed.
        const existing = await pendingOrApprovedLeaveFor(staff._id);
        if (existing.length > 0) {
            await respond(
                interaction,
                errorCard(
                    "You already have a leave request pending or approved. Use " +
                        `${cmd("leave extend", interaction.guildId)} to change its end date.`
                )
            );
            return;
        }

        const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
        const token = stage({
            kind: "request",
            staffId: staff._id,
            discordId: staff.discordId,
            displayName,
            startDate: start.at,
            endDate: end.at,
            reason
        });

        await respond(
            interaction,
            leaveInterpretationCard({
                token,
                startDate: start.at,
                endDate: end.at,
                reason,
                reasonLabel: "Reason",
                timeZone: zone,
                typed: [typedStart, typedEnd]
            })
        );
        return;
    }

    if (namespace !== LEAVE_EXTEND_MODAL) return;

    const leave = await findLeave(new ObjectId(leaveId));
    if (!leave || (leave.status !== "approved" && leave.status !== "active")) {
        await respond(
            interaction,
            errorCard("That leave can no longer be extended. It has ended or been withdrawn.")
        );
        return;
    }
    if (!leave.staffId.equals(staff._id)) {
        await respond(interaction, errorCard("That is not your leave."));
        return;
    }

    const typedEnd = interaction.fields.getTextInputValue(FIELD_END).trim();
    const end = readInstant(typedEnd, "New return", zone, now, example);
    if (!end.ok) {
        await respond(interaction, errorCard(end.error));
        return;
    }
    if (end.at <= leave.startDate) {
        await respond(
            interaction,
            errorCard(
                `**${typedEnd}** reads as ${ts(end.at, "f")}, which is before your leave ` +
                    "starts. Check the date."
            )
        );
        return;
    }
    if (leave.endDate && end.at <= leave.endDate) {
        await respond(
            interaction,
            errorCard(
                `You are already due back ${ts(leave.endDate, "f")}. An extension has to be ` +
                    `later than that, and **${typedEnd}** reads as ${ts(end.at, "f")}. To come ` +
                    `back sooner, use ${cmd("leave end", interaction.guildId)} on the day.`
            )
        );
        return;
    }

    const note = interaction.fields.getTextInputValue(FIELD_REASON).trim();
    const token = stage({
        kind: "extend",
        staffId: staff._id,
        discordId: staff.discordId,
        displayName,
        leaveId: leave._id,
        endDate: end.at,
        reason: note
    });

    await respond(
        interaction,
        leaveInterpretationCard({
            token,
            startDate: null,
            endDate: end.at,
            reason: note,
            reasonLabel: "Why the extension",
            timeZone: zone,
            typed: [typedEnd]
        })
    );
}
