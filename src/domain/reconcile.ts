import type { ObjectId } from "mongodb";
import type { ShiftDoc } from "../db/types.js";

/**
 * Boot reconciliation, as a pure plan.
 *
 * The container restarts. Roles outlive the process, open shift documents
 * outlive the process, and the two drift apart whenever the bot dies mid-shift.
 * Planning the repair separately from applying it means the interesting logic
 * is testable against a seeded fixture rather than only against a live guild.
 */

export interface ReconcileInput {
    /** Discord IDs currently holding availabilityRole in the public guild. */
    roleHolders: string[];
    /** Every shift document with endedAt: null. */
    openShifts: ShiftDoc[];
    /** staffId hex to current Discord ID, for the open shifts we know about. */
    staffDiscordIds: Map<string, string>;
    /** Discord IDs still present in the public guild. */
    presentMembers: Set<string>;
    maxShiftHours: number;
    now: Date;
}

export interface ReconcilePlan {
    /** Wearing the role with no open shift: strip it. */
    stripRoleFrom: string[];
    /** Open shift, member no longer holds the role or has left: close reconciled. */
    closeReconciled: { shiftId: ObjectId; staffId: ObjectId; reason: "reconciled" }[];
    /** Open shift older than the ceiling: close max_duration. */
    closeMaxDuration: { shiftId: ObjectId; staffId: ObjectId; reason: "max_duration" }[];
}

export function planReconciliation(input: ReconcileInput): ReconcilePlan {
    const plan: ReconcilePlan = {
        stripRoleFrom: [],
        closeReconciled: [],
        closeMaxDuration: []
    };

    const maxDurationMs = input.maxShiftHours * 3_600_000;
    const holders = new Set(input.roleHolders);
    const discordIdsWithOpenShift = new Set<string>();

    for (const shift of input.openShifts) {
        const staffKey = shift.staffId.toHexString();
        const discordId = input.staffDiscordIds.get(staffKey);

        // Step 3 first: the ceiling applies whether or not the role survived.
        const age = input.now.getTime() - shift.startedAt.getTime();
        if (age > maxDurationMs) {
            plan.closeMaxDuration.push({
                shiftId: shift._id,
                staffId: shift.staffId,
                reason: "max_duration"
            });
            continue;
        }

        // Step 2: the member left the guild, or lost the role while we were down.
        if (!discordId || !input.presentMembers.has(discordId) || !holders.has(discordId)) {
            plan.closeReconciled.push({
                shiftId: shift._id,
                staffId: shift.staffId,
                reason: "reconciled"
            });
            continue;
        }

        discordIdsWithOpenShift.add(discordId);
    }

    // Step 1: wearing the role with nothing backing it.
    for (const holder of holders) {
        if (!discordIdsWithOpenShift.has(holder)) plan.stripRoleFrom.push(holder);
    }

    return plan;
}

/**
 * Leave role restoration, as a pure plan. A role deleted while the member was
 * away must not block the rest of the restore; it is recorded and reported.
 */
export function planRoleRestore(
    removedRoles: string[],
    existingRoleIds: Set<string>
): { restore: string[]; errors: string[] } {
    const restore: string[] = [];
    const errors: string[] = [];
    for (const roleId of removedRoles) {
        if (existingRoleIds.has(roleId)) restore.push(roleId);
        else errors.push(roleId);
    }
    return { restore, errors };
}

/**
 * Which roles leave activation strips: the department role plus every rank the
 * member actually holds. The snapshot is exactly what was removed, so a member
 * who never had a given rank does not acquire it on return.
 */
export function planLeaveRoleRemoval(
    memberRoleIds: Set<string>,
    moderationDepartmentRole: string,
    staffRankRoles: string[]
): string[] {
    const remove: string[] = [];
    if (moderationDepartmentRole && memberRoleIds.has(moderationDepartmentRole)) {
        remove.push(moderationDepartmentRole);
    }
    for (const rank of staffRankRoles) {
        if (rank && memberRoleIds.has(rank)) remove.push(rank);
    }
    return remove;
}
