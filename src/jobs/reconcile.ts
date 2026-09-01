import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { planReconciliation } from "../domain/reconcile.js";
import { listOpenShifts, endShift } from "../domain/shifts.js";
import { markSeen } from "../services/shiftService.js";
import { findManyStaff } from "../domain/staff.js";
import { membersWithRole, removeRole } from "../discord/roles.js";
import { audit } from "../domain/audit.js";
import { log } from "../log.js";

/**
 * Mandatory boot reconciliation. Roles and open shift documents both outlive
 * the process and drift apart whenever the bot dies mid-shift, so every startup
 * repairs the mismatch before anything else runs.
 */
export async function reconcileOnBoot(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<void> {
    const guild = await client.guilds.fetch(config.publicGuildId);
    const holders = await membersWithRole(client, config, config.availabilityRole);
    const openShifts = await listOpenShifts();

    const staff = await findManyStaff(openShifts.map((shift) => shift.staffId));
    const staffDiscordIds = new Map(
        [...staff.values()].map((doc) => [doc._id.toHexString(), doc.discordId])
    );

    // Membership is what decides "left the guild", so resolve it explicitly
    // rather than inferring it from the role list.
    const presentMembers = new Set<string>();
    for (const discordId of staffDiscordIds.values()) {
        try {
            await guild.members.fetch(discordId);
            presentMembers.add(discordId);
        } catch {
            // Not in the guild any more.
        }
    }

    const plan = planReconciliation({
        roleHolders: holders.map((member) => member.id),
        openShifts,
        staffDiscordIds,
        presentMembers,
        maxShiftHours: config.maxShiftHours,
        now
    });

    for (const discordId of plan.stripRoleFrom) {
        const member = holders.find((candidate) => candidate.id === discordId);
        if (!member) continue;
        await removeRole(member, config.availabilityRole, "Reconciliation: no open shift");
        log.warn(`Stripped orphaned availability role from ${discordId}`);
    }

    for (const entry of [...plan.closeMaxDuration, ...plan.closeReconciled]) {
        await endShift(entry.shiftId, entry.reason, now);
        await audit("shift.reconciled", {
            targetStaffId: entry.staffId,
            detail: { shiftId: entry.shiftId.toHexString(), reason: entry.reason }
        });
        log.warn(`Closed orphaned shift ${entry.shiftId.toHexString()} as ${entry.reason}`);
    }

    // Every shift that survived reconciliation gets a fresh grace period.
    //
    // `lastSeen` lives in this process and nowhere else, so a restart empties
    // it, and the sweep falls back to `shift.startedAt`. That marked every
    // surviving shift older than awayAfterMinutes as Away on the first minute
    // tick after a deploy, and auto-ended it autoEndAfterAwayMinutes later: a
    // redeploy at eight in the evening ended the evening shift for everybody
    // working it.
    //
    // The trade is deliberate. Somebody who genuinely went quiet before the
    // restart gets one extra awayAfterMinutes before the sweep catches them.
    // That is the right direction to be wrong in; the alternative closes a
    // shift the member is in the middle of working.
    const closed = new Set(
        [...plan.closeMaxDuration, ...plan.closeReconciled].map((entry) =>
            entry.shiftId.toHexString()
        )
    );
    let regraced = 0;
    for (const shift of openShifts) {
        if (closed.has(shift._id.toHexString())) continue;
        markSeen(shift.staffId, now);
        regraced += 1;
    }

    log.info(
        `Reconciliation: ${plan.stripRoleFrom.length} roles stripped, ` +
            `${regraced} open shift(s) given a fresh inactivity grace period, ` +
            `${plan.closeReconciled.length} shifts reconciled, ` +
            `${plan.closeMaxDuration.length} shifts closed at the ceiling.`
    );
}
