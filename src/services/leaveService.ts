import type { Client, SendableChannels } from "discord.js";
import type { ObjectId } from "mongodb";
import type { LeaveDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { addRole, fetchMember, guildRoleNames, removeRole, tryDm } from "../discord/roles.js";
import { planLeaveRoleRemoval, planRoleRestore } from "../domain/reconcile.js";
import {
    leaveDueToActivate,
    leaveDueToEnd,
    markLeaveActive,
    markLeaveEnded,
    recordLeaveCard
} from "../domain/leave.js";
import { findStaffById } from "../domain/staff.js";
import { getOpenShift } from "../domain/shifts.js";
import { finishShift } from "./shiftService.js";
import { audit } from "../domain/audit.js";
import { leaveRequestCard, noticeCard, type RenderedMessage } from "../render/cards.js";
import { log } from "../log.js";
import { formatDays, ts } from "../time/format.js";
import { EMOJI } from "../render/emoji.js";
import { COLOUR } from "../render/theme.js";
import { cmd } from "../discord/commandMentions.js";
import { staffDisplayName } from "../discord/displayName.js";
import { sendOptions } from "../discord/respond.js";

export async function staffChannel(
    client: Client,
    config: StaffBotConfig,
    channelId: string
): Promise<SendableChannels | null> {
    if (!channelId) return null;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isSendable()) return channel;
    } catch (error) {
        log.warn(`Could not fetch channel ${channelId}`, error);
    }
    return null;
}

/**
 * Activate approved leave. Snapshots exactly the roles removed, so the return
 * restores exactly what was taken and nothing more.
 */
export async function activateLeave(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc
): Promise<void> {
    const staff = await findStaffById(leave.staffId);
    if (!staff) return;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    let removed: string[] = [];

    if (member) {
        removed = planLeaveRoleRemoval(
            new Set(member.roles.cache.map((role) => role.id)),
            config.moderationDepartmentRole,
            config.staffRankRoles
        );
        for (const roleId of removed) {
            await removeRole(member, roleId, "Leave activated", staff._id);
        }
        await addRole(member, config.onLeaveRole, "Leave activated", staff._id);
        await removeRole(member, config.availabilityRole, "Leave activated", staff._id);
    }

    const open = await getOpenShift(staff._id);
    if (open) {
        await finishShift(
            client,
            config,
            staff,
            await staffDisplayName(client, config, staff.discordId, "You"),
            "leave_started"
        );
    }

    await markLeaveActive(leave._id, removed);
    await audit("leave.activate", {
        targetStaffId: staff._id,
        detail: { leaveId: leave._id.toHexString(), removedRoles: removed }
    });

    await tryDm(client, staff.discordId, {
        ...noticeCard(
            `Your leave has started`,
            "Your ranks are set aside until you get back.\n" +
                (leave.endDate
                    ? `You are due back ${ts(leave.endDate, "D")}, ${ts(leave.endDate, "R")}.`
                    : "Your leave is open ended. Use " +
                      `${cmd("leave end")} when you are ready to come back.`) +
                "\n\nWhile you are away, no fortnight assessment applies to you and your " +
                "streak freezes where it stands.",
            { colour: COLOUR.settled }
        )
    });
}

/**
 * Why a leave ended, which is the only thing that separates three otherwise
 * identical restores. The member reads a different sentence in each case, and
 * only the Executive one is recorded on the document.
 */
export type LeaveEndReason =
    /** Its end date arrived and the sweep closed it. */
    | { kind: "schedule" }
    /** The member ran `/leave end` themselves. */
    | { kind: "member" }
    /** An Executive ended it early from the leave channel. */
    | { kind: "executive"; discordId: string; staffId: ObjectId };

/**
 * The one renderer for a leave record's card, wherever it is being drawn.
 *
 * Four places used to build this card and each knew a slightly different amount
 * about the record, so the same leave could read as "Approved" in the channel
 * and "ended" in the database. The card is derived from the document here, once,
 * and every state change re-renders through this.
 */
export async function leaveCardFor(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc,
    extra: { purged?: string | null } = {}
): Promise<RenderedMessage> {
    const subject = await findStaffById(leave.staffId);
    const name = subject
        ? await staffDisplayName(client, config, subject.discordId, "Departed member")
        : "an unknown member";
    const decider = leave.decidedBy ? await findStaffById(leave.decidedBy) : null;

    const decided =
        leave.status === "pending" || !leave.decidedAt
            ? null
            : `**${leave.status === "declined" ? "Declined" : "Approved"}**` +
              (decider ? ` by <@${decider.discordId}>` : "") +
              ` ${ts(leave.decidedAt, "R")}`;

    let outcome: string | null = null;
    if (leave.status === "active") {
        outcome = `-# Away since ${ts(leave.startDate, "R")}. Ranks are set aside.`;
    } else if (leave.status === "ended" && leave.rolesRestoredAt) {
        const early = leave.endedEarlyBy ? await findStaffById(leave.endedEarlyBy) : null;
        outcome =
            `-# Back ${ts(leave.rolesRestoredAt, "R")}` +
            (early
                ? `, ended early by <@${early.discordId}>.`
                : leave.endDate
                  ? ", on schedule."
                  : ", they closed it themselves.") +
            (leave.restoreErrors.length > 0
                ? ` ${leave.restoreErrors.length} rank(s) could not be restored.`
                : "");
    }

    return leaveRequestCard({
        leaveId: leave._id.toHexString(),
        displayName: subject ? `${name} (<@${subject.discordId}>)` : name,
        startDate: leave.startDate,
        endDate: leave.endDate,
        reason: leave.reason,
        status: leave.status,
        decided,
        outcome,
        purged: extra.purged ?? null
    });
}

/**
 * Redraw the request's card in the leave channel to match the record.
 *
 * Best effort by design: the channel card is a record, not the record. A
 * deleted message, a channel the bot lost access to, or a leave from before the
 * card location was stored must not turn a completed restore into an error the
 * member or the Executive has to interpret.
 */
export async function updateLeaveCard(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc
): Promise<void> {
    if (!leave.logChannelId || !leave.logMessageId) return;
    try {
        const channel = await client.channels.fetch(leave.logChannelId);
        if (!channel?.isTextBased()) return;
        const message = await channel.messages.fetch(leave.logMessageId);
        await message.edit(sendOptions(await leaveCardFor(client, config, leave)) as never);
    } catch (error) {
        log.warn(`Could not update the card for leave ${leave._id.toHexString()}`, error);
    }
}

/** Remember where a freshly posted request card lives, so it can be updated. */
export async function rememberLeaveCard(
    leaveId: ObjectId,
    channelId: string,
    messageId: string
): Promise<void> {
    await recordLeaveCard(leaveId, channelId, messageId);
}

/**
 * End leave and restore the snapshot. A role deleted while the member was away
 * is recorded rather than allowed to block the rest of the restore.
 *
 * Returns the card the member was sent, so a caller who ended their own leave
 * can show them the same words rather than composing a second, shorter version
 * of them that then drifts.
 */
export async function endLeave(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc,
    endedBy: LeaveEndReason = { kind: "schedule" },
    /**
     * Where the returned copy will be read, when a caller intends to show it.
     * The DM always gets the direct message registration's command ids; a
     * caller replying in the staff server needs that server's, and one string
     * cannot carry both.
     */
    readIn?: string | null
): Promise<RenderedMessage | null> {
    const staff = await findStaffById(leave.staffId);
    if (!staff) return null;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    const roleNames = await guildRoleNames(client, config.publicGuildId);
    let errors: string[] = [];
    let restored: string[] = [];

    if (member) {
        // The department role goes back whether or not the snapshot names it.
        // Leave that activated before the role was configured, or a role pulled
        // by hand while the member was away, would otherwise leave them locked
        // out of the department they just returned to.
        const wanted = [...leave.removedRoles];
        if (config.moderationDepartmentRole && !wanted.includes(config.moderationDepartmentRole)) {
            wanted.push(config.moderationDepartmentRole);
        }
        const plan = planRoleRestore(wanted, new Set(roleNames.keys()));
        errors = plan.errors;
        restored = plan.restore;

        for (const roleId of plan.restore) {
            await addRole(member, roleId, "Leave ended", staff._id);
        }
        await removeRole(member, config.onLeaveRole, "Leave ended", staff._id);
    }

    const earlyBy = endedBy.kind === "executive" ? endedBy.staffId : null;
    await markLeaveEnded(leave._id, errors, earlyBy);
    await audit("leave.end", {
        actorId: endedBy.kind === "executive" ? endedBy.discordId : staff.discordId,
        targetStaffId: staff._id,
        detail: {
            leaveId: leave._id.toHexString(),
            endedBy: endedBy.kind,
            restoreErrors: errors,
            early: endedBy.kind === "executive" || cutShort(leave)
        }
    });

    const summary = {
        leave,
        endedBy,
        restored: restored.map((roleId) => roleNames.get(roleId) ?? "a rank that no longer exists"),
        missing: errors.map((roleId) => roleNames.get(roleId) ?? roleId),
        inGuild: member !== null
    };
    await tryDm(client, staff.discordId, { ...welcomeBackCard(summary) });

    // The channel card follows the record into its final state, so the leave
    // channel shows one row per request from "pending" through to "back".
    await updateLeaveCard(client, config, {
        ...leave,
        status: "ended",
        rolesRestoredAt: new Date(),
        restoreErrors: errors,
        endedEarlyBy: earlyBy
    });

    if (errors.length > 0) {
        const channel = await staffChannel(client, config, config.leaveChannelId);
        await channel?.send({
            ...noticeCard(
                "Some ranks could not be restored",
                `<@${staff.discordId}> is back from leave. These ranks no longer exist, so ` +
                    "they did not come back:\n" +
                    errors.map((roleId) => `- **${roleNames.get(roleId) ?? roleId}**`).join("\n") +
                    "\n\nGrant the current equivalents by hand.",
                { colour: COLOUR.adverse, emoji: EMOJI.warning }
            )
        });
    }

    return welcomeBackCard({ ...summary, guildId: readIn });
}

/** Whether the leave stopped before the date it was booked to. */
function cutShort(leave: LeaveDoc, at = new Date()): boolean {
    return leave.endDate !== null && leave.endDate.getTime() > at.getTime();
}

/**
 * The message a member gets on the way back in.
 *
 * The old one was a single sentence, "You have your ranks back", which answers
 * none of the questions somebody has after two weeks away:
 * whether the leave is really over, what came back, what starts counting again,
 * and, if they did not end it themselves, who did and why it stopped early. It
 * says all of that, in that order, because that is the order they are asked.
 */
function welcomeBackCard(options: {
    leave: LeaveDoc;
    endedBy: LeaveEndReason;
    restored: string[];
    missing: string[];
    inGuild: boolean;
    guildId?: string | null;
}): RenderedMessage {
    const { leave, endedBy } = options;
    const now = new Date();
    const away = formatDays(now.getTime() - leave.startDate.getTime());

    const opening =
        endedBy.kind === "executive"
            ? `**Your leave has been ended early** by <@${endedBy.discordId}>. ` +
              (leave.endDate
                  ? `You were booked back ${ts(leave.endDate, "D")}; you are back as of now.`
                  : "Your leave was open ended; you are back as of now.")
            : endedBy.kind === "member"
              ? "**Your leave is closed** because you ended it."
              : `**Your leave is over.** It ran its full course and closed ` +
                `${ts(leave.endDate ?? now, "R")}, as booked.`;

    const lines = [
        opening,
        `You were away ${away}, from ${ts(leave.startDate, "D")}` +
            (leave.endDate ? ` to ${ts(leave.endDate, "D")}.` : ", open ended."),
        ""
    ];

    if (!options.inGuild) {
        lines.push(
            "**Your ranks are not back.** You are not in the community server, so there was " +
                "nothing to restore them onto. Rejoin and ask an Executive to put them back."
        );
    } else if (options.restored.length > 0) {
        lines.push(
            `**Ranks restored:** ${options.restored.map((name) => `**${name}**`).join(", ")}.`
        );
    } else {
        lines.push("**No ranks needed restoring.** Nothing was set aside when you left.");
    }

    if (options.missing.length > 0) {
        lines.push(
            `**Not restored:** ${options.missing.map((name) => `**${name}**`).join(", ")}. ` +
                "These no longer exist. The Executives have been told and will sort out the " +
                "current equivalent."
        );
    }

    lines.push(
        "",
        "**What starts again now**",
        "- Fortnight assessment counts you from today. The fortnights your leave covered stay " +
            "excused.",
        "- Your streak picks up where it froze rather than starting over.",
        "- Your rings and your leaderboard row come back out of grey.",
        "",
        `Run ${cmd("shift start", options.guildId)} when you are ready to go on shift.`
    );

    return noticeCard("Welcome back", lines.join("\n"), {
        colour: COLOUR.approved,
        emoji: EMOJI.welcome
    });
}

/**
 * Boundary sweep. Activates approved leave whose start has arrived and ends
 * active leave whose end date has passed. Idempotent, and it reconciles missed
 * runs by looking at dates rather than at what it did last time.
 */
export async function processLeaveTransitions(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<void> {
    for (const leave of await leaveDueToActivate(now)) {
        try {
            await activateLeave(client, config, leave);
        } catch (error) {
            log.error(`Failed to activate leave ${leave._id.toHexString()}`, error);
        }
    }
    for (const leave of await leaveDueToEnd(now)) {
        try {
            await endLeave(client, config, leave);
        } catch (error) {
            log.error(`Failed to end leave ${leave._id.toHexString()}`, error);
        }
    }
}

export async function leaveStaffId(leave: LeaveDoc): Promise<ObjectId> {
    return leave.staffId;
}
