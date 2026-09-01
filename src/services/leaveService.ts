import type { Client, SendableChannels } from "discord.js";
import type { ObjectId } from "mongodb";
import type { LeaveDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { addRole, existingRoleIds, fetchMember, removeRole, tryDm } from "../discord/roles.js";
import { planLeaveRoleRemoval, planRoleRestore } from "../domain/reconcile.js";
import {
    leaveDueToActivate,
    leaveDueToEnd,
    markLeaveActive,
    markLeaveEnded
} from "../domain/leave.js";
import { findStaffById } from "../domain/staff.js";
import { getOpenShift } from "../domain/shifts.js";
import { finishShift } from "./shiftService.js";
import { audit } from "../domain/audit.js";
import { noticeCard } from "../render/cards.js";
import { log } from "../log.js";
import { ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";
import { cmd } from "../discord/commandMentions.js";

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
            member?.displayName ?? "You",
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
 * End leave and restore the snapshot. A role deleted while the member was away
 * is recorded rather than allowed to block the rest of the restore.
 */
export async function endLeave(
    client: Client,
    config: StaffBotConfig,
    leave: LeaveDoc
): Promise<void> {
    const staff = await findStaffById(leave.staffId);
    if (!staff) return;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    let errors: string[] = [];

    if (member) {
        const roles = await existingRoleIds(client, config.publicGuildId);
        // The department role goes back whether or not the snapshot names it.
        // Leave that activated before the role was configured, or a role pulled
        // by hand while the member was away, would otherwise leave them locked
        // out of the department they just returned to.
        const wanted = [...leave.removedRoles];
        if (config.moderationDepartmentRole && !wanted.includes(config.moderationDepartmentRole)) {
            wanted.push(config.moderationDepartmentRole);
        }
        const plan = planRoleRestore(wanted, roles);
        errors = plan.errors;

        for (const roleId of plan.restore) {
            await addRole(member, roleId, "Leave ended", staff._id);
        }
        await removeRole(member, config.onLeaveRole, "Leave ended", staff._id);
    } else {
        // They are not in the guild to restore anything onto.
        errors = [];
    }

    await markLeaveEnded(leave._id, errors);
    await audit("leave.end", {
        targetStaffId: staff._id,
        detail: { leaveId: leave._id.toHexString(), restoreErrors: errors }
    });

    await tryDm(client, staff.discordId, {
        ...noticeCard(
            "Welcome back",
            errors.length === 0
                ? `You have your ranks back. Run ${cmd("shift start")} when you are ready.`
                : "You have your ranks back, except a few that no longer exist. The " +
                      "Executives have the details.",
            { colour: COLOUR.approved }
        )
    });

    if (errors.length > 0) {
        const channel = await staffChannel(client, config, config.leaveChannelId);
        await channel?.send({
            ...noticeCard(
                "Some roles are missing",
                `<@${staff.discordId}> is back from leave. These roles no longer exist, so ` +
                    "they did not come back:\n" +
                    errors.map((roleId) => `- **${roleId}**`).join("\n") +
                    "\n\nGrant the current equivalents by hand.",
                { colour: COLOUR.adverse }
            )
        });
    }
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
