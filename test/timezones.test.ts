import { describe, expect, it } from "vitest";
import {
    canonicaliseTimezone,
    describeZone,
    isValidTimezone,
    searchTimezones,
    zoneAbbreviation,
    zoneOffsetLabel,
    zoneWallClock
} from "../src/time/timezones.js";

describe("validation", () => {
    it("accepts a canonical zone", () => {
        expect(isValidTimezone("Pacific/Auckland")).toBe(true);
    });

    it("accepts an alias whichever way this runtime's ICU spells it", () => {
        // Older ICU lists Asia/Calcutta, newer lists Asia/Kolkata. Both must be
        // accepted, or half of all runtimes reject a real member's zone.
        expect(isValidTimezone("Asia/Kolkata")).toBe(true);
        expect(isValidTimezone("Asia/Calcutta")).toBe(true);
        expect(canonicaliseTimezone("Asia/Kolkata")).toBe(canonicaliseTimezone("Asia/Calcutta"));
    });

    it("accepts a renamed zone", () => {
        expect(isValidTimezone("Europe/Kyiv")).toBe(true);
    });

    it("is case insensitive and canonicalises the spelling", () => {
        expect(canonicaliseTimezone("pacific/auckland")).toBe("Pacific/Auckland");
    });

    it("rejects fixed offsets, which carry no daylight saving rules", () => {
        for (const bad of ["UTC+13", "GMT-5", "+13", "-05:30", "utc+1"]) {
            expect(isValidTimezone(bad)).toBe(false);
        }
    });

    it("rejects nonsense without throwing", () => {
        for (const bad of ["", "   ", "Mars/Olympus", "NZST"]) {
            expect(isValidTimezone(bad)).toBe(false);
        }
    });
});

describe("search without needing a city", () => {
    const at = new Date("2026-07-15T00:00:00Z"); // NZ winter, US summer

    it("finds a zone by its current abbreviation", () => {
        expect(searchTimezones("NZST", 25, at)).toContain("Pacific/Auckland");
    });

    it("finds a zone by the other half of its daylight saving pair", () => {
        // NZDT is not current in July, but someone typing it still means Auckland.
        expect(searchTimezones("NZDT", 25, at)).toContain("Pacific/Auckland");
    });

    it("ranks the zone people live in above the technically correct one", () => {
        const results = searchTimezones("NZST", 25, at);
        expect(results[0]).toBe("Pacific/Auckland");
        expect(results).toContain("Antarctica/McMurdo");
    });

    it("finds a zone by UTC offset", () => {
        expect(searchTimezones("+12", 25, at).length).toBeGreaterThan(0);
        expect(searchTimezones("+05:30", 25, at).length).toBeGreaterThan(0);
    });

    it("still finds a zone by name or region", () => {
        expect(searchTimezones("auckland", 25, at)).toEqual(["Pacific/Auckland"]);
        expect(searchTimezones("europe", 25, at)[0]).toMatch(/^Europe\//);
    });

    it("offers common zones when nothing has been typed", () => {
        const results = searchTimezones("", 25, at);
        expect(results[0]).toBe("Pacific/Auckland");
        expect(results.length).toBeGreaterThan(5);
    });

    it("never exceeds Discord's 25 choice limit", () => {
        expect(searchTimezones("a", 25, at).length).toBeLessThanOrEqual(25);
    });
});

describe("picker rows", () => {
    const at = new Date("2026-07-15T00:00:00Z");

    it("shows the code, the offset and the local clock", () => {
        const row = describeZone("Pacific/Auckland", at);
        expect(row).toContain("Pacific/Auckland");
        expect(row).toContain("NZST");
        expect(row).toContain("UTC+12:00");
    });

    it("falls back to the offset for a zone with no abbreviation in use", () => {
        // Tokyo has no lettered abbreviation in common use in any ICU locale.
        expect(zoneAbbreviation("Asia/Tokyo", at)).toBe("");
        expect(describeZone("Asia/Tokyo", at)).toContain("UTC+09:00");
    });

    it("stays inside Discord's 100 character choice name limit", () => {
        for (const zone of ["Pacific/Auckland", "America/Argentina/ComodRivadavia", "UTC"]) {
            if (!isValidTimezone(zone)) continue;
            expect(describeZone(zone, at).length).toBeLessThanOrEqual(100);
        }
    });

    it("signs and pads the offset", () => {
        expect(zoneOffsetLabel("Pacific/Auckland", at)).toBe("UTC+12:00");
        expect(zoneOffsetLabel("UTC", at)).toBe("UTC+00:00");
    });
});

describe("zone confirmation must be able to fail", () => {
    const at = new Date("2026-09-01T03:21:00Z");

    it("renders the instant as seen from the chosen zone, not the reader's", () => {
        // The whole point: a wrong pick must look wrong. Discord timestamp
        // markup renders in the reader's timezone and would agree with their
        // clock whichever zone they chose, so it cannot verify anything.
        const auckland = zoneWallClock("Pacific/Auckland", at);
        const newYork = zoneWallClock("America/New_York", at);
        expect(auckland).not.toBe(newYork);
        expect(auckland).toContain("Tuesday, 1 September 2026");
        expect(newYork).toContain("Monday, 31 August 2026");
    });

    it("crosses the date line correctly for the same instant", () => {
        expect(zoneWallClock("Pacific/Auckland", at)).toContain("3:21 pm");
        expect(zoneWallClock("UTC", at)).toContain("3:21 am");
    });

    it("tracks daylight saving rather than a fixed offset", () => {
        const winter = zoneWallClock("Pacific/Auckland", new Date("2026-07-01T00:00:00Z"));
        const summer = zoneWallClock("Pacific/Auckland", new Date("2026-01-01T00:00:00Z"));
        expect(winter).toContain("12:00 pm"); // NZST, UTC+12
        expect(summer).toContain("1:00 pm"); // NZDT, UTC+13
    });
});
