import type { Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { tryDm } from "../discord/roles.js";
import { presenceStatusOf } from "../discord/presence.js";
import { publicGuildName } from "../discord/guildNames.js";
import { fetchPublicMember, tierOf } from "../domain/permissions.js";
import { isOffline } from "../domain/presence.js";
import { activeLeaveFor } from "../domain/leave.js";
import { getOpenShift } from "../domain/shifts.js";
import { claimShiftReminder } from "../domain/staff.js";
import {
    activityReached,
    cooldownElapsed,
    reminderRefusal,
    withinWindow
} from "../domain/shiftReminder.js";
import { shiftReminderCard } from "../render/shiftReminder.js";
import { log } from "../log.js";

/**
 * Off-shift message times per member, for the reminder in domain/shiftReminder.ts.
 *
 * Kept in memory, since it covers about half an hour: a restart costs a member
 * one window of counting at most. The cooldown has to survive a restart, so it
 * lives on the staff record.
 */
const offShiftMessages = new Map<string, number[]>();

/** A shift started, so messages from before it no longer count towards a reminder. */
export function forgetOffShiftActivity(staffId: ObjectId): void {
    offShiftMessages.delete(staffId.toHexString());
}

/**
 * Count one message in a tracked channel from a member with no shift open,
 * and DM them a reminder once the window holds enough of them.
 */
export async function noteOffShiftMessage(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    at: Date
): Promise<void> {
    const threshold = config.shiftReminderMessages;
    if (threshold <= 0) return;

    const key = staff._id.toHexString();
    const now = at.getTime();
    const windowMs = config.shiftReminderWindowMinutes * 60_000;
    const times = withinWindow([...(offShiftMessages.get(key) ?? []), now], now, windowMs)
        // Keep the newest `threshold` and drop the rest, so no list grows.
        .slice(-threshold);

    if (!activityReached(times.length, threshold)) {
        offShiftMessages.set(key, times);
        return;
    }

    // Reset whatever happens next. An Executive then costs one role lookup per
    // `threshold` messages instead of one per message.
    offShiftMessages.delete(key);

    const cooldownMs = config.shiftReminderCooldownHours * 3_600_000;
    // A cheap early answer from the cached record. The claim below decides.
    if (!cooldownElapsed(staff.lastShiftReminderAt, at, cooldownMs)) return;

    // Roles alone, as currentExecutives reads them: a seeded admin without an
    // Executive role counts as a Moderator here.
    const member = await fetchPublicMember(client, config, staff.discordId);
    const refusal = reminderRefusal({
        tier: tierOf(member, config),
        onLeave: (await activeLeaveFor(staff._id, at)) !== null,
        optedOut: staff.shiftReminderOptOut === true,
        onShift: (await getOpenShift(staff._id)) !== null
    });
    if (refusal) {
        log.debug(`No shift reminder for ${key}: ${refusal}`);
        return;
    }

    if (!(await claimShiftReminder(staff._id, at, cooldownMs))) return;

    const status = presenceStatusOf(client, config.publicGuildId, staff.discordId);
    const sent = await tryDm(client, staff.discordId, {
        ...shiftReminderCard({
            messages: times.length,
            windowMinutes: config.shiftReminderWindowMinutes,
            cooldownHours: config.shiftReminderCooldownHours,
            guildName: publicGuildName(),
            showingOffline: isOffline(status)
        })
    });
    log.info(`Shift reminder for ${key} ${sent ? "sent" : "could not be delivered"}`);
}
