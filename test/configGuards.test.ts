import { describe, expect, it } from "vitest";
import {
    anchorStatus,
    autoEndIsGenerous,
    configWarnings,
    historyChangeWarning,
    requirementIsReachable,
    rewritesHistory
} from "../src/config/configGuards.js";
import { DEFAULT_CONFIG, type StaffBotConfig } from "../src/config/guildConfig.js";

const config = (overrides: Partial<StaffBotConfig> = {}): StaffBotConfig => ({
    ...DEFAULT_CONFIG,
    ...overrides
});

describe("the fortnight anchor", () => {
    // Pacific/Auckland throughout, as the rest of the suite does: it has a DST
    // rule that catches 24-hour-day assumptions.
    const zone = "Pacific/Auckland";

    it("reports a cycle that has not started", () => {
        const status = anchorStatus(
            config({ fortnightAnchor: "2026-09-28T00:00:00Z", accountingTimezone: zone }),
            new Date("2026-09-02T00:00:00Z")
        );
        expect(status.reached).toBe(false);
    });

    it("reports a cycle that has", () => {
        const status = anchorStatus(
            config({ fortnightAnchor: "2026-01-05T00:00:00Z", accountingTimezone: zone }),
            new Date("2026-09-02T00:00:00Z")
        );
        expect(status.reached).toBe(true);
    });

    it("counts the anchor's own fortnight as reached", () => {
        // Fortnight 0 is assessable; the guard rejects negatives only, so the
        // week the anchor falls in must not read as "not started".
        const status = anchorStatus(
            config({ fortnightAnchor: "2026-09-07T00:00:00Z", accountingTimezone: zone }),
            new Date("2026-09-09T00:00:00Z")
        );
        expect(status.reached).toBe(true);
    });

    it("names when the first assessable fortnight closes", () => {
        const status = anchorStatus(
            config({ fortnightAnchor: "2026-09-28T00:00:00Z", accountingTimezone: zone }),
            new Date("2026-09-02T00:00:00Z")
        );
        // Two whole weeks after the anchor's week begins, and after the anchor.
        expect(status.firstAssessableCloses.getTime()).toBeGreaterThan(
            status.anchor.getTime()
        );
    });

    it("warns on the card when the cycle has not started", () => {
        const warnings = configWarnings(
            config({ fortnightAnchor: "2026-09-28T00:00:00Z" }),
            new Date("2026-09-02T00:00:00Z")
        );
        const anchor = warnings.find((warning) => warning.key === "fortnightAnchor");
        expect(anchor).toBeDefined();
        expect(anchor?.text).toContain("nobody is being assessed");
    });

    it("says nothing once the cycle is running", () => {
        const warnings = configWarnings(
            config({ fortnightAnchor: "2026-01-05T00:00:00Z" }),
            new Date("2026-09-02T00:00:00Z")
        );
        expect(warnings.some((warning) => warning.key === "fortnightAnchor")).toBe(false);
    });
});

describe("a requirement nobody can reach", () => {
    it("accepts a fortnight requirement of exactly two weekly targets", () => {
        expect(
            requirementIsReachable(
                config({ weeklyTargetMinutes: 120, fortnightRequiredMinutes: 240 })
            )
        ).toBe(true);
    });

    it("rejects one minute more than that", () => {
        expect(
            requirementIsReachable(
                config({ weeklyTargetMinutes: 120, fortnightRequiredMinutes: 241 })
            )
        ).toBe(false);
    });

    it("accepts a requirement below the doubled target", () => {
        expect(
            requirementIsReachable(
                config({ weeklyTargetMinutes: 120, fortnightRequiredMinutes: 100 })
            )
        ).toBe(true);
    });

    it("explains the arithmetic rather than just refusing", () => {
        const warnings = configWarnings(
            config({
                weeklyTargetMinutes: 120,
                fortnightRequiredMinutes: 500,
                fortnightAnchor: "2026-01-05T00:00:00Z"
            }),
            new Date("2026-09-02T00:00:00Z")
        );
        const text = warnings.find(
            (warning) => warning.key === "fortnightRequiredMinutes"
        )?.text;
        expect(text).toContain("500");
        expect(text).toContain("240"); // what closing both rings actually earns
    });

    it("ships a default that is reachable", () => {
        expect(requirementIsReachable(DEFAULT_CONFIG)).toBe(true);
    });
});

describe("a shift that ends before the member is marked Away", () => {
    it("accepts an auto-end equal to the away threshold", () => {
        expect(
            autoEndIsGenerous(config({ awayAfterMinutes: 20, autoEndAfterAwayMinutes: 20 }))
        ).toBe(true);
    });

    it("rejects an auto-end shorter than it", () => {
        expect(
            autoEndIsGenerous(config({ awayAfterMinutes: 20, autoEndAfterAwayMinutes: 5 }))
        ).toBe(false);
    });

    it("ships a default that is generous", () => {
        expect(autoEndIsGenerous(DEFAULT_CONFIG)).toBe(true);
    });
});

describe("keys that rewrite history", () => {
    it("names the two that move every boundary ever recorded", () => {
        expect(rewritesHistory("weekStartDay")).toBe(true);
        expect(rewritesHistory("accountingTimezone")).toBe(true);
    });

    it("leaves every other key applying immediately", () => {
        for (const key of [
            "weeklyTargetMinutes",
            "fortnightRequiredMinutes",
            "fortnightAnchor",
            "trackedChannels",
            "executiveRoles"
        ] as (keyof StaffBotConfig)[]) {
            expect(rewritesHistory(key)).toBe(false);
        }
    });

    it("says how much is already stored against the old boundaries", () => {
        const text = historyChangeWarning({
            key: "accountingTimezone",
            currentValue: "UTC",
            newValue: "Pacific/Auckland",
            weeklyStats: 42,
            assessments: 7
        });
        expect(text).toContain("42 weekly rollups");
        expect(text).toContain("7 fortnight assessments");
        expect(text).toContain("UTC");
        expect(text).toContain("Pacific/Auckland");
    });

    it("says a fresh deployment is free to change", () => {
        const text = historyChangeWarning({
            key: "weekStartDay",
            currentValue: "1",
            newValue: "0",
            weeklyStats: 0,
            assessments: 0
        });
        expect(text).toContain("Nothing is stored yet");
    });

    it("gets the singular right for one record", () => {
        const text = historyChangeWarning({
            key: "weekStartDay",
            currentValue: "1",
            newValue: "0",
            weeklyStats: 1,
            assessments: 1
        });
        expect(text).toContain("1 weekly rollup**");
        expect(text).toContain("1 fortnight assessment**");
    });
});

describe("the warnings as a set", () => {
    it("is empty for a sensibly configured, running deployment", () => {
        expect(
            configWarnings(
                config({ fortnightAnchor: "2026-01-05T00:00:00Z" }),
                new Date("2026-09-02T00:00:00Z")
            )
        ).toEqual([]);
    });

    it("reports every problem at once rather than one at a time", () => {
        const warnings = configWarnings(
            config({
                fortnightAnchor: "2099-01-01T00:00:00Z",
                weeklyTargetMinutes: 60,
                fortnightRequiredMinutes: 500,
                awayAfterMinutes: 20,
                autoEndAfterAwayMinutes: 1
            }),
            new Date("2026-09-02T00:00:00Z")
        );
        expect(warnings.map((warning) => warning.key)).toEqual([
            "fortnightAnchor",
            "fortnightRequiredMinutes",
            "autoEndAfterAwayMinutes"
        ]);
    });
});
