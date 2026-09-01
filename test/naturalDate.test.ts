import { describe, expect, it } from "vitest";
import { parseInstant } from "../src/time/input.js";
import { wallClockIn } from "../src/time/calendar.js";

/**
 * The grammar, stated as a table of things a moderator might actually type.
 *
 * Every case is resolved against a frozen "now" in a real zone with a real DST
 * rule, because the whole point of the parser is that it reads the member's own
 * clock rather than the server's. Auckland moves its clocks on 27 September
 * 2026, which is a fortnight before most of these dates: if the resolver ever
 * reaches for a fixed 24 hour day, these tests go an hour wrong.
 */

const ZONE = "Pacific/Auckland";

// Thursday 1 October 2026, 14:30 in Auckland.
const NOW = new Date("2026-10-01T01:30:00.000Z");

/** What the member would see on their own clock, for readable assertions. */
function read(raw: string, now = NOW, zone = ZONE): string | null {
    const instant = parseInstant(raw, zone, now);
    if (!instant) return null;
    const wall = wallClockIn(instant, zone);
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ` +
        `${pad(wall.hour)}:${pad(wall.minute)}`
    );
}

describe("the sanity of the frozen clock", () => {
    it("starts on a Thursday afternoon in Auckland", () => {
        const wall = wallClockIn(NOW, ZONE);
        expect(wall.weekday).toBe(4);
        expect(`${wall.year}-${wall.month}-${wall.day} ${wall.hour}:${wall.minute}`).toBe(
            "2026-10-1 14:30"
        );
    });
});

describe("weekdays", () => {
    it("reads the example from the brief", () => {
        expect(read("Tuesday at 10.16 pm")).toBe("2026-10-06 22:16");
    });

    it("reads a weekday with a day of the month, agreeing on both", () => {
        // The next Tuesday is the 6th, so both constraints point at one date.
        expect(read("Tuesday the 6th at 10.16 pm")).toBe("2026-10-06 22:16");
    });

    it("keeps searching when the weekday and the date disagree at first", () => {
        // The next 13th is a Tuesday. A 14th that is also a Tuesday does not
        // come round until September 2027, and the search has to reach it.
        expect(read("Tuesday the 13th")).toBe("2026-10-13 00:00");
        expect(read("Tuesday the 14th")).toBe("2027-09-14 00:00");
    });

    it("takes a bare weekday as the soonest one still to come", () => {
        expect(read("friday")).toBe("2026-10-02 00:00");
        expect(read("fri 9am")).toBe("2026-10-02 09:00");
    });

    it("allows today when the time named has not passed yet", () => {
        // It is Thursday 14:30. Thursday 9pm is still ahead.
        expect(read("thursday at 9pm")).toBe("2026-10-01 21:00");
    });

    it("rolls to next week when today's time has already gone", () => {
        expect(read("thursday at 9am")).toBe("2026-10-08 09:00");
    });

    it("treats 'next' as skipping today entirely", () => {
        expect(read("next thursday at 9pm")).toBe("2026-10-08 21:00");
    });

    it("accepts the abbreviations people type", () => {
        expect(read("tues 10am")).toBe("2026-10-06 10:00");
        expect(read("thurs 9pm")).toBe("2026-10-01 21:00");
        expect(read("weds 9am")).toBe("2026-10-07 09:00");
    });
});

describe("named and numbered dates", () => {
    it("reads a day and a month in either order", () => {
        expect(read("6 October")).toBe("2026-10-06 00:00");
        expect(read("October 6")).toBe("2026-10-06 00:00");
        expect(read("6 Oct 9am")).toBe("2026-10-06 09:00");
        expect(read("Oct 6th at 9am")).toBe("2026-10-06 09:00");
    });

    it("infers the year forward when none is given", () => {
        // March has already gone this year, so it means next year's.
        expect(read("6 March")).toBe("2027-03-06 00:00");
    });

    it("takes an explicit year at its word", () => {
        expect(read("6 October 2028")).toBe("2028-10-06 00:00");
    });

    it("reads a bare ordinal as the next month to carry that day", () => {
        expect(read("the 6th at 9am")).toBe("2026-10-06 09:00");
        // The 1st has already passed today, so it means November's.
        expect(read("the 1st")).toBe("2026-11-01 00:00");
    });

    it("still refuses a slash date, which two readers would read two ways", () => {
        expect(read("06/10/2026")).toBeNull();
        expect(read("6/10")).toBeNull();
    });
});

describe("relative phrases", () => {
    it("reads today and tomorrow", () => {
        expect(read("today at 6pm")).toBe("2026-10-01 18:00");
        expect(read("tomorrow")).toBe("2026-10-02 00:00");
        expect(read("tomorrow at 9am")).toBe("2026-10-02 09:00");
        expect(read("tmr 9am")).toBe("2026-10-02 09:00");
    });

    it("reads the day after tomorrow", () => {
        expect(read("the day after tomorrow")).toBe("2026-10-03 00:00");
    });

    it("counts days, weeks and months forward", () => {
        expect(read("in 3 days")).toBe("2026-10-04 00:00");
        expect(read("in 2 weeks at 9am")).toBe("2026-10-15 09:00");
        expect(read("in a fortnight")).toBe("2026-10-15 00:00");
        expect(read("in 1 month")).toBe("2026-11-01 00:00");
        expect(read("3 days from now")).toBe("2026-10-04 00:00");
    });

    it("reads next week and next month", () => {
        expect(read("next week")).toBe("2026-10-08 00:00");
        expect(read("next month")).toBe("2026-11-01 00:00");
    });

    it("clamps a month step onto a month that is too short", () => {
        // 31 January plus one month has no 31 February to land on.
        const january = new Date("2027-01-30T22:00:00.000Z"); // 31 Jan, 11:00 NZDT
        expect(read("in 1 month", january)).toBe("2027-02-28 00:00");
    });
});

describe("times of day", () => {
    it("accepts a dot, a colon or neither", () => {
        expect(read("tomorrow at 10.16 pm")).toBe("2026-10-02 22:16");
        expect(read("tomorrow at 10:16 pm")).toBe("2026-10-02 22:16");
        expect(read("tomorrow at 10:16pm")).toBe("2026-10-02 22:16");
        expect(read("tomorrow 22:16")).toBe("2026-10-02 22:16");
    });

    it("reads noon and midnight the way people mean them", () => {
        expect(read("tomorrow at noon")).toBe("2026-10-02 12:00");
        expect(read("tomorrow at midday")).toBe("2026-10-02 12:00");
        expect(read("tomorrow at midnight")).toBe("2026-10-02 00:00");
        expect(read("tomorrow 12am")).toBe("2026-10-02 00:00");
        expect(read("tomorrow 12pm")).toBe("2026-10-02 12:00");
    });

    it("reads a part of the day as an hour", () => {
        expect(read("tuesday morning")).toBe("2026-10-06 09:00");
        expect(read("tuesday afternoon")).toBe("2026-10-06 13:00");
        expect(read("tuesday evening")).toBe("2026-10-06 18:00");
        expect(read("tonight")).toBe("2026-10-01 21:00");
    });

    it("defaults to midnight, so a bare date still means the whole day", () => {
        expect(read("tuesday")).toBe("2026-10-06 00:00");
    });

    it("refuses an hour or a minute that no clock has", () => {
        expect(read("tomorrow at 25:00")).toBeNull();
        expect(read("tomorrow at 10:75")).toBeNull();
        expect(read("tomorrow at 13pm")).toBeNull();
    });
});

describe("the ISO forms, which have to keep working", () => {
    it("reads them exactly as before, without searching forward", () => {
        expect(read("2026-10-06")).toBe("2026-10-06 00:00");
        expect(read("2026-10-06 09:00")).toBe("2026-10-06 09:00");
        expect(read("2026-10-06T09:00")).toBe("2026-10-06 09:00");
        expect(read("2026-10-06 5:00 pm")).toBe("2026-10-06 17:00");
    });

    it("does not quietly move an ISO date that has already passed", () => {
        // Back-dating is refused later, by name, rather than being hidden here.
        expect(read("2026-09-01")).toBe("2026-09-01 00:00");
    });

    it("still refuses a day that does not exist", () => {
        expect(read("2026-02-31")).toBeNull();
        expect(read("2026-13-01")).toBeNull();
    });
});

describe("what is not a date", () => {
    it("refuses empty and unreadable text", () => {
        expect(read("")).toBeNull();
        expect(read("   ")).toBeNull();
        expect(read("whenever suits")).toBeNull();
        expect(read("asdfgh")).toBeNull();
    });

    it("refuses a phrase it can only partly read", () => {
        // Reading "tuesday" out of this and ignoring the rest would be a guess.
        expect(read("tuesday probably or maybe wednesday")).toBeNull();
    });

    it("tolerates the small words people pad a date with", () => {
        expect(read("on tuesday")).toBe("2026-10-06 00:00");
        expect(read("back on tuesday at 9am")).toBe("2026-10-06 09:00");
        expect(read("starting tuesday")).toBe("2026-10-06 00:00");
    });
});

describe("timezone, which is the member's own", () => {
    it("resolves the same phrase differently for two members", () => {
        // 21:00 UTC on 1 October is already 2 October in Auckland.
        const late = new Date("2026-10-01T21:00:00.000Z");
        expect(read("tomorrow", late, "Pacific/Auckland")).toBe("2026-10-03 00:00");
        expect(read("tomorrow", late, "UTC")).toBe("2026-10-02 00:00");
    });

    it("holds the named wall clock across the DST change", () => {
        // Auckland moved to NZDT on 27 September. A 9am named on 6 October is
        // 9am on the new offset, not 10am carried over from the old one.
        const instant = parseInstant("6 October at 9am", ZONE, NOW) as Date;
        expect(instant.toISOString()).toBe("2026-10-05T20:00:00.000Z");
    });
});
