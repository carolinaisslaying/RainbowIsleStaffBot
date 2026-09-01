import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type StaffBotConfig } from "../src/config/guildConfig.js";
import {
    announcementPlan,
    backfillPlan,
    closingFortnightIndex,
    isAssessableFortnight
} from "../src/domain/assessments.js";
import { weekStartFor, nextWeekStart } from "../src/time/calendar.js";

/**
 * The guards that stopped a restart from announcing months of pre-history.
 *
 * A fresh deployment with the default anchor assessed fortnights -3 to -6 and
 * DMed every member about each of them. Three separate things had to be true
 * for that: fortnights before the anchor were assessable at all, an empty
 * database read as downtime, and nothing recorded that a fortnight had already
 * been announced. Each is held here.
 */

const config: StaffBotConfig = { ...DEFAULT_CONFIG, accountingTimezone: "Pacific/Auckland" };

/** The week window whose close completes the given fortnight. */
function weekClosing(weeksAgo: number): { start: Date; end: Date } {
    const now = new Date("2026-09-02T20:38:00Z");
    const current = weekStartFor(now, config.accountingTimezone, config.weekStartDay);
    const start = new Date(current.getTime() - weeksAgo * 7 * 86_400_000);
    const aligned = weekStartFor(start, config.accountingTimezone, config.weekStartDay);
    return {
        start: aligned,
        end: nextWeekStart(aligned, config.accountingTimezone, config.weekStartDay)
    };
}

describe("a fortnight before the anchor is not a fortnight", () => {
    it("refuses a negative index", () => {
        // The anchor is the origin the cycle counts from. Counting backwards
        // past it produces windows that predate the deployment, which is how
        // three members came to be assessed at 0 of 240 for last July.
        expect(isAssessableFortnight(-6)).toBe(false);
        expect(isAssessableFortnight(-1)).toBe(false);
    });

    it("accepts the anchor's own fortnight and everything after it", () => {
        expect(isAssessableFortnight(0)).toBe(true);
        expect(isAssessableFortnight(7)).toBe(true);
    });

    it("closes no fortnight for a week that predates the anchor", () => {
        // Every one of these produced a review card on the last restart.
        for (const weeksAgo of [1, 2, 3, 4, 5, 6, 7, 8]) {
            expect(closingFortnightIndex(weekClosing(weeksAgo), config)).toBeNull();
        }
    });
});

describe("what a boot backfill may announce", () => {
    it("says nothing about a fortnight before the anchor", () => {
        expect(backfillPlan({ coldStart: false, index: -6, alreadyAnnounced: false })).toBe(
            "skip"
        );
    });

    it("seeds without announcing when the database was empty", () => {
        // No rollups at all is a first boot, not eight weeks of downtime. The
        // receipt is written so the fortnight is never announced later either.
        expect(backfillPlan({ coldStart: true, index: 3, alreadyAnnounced: false })).toBe("seed");
    });

    it("announces a fortnight genuinely missed while the process was down", () => {
        expect(backfillPlan({ coldStart: false, index: 3, alreadyAnnounced: false })).toBe(
            "announce"
        );
    });

    it("never announces the same fortnight twice", () => {
        expect(backfillPlan({ coldStart: false, index: 3, alreadyAnnounced: true })).toBe("skip");
        expect(backfillPlan({ coldStart: true, index: 3, alreadyAnnounced: true })).toBe("skip");
    });
});

describe("what a run of the assessment may send", () => {
    it("stays silent on a fortnight that predates the anchor", () => {
        expect(
            announcementPlan({ index: -6, dryRun: false, alreadyAnnounced: false })
        ).toBe("silent");
    });

    it("rehearses without sending when the dry run is on", () => {
        // A rehearsal posts the card so it can be read, and DMs nobody. It also
        // writes no receipt, so switching the dry run off later still announces
        // the fortnight properly once.
        expect(announcementPlan({ index: 3, dryRun: true, alreadyAnnounced: false })).toBe(
            "rehearse"
        );
        expect(announcementPlan({ index: 3, dryRun: true, alreadyAnnounced: true })).toBe(
            "rehearse"
        );
    });

    it("announces once and then goes quiet", () => {
        expect(announcementPlan({ index: 3, dryRun: false, alreadyAnnounced: false })).toBe(
            "announce"
        );
        expect(announcementPlan({ index: 3, dryRun: false, alreadyAnnounced: true })).toBe(
            "silent"
        );
    });
});
