import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { ShiftDoc, ShiftEndReason, StaffDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { addRole, fetchMember, removeRole, tryDm } from "../discord/roles.js";
import {
    endShift,
    getOpenShift,
    listOpenShifts,
    openPauseOf,
    pauseShift,
    resumeShift,
    startShift,
    stateOf
} from "../domain/shifts.js";
import { activeLeaveFor } from "../domain/leave.js";
import { currentWeekStats, leaveNoteFor, weekWindowFor } from "../domain/weekly.js";
import { computeStreak } from "../domain/weekly.js";
import { findStaffById } from "../domain/staff.js";
import { noticeCard, ringCard, shiftSummaryCard, type RenderedMessage } from "../render/cards.js";
import { audit } from "../domain/audit.js";
import { log } from "../log.js";
import { formatDuration, ts } from "../time/format.js";
import { EMOJI } from "../render/emoji.js";
import { COLOUR } from "../render/theme.js";
import { publicGuildName } from "../discord/guildNames.js";
import { cmd } from "../discord/commandMentions.js";
import { staffDisplayName } from "../discord/displayName.js";

/**
 * Shift orchestration: the state machine plus the role, DM and card effects
 * that go with each transition. The machine itself stays in domain/shifts.ts
 * and knows nothing about Discord.
 */

const REASON_LABEL: Record<ShiftEndReason, string> = {
    manual: "you ended it",
    max_duration: "maximum shift length reached",
    auto_ended_away: "away too long",
    leave_started: "leave began",
    reconciled: "reconciled on restart",
    terminated: "an Executive ended it"
};

/** Somebody other than the member ending their shift: `/shift terminate`. */
export interface EndedBy {
    discordId: string;
    name: string;
    reason?: string;
}

function reasonLabelFor(reason: ShiftEndReason, endedBy?: EndedBy): string {
    return endedBy ? `${endedBy.name} ended it` : REASON_LABEL[reason];
}

/** Last message timestamp per staff member, for the inactivity sweep. */
const lastSeen = new Map<string, number>();

export function markSeen(staffId: ObjectId, at = new Date()): void {
    lastSeen.set(staffId.toHexString(), at.getTime());
}

export function lastSeenAt(staffId: ObjectId): number | undefined {
    return lastSeen.get(staffId.toHexString());
}

export function clearSeen(staffId: ObjectId): void {
    lastSeen.delete(staffId.toHexString());
}

async function ringCardFor(
    staff: StaffDoc,
    displayName: string,
    config: StaffBotConfig,
    heading?: string,
    now = new Date()
): Promise<RenderedMessage> {
    const window = weekWindowFor(now, config);
    const stats = await currentWeekStats(staff._id, config, now);
    const streak = await computeStreak(staff._id, config, now);
    return ringCard({
        staffId: staff._id.toHexString(),
        displayName,
        weekStart: window.start,
        weekEnd: window.end,
        activityMinutes: stats.activityMinutes,
        activityTarget: config.weeklyTargetMinutes,
        shiftMs: stats.shiftMs,
        shiftTargetHours: config.weeklyShiftTargetHours,
        activeDays: stats.activeDays,
        activeDaysTarget: config.weeklyActiveDaysTarget,
        state: stats.ringState,
        softRingsEnabled: config.softRingsEnabled,
        face: staff.ringFace,
        streak,
        heading,
        footnote: leaveNoteFor(stats, config.minimumLeaveDays)
    });
}

/**
 * When an away shift will close itself. Falls back to the shift start for a
 * shift with no open pause, which the caller never asks about.
 */
function awayDeadline(shift: ShiftDoc, config: StaffBotConfig): Date {
    const from = openPauseOf(shift)?.from ?? shift.startedAt;
    return new Date(from.getTime() + config.autoEndAfterAwayMinutes * 60_000);
}

export interface StartResult {
    ok: boolean;
    card: RenderedMessage;
}

/**
 * What somebody is told when they are already on shift.
 *
 * Two callers now: the check before the insert, and the insert losing the race
 * to itself. Both are the same fact about the same member, so both say it the
 * same way.
 */
function alreadyOnShiftCard(
    open: ShiftDoc,
    config: StaffBotConfig,
    guildId?: string | null
): RenderedMessage {
    return noticeCard(
        "You are already on shift",
        stateOf(open) === "away"
            ? `Your shift is open but marked away. Send a message in ${publicGuildName()}, ` +
              "or come back online, and you will be available again.\n\n" +
              `It ends itself ${ts(awayDeadline(open, config), "R")} if you stay away.`
            : `Use ${cmd("shift end", guildId)} when you are finished.`,
        { ephemeral: true }
    );
}

export async function beginShift(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    displayName: string,
    /**
     * Where the reply will be read. A command mention carries the id of one
     * registration, and the staff server's ids and the direct message ones are
     * different: send the wrong one and Discord renders the chip as flat text.
     */
    guildId?: string | null
): Promise<StartResult> {
    const existing = await getOpenShift(staff._id);
    if (existing) return { ok: false, card: alreadyOnShiftCard(existing, config, guildId) };

    const leave = await activeLeaveFor(staff._id);
    if (leave) {
        return {
            ok: false,
            card: noticeCard(
                "You are on leave",
                "Shifts are unavailable while your leave is active. Ask an Executive to end " +
                    `your leave, or use ${cmd("leave end", guildId)} if you are back early.`,
                { ephemeral: true }
            )
        };
    }

    let shift: ShiftDoc;
    try {
        shift = await startShift(staff._id);
    } catch (error) {
        // The unique partial index on open shifts refused it, which means one
        // already exists: two clicks landed either side of the read above. The
        // second is answered with the truth rather than with a failure card,
        // because from the member's side they are on shift and that is what
        // they were trying to be.
        const raced = await getOpenShift(staff._id);
        if (!raced) throw error;
        log.debug(`Second concurrent /shift start for ${staff._id.toHexString()}`, error);
        return { ok: false, card: alreadyOnShiftCard(raced, config, guildId) };
    }
    markSeen(staff._id);

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    if (member) {
        await addRole(member, config.availabilityRole, "Shift started", staff._id);
    }

    await audit("shift.start", {
        actorId: staff.discordId,
        targetStaffId: staff._id,
        detail: { shiftId: shift._id.toHexString() }
    });

    return {
        ok: true,
        card: await ringCardFor(staff, displayName, config, "### Shift started")
    };
}

/**
 * Enter Away. Removes the availability role, opens a pause, stops crediting.
 * DMs the member. Logs nothing as a fault and notifies nobody else.
 */
export async function goAway(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    shift: ShiftDoc,
    cause: "presence" | "inactivity",
    at = new Date()
): Promise<boolean> {
    const paused = await pauseShift(shift._id, cause, at);
    if (!paused) return false;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    if (member) {
        await removeRole(member, config.availabilityRole, "Marked away", staff._id);
    }

    const why =
        cause === "presence"
            ? "your Discord status went idle or offline"
            : `you have not posted in ${publicGuildName()} for ${config.awayAfterMinutes} minutes`;

    // The auto-end is the part people are surprised by, so it is stated up
    // front with the moment it happens, not buried as a policy note.
    const autoEndAt = new Date(at.getTime() + config.autoEndAfterAwayMinutes * 60_000);

    await tryDm(client, staff.discordId, {
        ...noticeCard(
            `Marked away`,
            `Your shift is still open, but ${why}, so you have stopped showing as available ` +
                "and your minutes have paused.\n\n" +
                `Send a message in ${publicGuildName()}, or come back online, and you are ` +
                "available again. You do not need to do anything else.\n\n" +
                `**If you stay away, your shift ends itself ${ts(autoEndAt, "R")}**, at ` +
                `${ts(autoEndAt, "t")}. That is ${config.autoEndAfterAwayMinutes} minutes from ` +
                "now. Nothing is lost: minutes you have earned stay counted.",
            { colour: COLOUR.away, emoji: EMOJI.away }
        )
    });

    log.debug(`Shift ${shift._id.toHexString()} paused (${cause})`);
    return true;
}

/** Return to Available. No confirmation is required from the member. */
export async function comeBack(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    shift: ShiftDoc,
    at = new Date()
): Promise<boolean> {
    const resumed = await resumeShift(shift._id, at);
    if (!resumed) return false;

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    if (member) {
        await addRole(member, config.availabilityRole, "Back from away", staff._id);
    }

    await tryDm(client, staff.discordId, {
        ...noticeCard(
            "Welcome back",
            "You are available again and your availability role is back. Minutes are counting.",
            { colour: COLOUR.onShift, emoji: EMOJI.welcome }
        )
    });

    return true;
}

export async function finishShift(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    displayName: string,
    reason: ShiftEndReason,
    at = new Date(),
    endedBy?: EndedBy
): Promise<RenderedMessage | null> {
    const open = await getOpenShift(staff._id);
    if (!open) return null;

    const closed = await endShift(open._id, reason, at);
    if (!closed) return null;

    clearSeen(staff._id);

    const member = await fetchMember(client, config.publicGuildId, staff.discordId);
    if (member) {
        await removeRole(member, config.availabilityRole, `Shift ended: ${reason}`, staff._id);
    }

    await audit("shift.end", {
        actorId: endedBy?.discordId ?? staff.discordId,
        targetStaffId: staff._id,
        detail: {
            shiftId: open._id.toHexString(),
            reason,
            ...(endedBy?.reason ? { reasonGiven: endedBy.reason } : {}),
            availableMs: closed.availableMs,
            activityMinutes: closed.activityMinutes
        }
    });

    const window = weekWindowFor(at, config);
    const stats = await currentWeekStats(staff._id, config, at);
    const streak = await computeStreak(staff._id, config, at);

    return shiftSummaryCard({
        staffId: staff._id.toHexString(),
        displayName,
        weekStart: window.start,
        weekEnd: window.end,
        activityMinutes: stats.activityMinutes,
        activityTarget: config.weeklyTargetMinutes,
        shiftMs: stats.shiftMs,
        shiftTargetHours: config.weeklyShiftTargetHours,
        activeDays: stats.activeDays,
        activeDaysTarget: config.weeklyActiveDaysTarget,
        state: stats.ringState,
        softRingsEnabled: config.softRingsEnabled,
        face: staff.ringFace,
        streak,
        durationMs: closed.durationMs,
        pausedMs: closed.pausedMs,
        earnedMinutes: closed.activityMinutes,
        reasonLabel: reasonLabelFor(reason, endedBy),
        reasonGiven: endedBy?.reason,
        startedAt: open.startedAt,
        endedAt: at
    });
}

/**
 * Close a shift and DM the summary, for every end the member did not ask for:
 * the automatic reasons, and an Executive's `/shift terminate`. Answers whether
 * the DM arrived, or null when there was no open shift to close.
 */
export async function autoFinishShift(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    reason: ShiftEndReason,
    at = new Date(),
    endedBy?: EndedBy
): Promise<boolean | null> {
    const staff = await findStaffById(staffId);
    if (!staff) return null;

    const displayName = await staffDisplayName(client, config, staff.discordId, "You");

    // Closing the shift and telling them about it are two jobs, and the second
    // must not be able to cancel the first.
    //
    // `finishShift` closes the shift before it builds the summary, and anything
    // that threw after that point — a stats query, the streak, rendering the
    // rings — propagated out and left a shift ended in the database with the
    // member never told. From their side the bot simply went quiet past the
    // auto-end time. So the card is built defensively and a plain sentence goes
    // out when it cannot be, because "your shift ended" is the part that
    // matters and it needs no PNG.
    let card: RenderedMessage | null = null;
    try {
        card = await finishShift(client, config, staff, displayName, reason, at, endedBy);
        if (card === null) return null; // there was no open shift; nothing happened
    } catch (error) {
        log.error(
            `Closing shift for ${staff._id.toHexString()} raised after the shift was ended; ` +
                "sending the plain notice instead",
            error
        );
    }

    return tryDm(
        client,
        staff.discordId,
        card ? { ...card } : { ...plainShiftEndCard(reason, at, endedBy) }
    );
}

/**
 * The fallback the member gets when the summary card could not be built.
 *
 * It says the one thing they need to know and nothing it has to compute, so
 * there is nothing left in it that can fail.
 */
function plainShiftEndCard(reason: ShiftEndReason, at: Date, endedBy?: EndedBy): RenderedMessage {
    return noticeCard(
        "Your shift has ended",
        `${reasonLabelFor(reason, endedBy)}, ${ts(at, "R")}.\n` +
            (endedBy?.reason ? `Reason given: ${endedBy.reason}\n` : "") +
            "\n" +
            "Your minutes for it are counted. The summary card could not be drawn this time, " +
            `so use ${cmd("stats rings")} to see where the week stands.`,
        { colour: COLOUR.settled }
    );
}

/**
 * The periodic sweep. Runs every minute and applies the three time based
 * transitions: inactivity to Away, Away too long to Ended, and the hard
 * shift ceiling. Idempotent, so a missed tick costs nothing.
 */
export async function sweepShifts(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<void> {
    const open = await listOpenShifts();
    const awayMs = config.awayAfterMinutes * 60_000;
    const autoEndMs = config.autoEndAfterAwayMinutes * 60_000;
    const maxMs = config.maxShiftHours * 3_600_000;

    for (const shift of open) {
        try {
            if (now.getTime() - shift.startedAt.getTime() > maxMs) {
                await autoFinishShift(client, config, shift.staffId, "max_duration", now);
                continue;
            }

            const pause = openPauseOf(shift);
            if (pause) {
                if (now.getTime() - pause.from.getTime() > autoEndMs) {
                    await autoFinishShift(client, config, shift.staffId, "auto_ended_away", now);
                }
                continue;
            }

            // Available: has anything been heard from them lately?
            const seen = lastSeenAt(shift.staffId) ?? shift.startedAt.getTime();
            if (now.getTime() - seen > awayMs) {
                const staff = await findStaffById(shift.staffId);
                if (staff) await goAway(client, config, staff, shift, "inactivity", now);
            }
        } catch (error) {
            log.error(`Shift sweep failed for shift ${shift._id.toHexString()}`, error);
        }
    }
}

export { formatDuration };
