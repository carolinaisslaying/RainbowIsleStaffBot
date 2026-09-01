import { describe, expect, it } from "vitest";
import { parseWallClockInput, parseInstant, formatForInput } from "../src/time/input.js";
import { transitionFor } from "../src/events/presenceUpdate.js";

describe("what a member may type into the leave form", () => {
    it("reads a plain ISO date as midnight", () => {
        expect(parseWallClockInput("2026-10-06")).toEqual({
            year: 2026,
            month: 10,
            day: 6,
            hour: 0,
            minute: 0
        });
    });

    it("reads a date and time, with either separator", () => {
        const expected = { year: 2026, month: 10, day: 6, hour: 9, minute: 30 };
        expect(parseWallClockInput("2026-10-06 09:30")).toEqual(expected);
        expect(parseWallClockInput("2026-10-06T09:30")).toEqual(expected);
    });

    it("understands am and pm, because people type them", () => {
        expect(parseWallClockInput("2026-10-06 5:00 pm")?.hour).toBe(17);
        expect(parseWallClockInput("2026-10-06 12:00 am")?.hour).toBe(0);
        expect(parseWallClockInput("2026-10-06 12:00 pm")?.hour).toBe(12);
    });

    it("refuses a day that does not exist rather than rolling it forward", () => {
        expect(parseWallClockInput("2026-02-31")).toBeNull();
        expect(parseWallClockInput("2026-13-01")).toBeNull();
        expect(parseWallClockInput("2026-10-06 25:00")).toBeNull();
    });

    it("refuses anything that is not a date at all", () => {
        expect(parseWallClockInput("next tuesday")).toBeNull();
        expect(parseWallClockInput("06/10/2026")).toBeNull();
        expect(parseWallClockInput("")).toBeNull();
    });

    it("reads the time in the member's own zone, not the server's", () => {
        // 09:00 in Auckland is 21:00 UTC the day before, in October.
        const instant = parseInstant("2026-10-06 09:00", "Pacific/Auckland");
        expect(instant?.toISOString()).toBe("2026-10-05T20:00:00.000Z");
        expect(parseInstant("2026-10-06 09:00", "UTC")?.toISOString()).toBe(
            "2026-10-06T09:00:00.000Z"
        );
    });

    it("round trips an instant back into the box it came from", () => {
        const zone = "Pacific/Auckland";
        const instant = parseInstant("2026-10-06 09:30", zone) as Date;
        expect(formatForInput(instant, zone)).toBe("2026-10-06 09:30");
    });
});

describe("which presence changes mean away", () => {
    it("marks away when Discord's own idle timer fires", () => {
        expect(transitionFor("online", "idle")).toBe("away");
    });

    it("leaves alone the people who sit on idle all day", () => {
        // The whole complaint: these used to mark someone away, and the return
        // trip they actually made never brought them back.
        expect(transitionFor("dnd", "idle")).toBe("none");
        expect(transitionFor("idle", "idle")).toBe("none");
        expect(transitionFor("idle", "dnd")).toBe("none");
        expect(transitionFor("idle", "online")).toBe("none");
    });

    it("marks away when they close Discord, from whatever they were", () => {
        expect(transitionFor("online", "offline")).toBe("away");
        expect(transitionFor("idle", "offline")).toBe("away");
        expect(transitionFor("dnd", "offline")).toBe("away");
    });

    it("does not re-trigger on offline to offline", () => {
        expect(transitionFor("offline", "offline")).toBe("none");
    });

    it("brings them back when they open Discord again", () => {
        expect(transitionFor("offline", "online")).toBe("back");
        expect(transitionFor("offline", "idle")).toBe("back");
        expect(transitionFor("offline", "dnd")).toBe("back");
    });

    it("infers nothing from a status it has no previous reading for", () => {
        expect(transitionFor(null, "idle")).toBe("none");
        expect(transitionFor(null, "online")).toBe("none");
        // Except offline, which is a fact about now rather than about a change.
        expect(transitionFor(null, "offline")).toBe("away");
    });
});
