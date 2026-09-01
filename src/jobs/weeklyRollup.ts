import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    missingWeekWindows,
    previousWeekWindow,
    rebuildWeekForAll
} from "../domain/weekly.js";
import { closingFortnightIndex } from "../domain/assessments.js";
import { runFortnightAssessment } from "../services/assessmentService.js";
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
    const missing = await missingWeekWindows(config, lookbackWeeks, at);
    if (missing.length === 0) {
        log.info("No missing weekly rollups.");
        return;
    }

    log.warn(`Rebuilding ${missing.length} missing weekly rollup(s) after downtime.`);
    for (const window of missing) {
        await rebuildWeekForAll(window, config, at);
        const fortnightIndex = closingFortnightIndex(window, config);
        if (fortnightIndex !== null) {
            await runFortnightAssessment(client, config, fortnightIndex);
        }
    }
}
