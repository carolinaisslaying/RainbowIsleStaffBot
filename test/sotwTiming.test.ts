import { describe, expect, it } from "vitest";
import { addWallClockMinutes } from "../src/time/calendar.js";
import {
    colourStatus,
    cooldownRemainingMs,
    handoffSettled,
    lateCauseFor,
    nextReminderAt,
    recapHolder,
    restOfWeekOffered,
    sotwEnabled,
    targetWeeks,
    timesHeld
} from "../src/domain/staffOfWeek.js";

const at = (iso: string) => new Date(iso);

describe("the reminder", () => {
    const utc = { timeZone: "UTC", weekStartDay: 1, offsetMinutes: 7560 };

    it("lands on Saturday 06:00 with the shipped settings", () => {
        // Monday 2026-09-28 is a week start.
        expect(nextReminderAt(at("2026-09-28T09:00:00Z"), utc)).toEqual(at("2026-10-03T06:00:00Z"));
    });

    it("rolls to next week once this week's has passed", () => {
        expect(nextReminderAt(at("2026-10-03T06:00:00Z"), utc)).toEqual(at("2026-10-10T06:00:00Z"));
    });

    it("follows the wall clock across a DST change", () => {
        // Auckland moves to NZDT at 02:00 on Sunday 2026-09-27. The week
        // starting Monday 2026-09-21 00:00 NZST is 2026-09-20T12:00Z; 6 days 10
        // hours on the wall clock is Sunday 10:00 NZDT, 2026-09-26T21:00Z — an
        // hour earlier than adding 154 hours would give.
        const rules = { timeZone: "Pacific/Auckland", weekStartDay: 1, offsetMinutes: 6 * 1440 + 600 };
        expect(nextReminderAt(at("2026-09-21T00:00:00Z"), rules)).toEqual(at("2026-09-26T21:00:00Z"));
        expect(addWallClockMinutes(at("2026-09-20T12:00:00Z"), 6 * 1440 + 600, "Pacific/Auckland")).toEqual(
            at("2026-09-26T21:00:00Z")
        );
    });

    it("moves with weekStartDay", () => {
        const sunday = { timeZone: "UTC", weekStartDay: 0, offsetMinutes: 60 };
        expect(nextReminderAt(at("2026-09-28T09:00:00Z"), sunday)).toEqual(at("2026-10-04T01:00:00Z"));
    });
});

describe("which week a decision is about", () => {
    const previousStart = at("2026-09-21T00:00:00Z");
    const currentStart = at("2026-09-28T00:00:00Z");
    const nextStart = at("2026-10-05T00:00:00Z");

    it("is next week once this week has been handed off", () => {
        expect(targetWeeks({ previousStart, currentStart, nextStart, currentHandedOff: true })).toEqual({
            current: currentStart,
            next: nextStart
        });
    });

    it("is the week about to be handed off in the minutes before it is", () => {
        expect(targetWeeks({ previousStart, currentStart, nextStart, currentHandedOff: false })).toEqual({
            current: previousStart,
            next: currentStart
        });
    });

    it("counts a week as settled once handed off, or an hour in whatever happened", () => {
        expect(handoffSettled({ claimed: true, now: at("2026-09-28T00:01:00Z"), weekStart: currentStart })).toBe(true);
        expect(handoffSettled({ claimed: false, now: at("2026-09-28T00:02:00Z"), weekStart: currentStart })).toBe(
            false
        );
        expect(handoffSettled({ claimed: false, now: at("2026-09-28T01:00:00Z"), weekStart: currentStart })).toBe(
            true
        );
    });

    it("offers the rest of this week only when nobody holds it", () => {
        expect(restOfWeekOffered(null, true)).toBe(true);
        expect(restOfWeekOffered({ status: "empty", staffId: null }, true)).toBe(true);
        expect(restOfWeekOffered({ status: "skipped", staffId: null }, true)).toBe(true);
        expect(restOfWeekOffered({ status: "picked", staffId: "a" }, true)).toBe(false);
        expect(restOfWeekOffered(null, false)).toBe(false);
    });
});

describe("the colour card", () => {
    it("says what saving will do", () => {
        expect(colourStatus({ holding: true, tier: "staff" })).toBe("holding");
        expect(colourStatus({ holding: false, tier: "lead" })).toBe("saved");
        expect(colourStatus({ holding: false, tier: "executive" })).toBe("executive");
    });

    it("cools a holder's role writes for thirty seconds", () => {
        expect(cooldownRemainingMs(undefined, 1000)).toBe(0);
        expect(cooldownRemainingMs(1000, 11_000)).toBe(20_000);
        expect(cooldownRemainingMs(1000, 31_000)).toBe(0);
    });
});

describe("recognition", () => {
    it("counts credited weeks only", () => {
        const records = [
            { weekStart: at("2026-09-07T00:00:00Z"), holders: ["a"], removedHolders: [] },
            { weekStart: at("2026-09-14T00:00:00Z"), holders: ["a", "b"], removedHolders: ["a"] },
            { weekStart: at("2026-09-28T00:00:00Z"), holders: ["a"], removedHolders: [] }
        ];
        expect(timesHeld(records, "a")).toEqual({ count: 2, last: at("2026-09-28T00:00:00Z") });
        expect(timesHeld(records, "c")).toEqual({ count: 0, last: null });
    });

    it("names the new holder on the recap of the week that just closed, and no other", () => {
        const currentWeekStart = at("2026-09-28T00:00:00Z");
        const nextWeek = { status: "random" as const, staffId: "a" };
        expect(recapHolder({ recapWeekEnd: currentWeekStart, currentWeekStart, nextWeek })).toBe("a");
        expect(recapHolder({ recapWeekEnd: at("2026-09-21T00:00:00Z"), currentWeekStart, nextWeek })).toBeNull();
        expect(
            recapHolder({ recapWeekEnd: currentWeekStart, currentWeekStart, nextWeek: { status: "empty", staffId: null } })
        ).toBeNull();
    });
});

describe("late changes and the switch", () => {
    it("names why a holder can no longer hold it", () => {
        expect(lateCauseFor({ present: false, tier: "none" })).toBe("left");
        expect(lateCauseFor({ present: true, tier: "none" })).toBe("notStaff");
        expect(lateCauseFor({ present: true, tier: "executive" })).toBe("executive");
        expect(lateCauseFor({ present: true, tier: "lead" })).toBeNull();
    });

    it("is off while the role is unset", () => {
        expect(sotwEnabled({ staffOfWeekRole: "" })).toBe(false);
        expect(sotwEnabled({ staffOfWeekRole: "123" })).toBe(true);
    });
});
