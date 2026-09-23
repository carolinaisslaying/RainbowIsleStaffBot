import type { Client, SendableChannels } from "discord.js";
import type { ObjectId } from "mongodb";
import type { LeaveDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { addRole, fetchMember, guildRoleNames, removeRole, tryDm } from "../discord/roles.js";
import { planLeaveRoleRemoval, planRoleRestore } from "../domain/reconcile.js";
import {
    leaveDueToActivate,
    actualEnd,
    leaveDueToEnd,
    markLeaveActive,
    markLeaveCancelled,
    markLeaveEnded,
    otherCountingLeave,
    recordLeaveCard
} from "../domain/leave.js";
import { describeLeaveEffect, leaveEffect, type LeaveSpan } from "../domain/leaveDays.js";
import { fortnightAnchorDate } from "../config/guildConfig.js";
import { findStaffById } from "../domain/staff.js";
import { getOpenShift } from "../domain/shifts.js";
import { finishShift } from "./shiftService.js";
import { audit } from "../domain/audit.js";
import {
    leaveCancelledCard,
    leaveRequestCard,
    noticeCard,
    type RenderedMessage
} from "../render/cards.js";
import { leaveTermsText } from "../render/leaveTerms.js";
import { log } from "../log.js";
import { formatDays, labelDate, ts } from "../time/format.js";
import { EMOJI } from "../render/emoji.js";
import { COLOUR } from "../render/theme.js";
import { cmd } from "../discord/commandMentions.js";
import { staffDisplayName } from "../discord/displayName.js";
import { sendOptions } from "../discord/respond.js";
import { pingExecutives, pingKey, resolvePing } from "./pings.js";
import { reassessAfterLeaveChange } from "./leaveReassess.js";

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

    if (!(await markLeaveActive(leave._id, removed))) {
        // Cancelled between the sweep reading it and now. The roles just taken
        // go straight back, and the member is not told a leave started that
        // they have already been told is off.
        if (member) {
            for (const roleId of removed) {
                await addRole(member, roleId, "Leave cancelled", staff._id);
            }
            await removeRole(member, config.onLeaveRole, "Leave cancelled", staff._id);
        }
        log.warn(`Leave ${leave._id.toHexString()} was cancelled while activating; roles put back`);
        return;
    }
    await audit("leave.activate", {
        targetStaffId: staff._id,
        detail: { leaveId: leave._id.toHexString(), removedRoles: removed }
    });

    await tryDm(client, staff.discordId, {
        ...noticeCard(
            `Your leave has started`,
            `You are due back ${ts(leave.endDate, "D")}, ${ts(leave.endDate, "R")}. ` +
                `Use ${cmd("leave end")} if you are back sooner.\n\n` +
                leaveTermsText(config.minimumLeaveDays),
            { colour: COLOUR.settled }
        )
    });
}

/**
 * What a leave change would do to the member's requirements, as the lines the
 * confirmation card and the leave card print.
 *
 * A request is measured against the member's other leave; an extension against
 * the same leave ending on its current date. Either way the member's other
 * counting leave is included, because two leaves in one week add up.
 */
export async function describeLeaveChange(
    config: StaffBotConfig,
    staffId: ObjectId,
    change:
        | { kind: "request"; startDate: Date; endDate: Date }
        | { kind: "extension"; leave: LeaveDoc; endDate: Date }
): Promise<string[]> {
    const others = await otherCountingLeave(
        staffId,
        change.kind === "extension" ? change.leave._id : null
    );
    const before: LeaveSpan[] = others.map((record) => ({
        startDate: record.startDate,
        endDate: record.endDate
    }));
    const span: LeaveSpan =
        change.kind === "request"
            ? { startDate: change.startDate, endDate: change.endDate }
            : { startDate: change.leave.endDate, endDate: change.endDate };
    if (change.kind === "extension") {
        before.push({ startDate: change.leave.startDate, endDate: change.leave.endDate });
    }
    const after =
        change.kind === "request"
            ? [...before, span]
            : [
                  ...before.slice(0, -1),
                  { startDate: change.leave.startDate, endDate: change.endDate }
              ];

    const effect = leaveEffect({
        span,
        before,
        after,
        rules: {
            anchor: fortnightAnchorDate(config),
            timeZone: config.accountingTimezone,
            weekStartDay: config.weekStartDay
        },
        minimumLeaveDays: config.minimumLeaveDays,
        weeklyTargetMinutes: config.weeklyTargetMinutes
    });
    return describeLeaveEffect(effect, {
        kind: change.kind,
        label: (date) => labelDate(date, config.accountingTimezone),
        minimumLeaveDays: config.minimumLeaveDays
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
        outcome = `-# Away since ${ts(leave.startDate, "R")}. Staff roles are removed.`;
    } else if (leave.status === "cancelled" && leave.cancelledAt) {
        const by = leave.cancelledBy ? await findStaffById(leave.cancelledBy) : null;
        outcome =
            `-# Cancelled ${ts(leave.cancelledAt, "R")}` +
            (by ? ` by <@${by.discordId}>` : "") +
            ", before it started. Their staff roles were never removed." +
            (leave.cancellationReason ? `\n**Why:** ${leave.cancellationReason}` : "");
    } else if (leave.status === "ended" && leave.rolesRestoredAt) {
        const early = leave.endedEarlyBy ? await findStaffById(leave.endedEarlyBy) : null;
        outcome =
            `-# Back ${ts(leave.rolesRestoredAt, "R")}` +
            (early
                ? `, ended early by <@${early.discordId}>.`
                : leave.plannedEndDate
                  ? ", they ended it themselves."
                  : ", on schedule.") +
            (leave.restoreErrors.length > 0
                ? ` ${leave.restoreErrors.length} staff role(s) could not be restored.`
                : "");
    }

    const extension = leave.pendingExtension;
    return leaveRequestCard({
        leaveId: leave._id.toHexString(),
        displayName: subject ? `${name} (<@${subject.discordId}>)` : name,
        startDate: leave.startDate,
        endDate: leave.endDate,
        plannedEndDate: leave.plannedEndDate,
        reason: leave.reason,
        status: leave.status,
        decided,
        outcome,
        purged: extra.purged ?? null,
        effectLines:
            leave.status === "pending"
                ? await describeLeaveChange(config, leave.staffId, {
                      kind: "request",
                      startDate: leave.startDate,
                      endDate: leave.endDate
                  })
                : [],
        pendingExtension: extension
            ? {
                  endDate: extension.endDate,
                  reason: extension.reason,
                  effectLines: await describeLeaveChange(config, leave.staffId, {
                      kind: "extension",
                      leave,
                      endDate: extension.endDate
                  })
              }
            : null
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
    const ended = (await markLeaveEnded(leave, errors, earlyBy)) ?? {
        ...leave,
        status: "ended" as const,
        rolesRestoredAt: new Date(),
        restoreErrors: errors,
        endedEarlyBy: earlyBy
    };
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
        restored: restored.map((roleId) => roleNames.get(roleId) ?? "a staff role that no longer exists"),
        missing: errors.map((roleId) => roleNames.get(roleId) ?? roleId),
        inGuild: member !== null,
        minimumLeaveDays: config.minimumLeaveDays
    };
    await tryDm(client, staff.discordId, { ...welcomeBackCard(summary) });

    // The channel card follows the record into its final state, so the leave
    // channel shows one row per request from "pending" through to "back".
    await updateLeaveCard(client, config, ended);
    // An extension nobody decided has nothing left to extend.
    await resolvePing(client, pingKey.extension(leave._id));

    // Ending early shortens the leave actually taken, which can un-exempt a
    // week in a fortnight that has already closed.
    if (ended.endDate.getTime() < leave.endDate.getTime()) {
        await reassessAfterLeaveChange(
            client,
            config,
            leave.staffId,
            [{ startDate: leave.startDate, endDate: leave.endDate }],
            "leave ended early"
        );
    }

    if (errors.length > 0) {
        const line =
            `<@${staff.discordId}> is back from leave, but these staff roles no longer exist ` +
            "and did not come back: " +
            errors.map((roleId) => `**${roleNames.get(roleId) ?? roleId}**`).join(", ") +
            ". Grant the current equivalents by hand.";
        if (leave.logChannelId && leave.logMessageId) {
            await pingExecutives(
                client,
                config,
                pingKey.restore(leave._id),
                { channelId: leave.logChannelId, messageId: leave.logMessageId },
                line
            );
        } else {
            const channel = await staffChannel(client, config, config.leaveChannelId);
            await channel?.send({
                ...noticeCard("Some staff roles could not be restored", line, {
                    colour: COLOUR.adverse,
                    emoji: EMOJI.warning
                })
            });
        }
    }

    return welcomeBackCard({ ...summary, guildId: readIn });
}

/**
 * Call off approved leave before it starts.
 *
 * Separate from `endLeave` because nothing has happened yet that needs
 * undoing: no roles were removed, nobody was away, and the member is told the
 * leave is off rather than welcomed back from it. Returns false when the sweep
 * activated the leave first, so the caller can end it instead.
 */
export async function cancelLeave(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc,
    by: { discordId: string; staffId: ObjectId },
    reason: string
): Promise<boolean> {
    const cancelled = await markLeaveCancelled(leave, by.staffId, reason);
    if (!cancelled) return false;

    const staff = await findStaffById(leave.staffId);
    await audit("leave.cancel", {
        actorId: by.discordId,
        targetStaffId: leave.staffId,
        detail: {
            leaveId: leave._id.toHexString(),
            start: leave.startDate,
            end: leave.endDate,
            reason
        }
    });

    if (staff) {
        await tryDm(client, staff.discordId, {
            ...leaveCancelledCard({
                startDate: leave.startDate,
                endDate: leave.endDate,
                cancelledBy: by.discordId,
                reason
            })
        });
    }

    await updateLeaveCard(client, config, cancelled);
    await resolvePing(client, pingKey.extension(leave._id));

    // Approved leave counts towards exemptions from the moment it is approved,
    // so a leave whose start had already passed when it was called off can
    // have exempted a week that is now closed.
    await reassessAfterLeaveChange(
        client,
        config,
        leave.staffId,
        [{ startDate: leave.startDate, endDate: leave.endDate }],
        "leave cancelled"
    );
    return true;
}

/** Whether the leave stopped before the date it was booked to. */
function cutShort(leave: LeaveDoc, at = new Date()): boolean {
    return leave.endDate.getTime() > at.getTime();
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
    minimumLeaveDays: number;
    guildId?: string | null;
}): RenderedMessage {
    const { leave, endedBy } = options;
    const now = new Date();
    // Never before the start, so the range cannot run backwards however this
    // is reached. Cancelling leave that has not started goes to
    // `cancelLeave` instead; this is the floor under that.
    const back = actualEnd(leave, now);
    const away = formatDays(back.getTime() - leave.startDate.getTime());

    const opening =
        endedBy.kind === "executive"
            ? `**Your leave has been ended early** by <@${endedBy.discordId}>. ` +
              `You were booked back ${ts(leave.endDate, "D")}; you are back as of now.`
            : endedBy.kind === "member"
              ? "**Your leave is closed** because you ended it."
              : `**Your leave is over.** It ran its full course and closed ` +
                `${ts(leave.endDate, "R")}, as booked.`;

    const lines = [
        opening,
        `You were away ${away}, from ${ts(leave.startDate, "D")} to ${ts(back, "D")}.`,
        ""
    ];

    if (!options.inGuild) {
        lines.push(
            "**Your staff roles are not back.** You are not in the community server, so there was " +
                "nothing to restore them onto. Rejoin and ask an Executive to put them back."
        );
    } else if (options.restored.length > 0) {
        lines.push(
            `**Staff roles restored:** ${options.restored.map((name) => `**${name}**`).join(", ")}.`
        );
    } else {
        lines.push("**No staff roles needed restoring.** None were removed when you left.");
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
        "- Your activity counts again from today. Weeks with at least " +
            `${options.minimumLeaveDays} days of your leave in them stay exempt` +
            (cutShort(leave, now)
                ? ", counted on the leave you took rather than the leave you booked."
                : "."),
        "- Your run of weeks in a row meeting the target carries on where it was. Exempt " +
            "weeks didn't break it.",
        "- Your rings and your leaderboard row are no longer greyed out.",
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
