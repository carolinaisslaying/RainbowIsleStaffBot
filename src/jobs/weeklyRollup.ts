import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    hasNoWeeklyRollups,
    missingWeekWindows,
    previousWeekWindow,
    rebuildWeekForAll
} from "../domain/weekly.js";
import { assessFortnight, backfillPlan, closingFortnightIndex } from "../domain/assessments.js";
import { runFortnightAssessment } from "../services/assessmentService.js";
import { claimFortnightAnnouncement } from "../services/notifications.js";
import { log } from "../log.js";

/**
 * Week close. Rebuilds the week that just ended, then assesses if that week
 * completed a fortnight. Idempotent: rebuilding a week that is already correct
 * writes the same values, and assessing a fortnight twice refreshes the figures
 * without touching any review decision already recorded.
 */
export async function closeWeek(
    client: Client,
    config: StaffBotConfig,
    at = new Date()
): Promise<void> {
    const closing = previousWeekWindow(at, config);
    await rebuildWeekForAll(closing, config, at);
    log.info(`Closed week starting ${closing.start.toISOString()}`);

    const fortnightIndex = closingFortnightIndex(closing, config);
    if (fortnightIndex === null) {
        log.info("Week does not complete a fortnight; no assessment run.");
        return;
    }

    log.info(`Week completes fortnight ${fortnightIndex}; assessing.`);
    await runFortnightAssessment(client, config, fortnightIndex);
}

/**
 * Boot reconciliation for the scheduler: recompute weeklyStats for any
 * completed week missing a rollup, and run any assessment that was due while
 * the process was down.
 */
export async function catchUpMissedWeeks(
    client: Client,
    config: StaffBotConfig,
    lookbackWeeks = 8,
    at = new Date()
): Promise<void> {
    // Asked before anything is rebuilt, because rebuilding is what stops it
    // being true. A database with no rollups at all is a first boot, not eight
    // weeks of downtime, and the difference decides whether anyone is told.
    const coldStart = await hasNoWeeklyRollups();

    const missing = await missingWeekWindows(config, lookbackWeeks, at);
    if (missing.length === 0) {
        log.info("No missing weekly rollups.");
        return;
    }

    log.warn(
        `Rebuilding ${missing.length} missing weekly rollup(s)` +
            (coldStart ? " on a first boot; no reviews will be announced." : " after downtime.")
    );

    for (const window of missing) {
        // The rollup itself is always rebuilt. It is derived from raw activity
        // and shifts, so recomputing it writes the same numbers and tells
        // nobody anything.
        await rebuildWeekForAll(window, config, at);

        const fortnightIndex = closingFortnightIndex(window, config);
        if (fortnightIndex === null) continue;

        const plan = backfillPlan({
            coldStart,
            index: fortnightIndex,
            alreadyAnnounced: false
        });

        if (plan === "seed") {
            // Store the figures, then spend the fortnight's one announcement
            // without making it, so it is never announced later either.
            await assessFortnight(fortnightIndex, config);
            await claimFortnightAnnouncement(fortnightIndex);
            log.info(
                `Fortnight ${fortnightIndex} assessed on a first boot; nobody notified, ` +
                    "and it will not be announced later."
            );
            continue;
        }

        if (plan === "announce") {
            await runFortnightAssessment(client, config, fortnightIndex);
        }
    }
}
