import { describe, expect, it } from "vitest";
import { RECRUITING_REGIONS, regionsInEvening } from "../src/time/regions.js";
import { isValidTimezone } from "../src/time/timezones.js";

/**
 * The recruitment brief under each coverage gap. Instants are fixed and in UTC;
 * the regions carry their own daylight saving, which the September instant
 * below catches: New Zealand is on NZDT (+13), Eastern Australia still on AEST
 * (+10) until October.
 */

describe("the regions a brief can name", () => {
    it("are all real zones this runtime can format", () => {
        for (const region of RECRUITING_REGIONS) {
            expect(isValidTimezone(region.zone), region.zone).toBe(true);
        }
    });

    it("are places people live, labelled as places, never IANA identifiers", () => {
        for (const region of RECRUITING_REGIONS) {
            expect(region.label).not.toContain("/");
            expect(region.label).not.toMatch(/Antarctica/);
        }
    });

    it("leave no hour of the day without somebody in their evening, in either summer", () => {
        for (const day of ["2026-01-14", "2026-07-15"]) {
            for (let hour = 0; hour < 24; hour += 1) {
                const instant = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
                expect(regionsInEvening(instant).length, instant.toISOString()).toBeGreaterThan(0);
            }
        }
    });

    it("name Canada, which shares the US zones", () => {
        const labels = RECRUITING_REGIONS.map((region) => region.label).join(" ");
        expect(labels).toContain("Canada");
    });

    it("name each place once", () => {
        const labels = RECRUITING_REGIONS.map((region) => region.label);
        expect(new Set(labels).size).toBe(labels.length);
    });
});

describe("who is having their evening", () => {
    // 08:00 UTC, Wednesday 30 September 2026: 21:00 in New Zealand (NZDT),
    // 22:00 the evening before in Hawaiʻi, 18:00 in Eastern Australia (AEST),
    // 16:00 in Western Australia.
    const instant = new Date("2026-09-30T08:00:00Z");

    it("lists the regions between 18:00 and 23:00 local, with their local time", () => {
        expect(regionsInEvening(instant)).toEqual([
            { label: "New Zealand", localTime: "21:00" },
            { label: "Hawaiʻi", localTime: "22:00" },
            { label: "Eastern Australia", localTime: "18:00" }
        ]);
    });

    it("puts the one nearest mid-evening first, not the one first in the alphabet", () => {
        // 15:00 UTC: 20:30 in India, 20:00 in Pakistan, 17:00 in Central Europe
        // and South Africa (out), 23:00 in Singapore (out).
        const labels = regionsInEvening(new Date("2026-09-30T15:00:00Z")).map(
            (region) => region.label
        );
        expect(labels).toEqual(["India", "Pakistan"]);
    });

    it("shows a half-hour zone at its real minute", () => {
        const india = regionsInEvening(new Date("2026-09-30T15:00:00Z")).find(
            (region) => region.label === "India"
        );
        expect(india?.localTime).toBe("20:30");
    });

    it("stops at 23:00, which the card calls the end of the evening", () => {
        const regions = [{ label: "Somewhere", zone: "UTC" }];
        expect(regionsInEvening(new Date("2026-09-30T22:59:00Z"), regions)).toHaveLength(1);
        expect(regionsInEvening(new Date("2026-09-30T23:00:00Z"), regions)).toHaveLength(0);
        expect(regionsInEvening(new Date("2026-09-30T17:59:00Z"), regions)).toHaveLength(0);
    });

    it("keeps the brief short", () => {
        expect(regionsInEvening(new Date("2026-09-30T15:00:00Z")).length).toBeLessThanOrEqual(5);
    });
});
