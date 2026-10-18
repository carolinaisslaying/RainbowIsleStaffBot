import { describe, expect, it } from "vitest";
import {
    activityReached,
    cooldownElapsed,
    reminderRefusal,
    withinWindow
} from "../src/domain/shiftReminder.js";
import { DEFAULT_CONFIG } from "../src/config/guildConfig.js";

const MINUTE = 60_000;
const at = (iso: string) => new Date(iso);

describe("the shift reminder's bar", () => {
    it("ships at twenty messages in half an hour, at most every six hours", () => {
        expect(DEFAULT_CONFIG.shiftReminderMessages).toBe(20);
        expect(DEFAULT_CONFIG.shiftReminderWindowMinutes).toBe(30);
        expect(DEFAULT_CONFIG.shiftReminderCooldownHours).toBe(6);
    });

    it("counts only messages inside the window", () => {
        const now = 100 * MINUTE;
        const times = [60 * MINUTE, 70 * MINUTE + 1, 80 * MINUTE, 99 * MINUTE];
        expect(withinWindow(times, now, 30 * MINUTE)).toEqual([70 * MINUTE + 1, 80 * MINUTE, 99 * MINUTE]);
    });

    it("drops a message exactly a window old", () => {
        expect(withinWindow([70 * MINUTE], 100 * MINUTE, 30 * MINUTE)).toEqual([]);
    });

    it("needs the full count, and zero turns it off", () => {
        expect(activityReached(19, 20)).toBe(false);
        expect(activityReached(20, 20)).toBe(true);
        expect(activityReached(5, 0)).toBe(false);
    });
});

describe("who is reminded", () => {
    const base = { tier: "staff" as const, onLeave: false, optedOut: false, onShift: false };

    it("reminds a Moderator or a Lead off shift", () => {
        expect(reminderRefusal(base)).toBeNull();
        expect(reminderRefusal({ ...base, tier: "lead" })).toBeNull();
    });

    it("never reminds an Executive, whatever else is true", () => {
        expect(reminderRefusal({ ...base, tier: "executive" })).toBe("executive");
    });

    it("never reminds anybody not on the team", () => {
        expect(reminderRefusal({ ...base, tier: "none" })).toBe("notStaff");
    });

    it("leaves alone anybody on shift, on leave, or opted out", () => {
        expect(reminderRefusal({ ...base, onShift: true })).toBe("onShift");
        expect(reminderRefusal({ ...base, onLeave: true })).toBe("onLeave");
        expect(reminderRefusal({ ...base, optedOut: true })).toBe("optedOut");
    });
});

describe("the cooldown", () => {
    const six = 6 * 60 * MINUTE;

    it("is due for somebody never reminded", () => {
        expect(cooldownElapsed(undefined, at("2026-10-18T10:00:00Z"), six)).toBe(true);
        expect(cooldownElapsed(null, at("2026-10-18T10:00:00Z"), six)).toBe(true);
    });

    it("waits the full six hours, and not a minute less", () => {
        const last = at("2026-10-18T10:00:00Z");
        expect(cooldownElapsed(last, at("2026-10-18T15:59:00Z"), six)).toBe(false);
        expect(cooldownElapsed(last, at("2026-10-18T16:00:00Z"), six)).toBe(true);
    });
});
