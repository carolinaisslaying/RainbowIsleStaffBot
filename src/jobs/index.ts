import type { Client } from "discord.js";
import { loadConfig, type StaffBotConfig } from "../config/guildConfig.js";
import { everyHour, everyMinute, schedule, startScheduler } from "./scheduler.js";
import { sweepShifts } from "../services/shiftService.js";
import { processLeaveTransitions } from "../services/leaveService.js";
import { deliverDueRecaps } from "../services/notifications.js";
import { chaseUnworkedQueues } from "../services/assessmentService.js";
import { pruneActivityCache, recomputeCounts } from "../domain/activity.js";
import { closeWeek, catchUpMissedWeeks } from "./weeklyRollup.js";
import { nextWeekStart, weekStartFor, wallClockIn, zonedToUtc } from "../time/calendar.js";
import { log } from "../log.js";

/**
 * Week close runs at 00:05 in the accounting timezone, five minutes after the
 * boundary, so a message posted at 23:59:59 has certainly been written before
 * the rollup reads it.
 */
function nextWeekClose(config: StaffBotConfig): (from: Date) => Date {
    return (from: Date) => {
        const zone = config.accountingTimezone;
        const currentWeek = weekStartFor(from, zone, config.weekStartDay);
        const thisWeekClose = offsetMinutes(currentWeek, 5, zone);
        if (thisWeekClose > from) return thisWeekClose;
        return offsetMinutes(nextWeekStart(currentWeek, zone, config.weekStartDay), 5, zone);
    };
}

/** Add whole minutes to a week start, staying on the local wall clock. */
function offsetMinutes(weekStart: Date, minutes: number, zone: string): Date {
    const wall = wallClockIn(weekStart, zone);
    return zonedToUtc(
        {
            year: wall.year,
            month: wall.month,
            day: wall.day,
            hour: wall.hour,
            minute: wall.minute + minutes
        },
        zone
    );
}

export async function registerJobs(client: Client): Promise<void> {
    const config = await loadConfig();

    // Away detection, auto end and the hard shift ceiling.
    schedule("shift-sweep", everyMinute, async (at) => {
        await sweepShifts(client, await loadConfig(), at);
    });

    // Leave activation and return.
    //
    // Every minute rather than every hour, because leave now carries a time of
    // day: a member due back at 09:00 should have their ranks at 09:00 and not
    // whenever the next hour came round. The sweep is date driven and
    // idempotent, so a missed run still self-heals, and it costs two indexed
    // queries when nothing is due.
    schedule("leave-transitions", everyMinute, async (at) => {
        await processLeaveTransitions(client, await loadConfig(), at);
    });

    // Recaps are held until each recipient's local 09:00, so this must tick
    // every hour rather than once a week.
    schedule("recaps", everyHour, async (at) => {
        const sent = await deliverDueRecaps(client, await loadConfig(), at);
        if (sent > 0) log.info(`Delivered ${sent} weekly recaps`);
        pruneActivityCache(at);
    });

    // Week close: rebuild the closing week, then assess if it completed a
    // fortnight.
    schedule("week-close", nextWeekClose(config), async (at) => {
        await closeWeek(client, await loadConfig(), at);
    });

    // Nightly popcount recompute. The hot path treats count as advisory
    // precisely so this job is what makes it true.
    schedule(
        "count-recompute",
        (from) => {
            const next = new Date(from);
            next.setUTCHours(3, 20, 0, 0);
            if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
            return next;
        },
        async () => {
            const result = await recomputeCounts();
            log.info(
                `Popcount recompute: ${result.scanned} scanned, ${result.corrected} corrected`
            );
        }
    );

    // The review queue's one reminder. Hourly rather than by the minute: it is
    // measured in days and firing it late by an hour costs nothing.
    schedule("review-reminders", everyHour, async (at) => {
        const sent = await chaseUnworkedQueues(client, await loadConfig(), at);
        if (sent > 0) log.info(`Chased ${sent} unworked review queue(s)`);
    });

    startScheduler();

    // Reconcile missed runs on boot, since the container will have restarted.
    await catchUpMissedWeeks(client, config);
    await processLeaveTransitions(client, config);
}
