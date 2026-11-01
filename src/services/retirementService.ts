import type { Client, Guild, GuildMember } from "discord.js";
import { readMember } from "../discord/roles.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { pendingOrApprovedLeaveFor } from "../domain/leave.js";
import { isBootstrapAdmin, tierOf, wearsOnLeaveRole } from "../domain/permissions.js";
import {
    isOnLeaveNow,
    leaveCloseDue,
    retirementAction,
    staffRolesProblem,
    sweepOverThreshold,
    type MemberReading,
    type RetirementAction
} from "../domain/retirement.js";
import { listAllStaff, listRetiredStaff, retireStaff, returnStaff } from "../domain/staff.js";
import { cancelLeave, endLeave } from "./leaveService.js";
import { finishShift } from "./shiftService.js";
import { log } from "../log.js";

/**
 * Keeps `StaffDoc.active` true to the facts: a live reading from the member
 * events, and a sweep at boot and at week close for whatever those missed while
 * the bot was down. The sweep's first run is also what retires everybody who
 * went out of date before this existed.
 *
 * Retiring tells nobody. The audit row is the record, and the role change is
 * already visible in Discord.
 */

const CLOSED_LEAVE_REASON = "No longer on the team.";

export type SweepBlock =
    | { kind: "roles"; reason: string }
    | { kind: "threshold"; discordIds: string[]; roster: number };

export type SweepOutcome = {
    retired: number;
    returned: number;
    block: SweepBlock | null;
};

/** The last sweep's answer, for `/dev status`. A boot always runs one first. */
let lastBlock: SweepBlock | null = null;

export function sweepBlock(): SweepBlock | null {
    return lastBlock;
}

async function decide(
    config: StaffBotConfig,
    staff: StaffDoc,
    reading: MemberReading,
    member: GuildMember | null,
    now: Date
): Promise<RetirementAction> {
    const resolved: MemberReading =
        reading.kind === "present"
            ? { kind: "present", hasTier: tierOf(member, config) !== "none" }
            : reading;
    return retirementAction({
        active: staff.active,
        seeded: isBootstrapAdmin(staff.discordId),
        onLeave: isOnLeaveNow(
            await pendingOrApprovedLeaveFor(staff._id),
            wearsOnLeaveRole(member, config),
            now
        ),
        reading: resolved
    });
}

/**
 * End a retired person's shift. It keeps its minutes, and the summary card it
 * returns goes nowhere: all DMs stop on retirement. Idempotent, so a failure here
 * is finished by the next sweep.
 */
async function closeShift(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    now: Date
): Promise<void> {
    try {
        await finishShift(client, config, staff, "You", "retired", now);
    } catch (error) {
        log.error(`Closing the shift of retired ${staff._id.toHexString()} failed`, error);
    }
}

/**
 * Close the leave of anybody retired for longer than `LEAVE_CLOSE_DELAY_MS`.
 *
 * Runs on the minute with the other leave transitions and goes by `retiredAt`, so
 * a restart in the middle loses nothing. Cancelled leave cannot be brought back,
 * and moving somebody between roles in two steps retires them for a moment; by
 * the time this looks they have returned and are not on the list.
 */
export async function closeLeaveOfRetired(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<void> {
    for (const staff of await listRetiredStaff()) {
        if (!leaveCloseDue(staff.retiredAt, now)) continue;
        for (const leave of await pendingOrApprovedLeaveFor(staff._id)) {
            try {
                if (leave.status === "active") {
                    // Only leaving the server retires somebody who is on leave,
                    // and then there is nobody to give roles back to.
                    if (staff.retiredCause === "left_server") {
                        await endLeave(client, config, leave, {
                            kind: "retired",
                            reason: CLOSED_LEAVE_REASON
                        });
                    }
                } else {
                    await cancelLeave(client, config, leave, null, CLOSED_LEAVE_REASON);
                }
            } catch (error) {
                log.error(`Closing leave ${leave._id.toHexString()} on retirement failed`, error);
            }
        }
    }
}

async function apply(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    action: RetirementAction,
    now: Date
): Promise<void> {
    if (action.kind === "retire") {
        const retired = await retireStaff(staff._id, action.cause, now);
        if (retired) await closeShift(client, config, retired, now);
    } else if (action.kind === "return") {
        await returnStaff(staff, now);
    }
}

/**
 * Apply one member event. Stands down when the role settings cannot be trusted,
 * because a deleted role fires an update for everybody who wore it.
 */
export async function applyLiveReading(
    client: Client,
    config: StaffBotConfig,
    guild: Guild,
    staff: StaffDoc,
    member: GuildMember | null,
    now = new Date()
): Promise<void> {
    const problem = staffRolesProblem(config, new Set(guild.roles.cache.keys()));
    if (problem) {
        log.warn(`Not updating who is on the team from a member event: ${problem}`);
        return;
    }
    const reading: MemberReading = member
        ? { kind: "present", hasTier: false }
        : { kind: "absent" };
    await apply(client, config, staff, await decide(config, staff, reading, member, now), now);
}

/**
 * Check every record against Discord. Decides the whole roster before writing
 * anything, so a sweep that stops has changed nothing. `pastThreshold` is an
 * administrator confirming the list; it never overrides untrustworthy roles.
 */
export async function runRetirementSweep(
    client: Client,
    config: StaffBotConfig,
    options: { pastThreshold?: boolean } = {},
    now = new Date()
): Promise<SweepOutcome> {
    const plan = await planRetirementSweep(client, config, now);
    if (plan.block?.kind === "roles") {
        lastBlock = plan.block;
        log.error(`Not updating who is on the team: ${plan.block.reason}`);
        return { retired: 0, returned: 0, block: plan.block };
    }

    // Coming back is safe whatever is wrong with the retirements.
    for (const staff of plan.returning) await apply(client, config, staff, { kind: "return" }, now);

    if (plan.block && !options.pastThreshold) {
        lastBlock = plan.block;
        log.error(
            `Not retiring ${plan.retiring.length} of ${plan.block.roster} staff at once. ` +
                "That looks like a fault; /dev status lists them and can confirm it."
        );
        return { retired: 0, returned: plan.returning.length, block: plan.block };
    }

    for (const { staff, action } of plan.retiring) await apply(client, config, staff, action, now);

    // Finishes anything a failure left behind on an earlier retirement.
    for (const staff of await listRetiredStaff()) await closeShift(client, config, staff, now);

    lastBlock = null;
    log.info(
        `Who is on the team: ${plan.retiring.length} retired, ${plan.returning.length} returned.`
    );
    return { retired: plan.retiring.length, returned: plan.returning.length, block: null };
}

export async function planRetirementSweep(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<{
    block: SweepBlock | null;
    retiring: { staff: StaffDoc; action: RetirementAction }[];
    returning: StaffDoc[];
}> {
    const guild = await client.guilds.fetch(config.publicGuildId);
    const problem = staffRolesProblem(config, new Set((await guild.roles.fetch()).keys()));
    if (problem) {
        return { block: { kind: "roles", reason: problem }, retiring: [], returning: [] };
    }

    const everyone = await listAllStaff();
    const retiring: { staff: StaffDoc; action: RetirementAction }[] = [];
    const returning: StaffDoc[] = [];
    for (const staff of everyone) {
        const read = await readMember(client, guild.id, staff.discordId);
        const member = read.kind === "present" ? read.member : null;
        const reading: MemberReading =
            read.kind === "present" ? { kind: "present", hasTier: false } : read;
        const action = await decide(config, staff, reading, member, now);
        if (action.kind === "retire") retiring.push({ staff, action });
        if (action.kind === "return") returning.push(staff);
    }

    const roster = everyone.filter(
        (staff) => staff.active && !isBootstrapAdmin(staff.discordId)
    ).length;
    return {
        block: sweepOverThreshold(retiring.length, roster)
            ? {
                  kind: "threshold",
                  discordIds: retiring.map(({ staff }) => staff.discordId),
                  roster
              }
            : null,
        retiring,
        returning
    };
}
