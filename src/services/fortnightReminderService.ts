import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    computeAssessment,
    currentFortnightIndex,
    isAssessableFortnight,
    rulesFrom,
    windowForIndex
} from "../domain/assessments.js";
import {
    daysLeftTitle,
    fortnightReminderDue,
    fortnightReminderRefusal
} from "../domain/fortnightReminder.js";
import { activeLeaveFor, leaveOverlapping, pendingSpansOverlapping } from "../domain/leave.js";
import { weekLeave } from "../domain/leaveDays.js";
import { fetchPublicMember, tierOf, wearsOnLeaveRole } from "../domain/permissions.js";
import { ringStateFor } from "../domain/rings.js";
import { listActiveStaff } from "../domain/staff.js";
import { tryDm } from "../discord/roles.js";
import { claimFortnightReminder } from "./notifications.js";
import { fortnightReminderCard } from "../render/fortnightReminder.js";
import { localHourIn } from "../time/timezones.js";
import { log } from "../log.js";

/**
 * The heads up before a fortnight closes, at each member's own 09:00. A rehearsal
 * deployment sends none, because nothing it assesses reaches the member either.
 */
export async function deliverFortnightReminders(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<number> {
    if (config.assessmentDryRun) return 0;

    const index = currentFortnightIndex(config, now);
    if (!isAssessableFortnight(index)) return 0;
    const window = windowForIndex(index, config);
    const rules = rulesFrom(config);
    let sent = 0;

    for (const staff of await listActiveStaff()) {
        const zone = staff.timezone ?? config.accountingTimezone;
        if (!fortnightReminderDue(now, window.end, localHourIn(now, zone))) continue;

        try {
            const figures = await computeAssessment(staff._id, index, config, rules);
            const [member, leaveNow, counting, pending] = await Promise.all([
                fetchPublicMember(client, config, staff.discordId),
                activeLeaveFor(staff._id, now),
                leaveOverlapping(staff._id, window.week1Start, window.end),
                pendingSpansOverlapping(staff._id, window.week1Start, window.end)
            ]);
            const exemptWith = (start: Date, end: Date) =>
                weekLeave([...counting, ...pending], start, end, rules.minimumLeaveDays).exempt;

            const refusal = fortnightReminderRefusal({
                tier: tierOf(member, config),
                onLeaveNow: leaveNow !== null || wearsOnLeaveRole(member, config),
                status: figures.status,
                heldForLeave: figures.heldForLeave,
                pendingExemptsAWeek:
                    (exemptWith(window.week1Start, window.week2Start) && !figures.week1Exempt) ||
                    (exemptWith(window.week2Start, window.end) && !figures.week2Exempt)
            });
            if (refusal) {
                log.debug(`No fortnight reminder for ${staff._id.toHexString()}: ${refusal}`);
                continue;
            }

            if (!(await claimFortnightReminder(staff._id, index))) continue;

            const delivered = await tryDm(client, staff.discordId, {
                ...fortnightReminderCard({
                    title: daysLeftTitle(now, window.end),
                    closesAt: window.end,
                    minutes: figures.totalMinutes,
                    requiredMinutes: figures.requiredMinutes,
                    fullMinutes: rules.weeklyTargetMinutes * 2,
                    week1Minutes: figures.week1Minutes,
                    week2Minutes: figures.week2Minutes,
                    week1Exempt: figures.week1Exempt,
                    week2Exempt: figures.week2Exempt,
                    state: ringStateFor({
                        activityMinutes: figures.totalMinutes,
                        weeklyTargetMinutes: figures.requiredMinutes,
                        amberThresholdPercent: config.amberThresholdPercent,
                        onLeave: false
                    })
                })
            });
            if (delivered) sent += 1;
            else log.info(`Fortnight reminder for ${staff._id.toHexString()} could not be delivered`);
        } catch (error) {
            log.error(`Fortnight reminder failed for ${staff._id.toHexString()}`, error);
        }
    }
    return sent;
}
