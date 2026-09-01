import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { planReconciliation } from "../domain/reconcile.js";
import { listOpenShifts, endShift } from "../domain/shifts.js";
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

    log.info(
        `Reconciliation: ${plan.stripRoleFrom.length} roles stripped, ` +
            `${plan.closeReconciled.length} shifts reconciled, ` +
            `${plan.closeMaxDuration.length} shifts closed at the ceiling.`
    );
}
