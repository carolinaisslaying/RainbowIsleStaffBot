import { describe, expect, it } from "vitest";
import {
    daysLeftTitle,
    fortnightReminderDue,
    fortnightReminderRefusal
} from "../src/domain/fortnightReminder.js";
import { fortnightRingSvg } from "../src/render/fortnightReminder.js";
import { cappedArcPath } from "../src/render/svg.js";

const closes = new Date("2026-11-09T00:00:00Z");
const before = (hours: number) => new Date(closes.getTime() - hours * 3_600_000);

describe("when the heads up goes out", () => {
    it("goes at their 09:00 inside the last three days", () => {
        expect(fortnightReminderDue(before(63), closes, 9)).toBe(true);
        expect(fortnightReminderDue(before(72), closes, 9)).toBe(true);
    });

    it("waits for 09:00", () => {
        expect(fortnightReminderDue(before(63), closes, 8)).toBe(false);
    });

    it("does not go earlier", () => {
        expect(fortnightReminderDue(before(73), closes, 9)).toBe(false);
    });

    it("does not go with a day or less left", () => {
        expect(fortnightReminderDue(before(25), closes, 9)).toBe(true);
        expect(fortnightReminderDue(before(24), closes, 9)).toBe(false);
        expect(fortnightReminderDue(before(3), closes, 9)).toBe(false);
        expect(fortnightReminderDue(before(0), closes, 9)).toBe(false);
    });
});

describe("the title", () => {
    it("says how long is really left", () => {
        expect(daysLeftTitle(before(63), closes)).toBe("Three days left this fortnight");
        expect(daysLeftTitle(before(39), closes)).toBe("Two days left this fortnight");
    });
});

describe("who gets one", () => {
    const short = {
        tier: "staff" as const,
        onLeaveNow: false,
        status: "below" as const,
        heldForLeave: false,
        pendingExemptsAWeek: false
    };

    it("goes to anybody short, however short", () => {
        expect(fortnightReminderRefusal(short)).toBeNull();
    });

    it("skips Executives and anybody off the team", () => {
        expect(fortnightReminderRefusal({ ...short, tier: "executive" })).toBe("executive");
        expect(fortnightReminderRefusal({ ...short, tier: "none" })).toBe("notStaff");
    });

    it("skips anybody already there", () => {
        expect(fortnightReminderRefusal({ ...short, status: "met" })).toBe("met");
    });

    it("skips anybody leave excuses, or might", () => {
        expect(fortnightReminderRefusal({ ...short, status: "exempt" })).toBe("exempt");
        expect(fortnightReminderRefusal({ ...short, onLeaveNow: true })).toBe("onLeave");
        expect(fortnightReminderRefusal({ ...short, heldForLeave: true })).toBe("mayBeExempt");
        expect(fortnightReminderRefusal({ ...short, pendingExemptsAWeek: true })).toBe("mayBeExempt");
    });
});

describe("the ring", () => {
    const base = {
        minutes: 210,
        requiredMinutes: 240,
        fullMinutes: 240,
        week1Minutes: 120,
        week2Minutes: 90,
        week1Exempt: false,
        week2Exempt: false,
        state: "amber" as const
    };

    it("says what is left and how the weeks add up", () => {
        const svg = fortnightRingSvg(base);
        expect(svg).toContain(">30<");
        expect(svg).toContain("210 of 240 minutes");
        expect(svg).toContain(">88%<");
        expect(svg).toContain("120 min<");
        expect(svg).toContain("90 min so far");
    });

    it("never reads 100% while somebody is short", () => {
        expect(fortnightRingSvg({ ...base, minutes: 239 })).toContain(">99%<");
    });

    it("draws nothing lit and no percentage at zero", () => {
        const svg = fortnightRingSvg({ ...base, minutes: 0, week1Minutes: 0, week2Minutes: 0, state: "red" });
        expect(svg).toContain(">240<");
        expect(svg).not.toContain("ring-progress");
        expect(svg).not.toContain("rail-fill");
        expect(svg).not.toContain(">0%<");
    });

    it("says when leave lowered the minimum, and which week", () => {
        const svg = fortnightRingSvg({
            ...base,
            minutes: 45,
            requiredMinutes: 120,
            week1Minutes: 0,
            week2Minutes: 45,
            week1Exempt: true,
            state: "red"
        });
        expect(svg).toContain("45 of 120 minutes (lowered for leave)");
        expect(svg).toContain("Exempt, on leave");
    });

    it("keeps a gap when nearly full, using the real rings' capped arc", () => {
        const path = fortnightRingSvg({ ...base, minutes: 236 }).match(/class="ring-progress" d="([^"]+)"/)?.[1] ?? "";
        expect(path).toBe(cappedArcPath(100, 100, 66, 0, (236 / 240) * 360, 20));
        const numbers = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
        // Starts just right of the top and ends short of it, with room between the caps.
        expect(numbers[0]).toBeGreaterThan(100);
        expect(numbers.at(-2)).toBeLessThan(100);
    });
});
