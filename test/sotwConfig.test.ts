import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, DEFAULT_CONFIG, parseConfigValue } from "../src/config/guildConfig.js";

describe("Staff of the Week configuration", () => {
    it("ships switched off, with the reminder on Saturday morning", () => {
        expect(DEFAULT_CONFIG.staffOfWeekRole).toBe("");
        expect(DEFAULT_CONFIG.staffOfWeekChannelId).toBe("");
        expect(DEFAULT_CONFIG.staffOfWeekColourPickerUrl).toBe("");
        // 5 days 6 hours after a Monday 00:00 week start.
        expect(DEFAULT_CONFIG.staffOfWeekReminderOffsetMinutes).toBe(7560);
    });

    it("never reads as missing", () => {
        for (const key of [
            "staffOfWeekRole",
            "staffOfWeekChannelId",
            "staffOfWeekReminderOffsetMinutes",
            "staffOfWeekColourPickerUrl"
        ] as const) {
            expect(CONFIG_KEYS[key].importance).toBe("optional");
        }
    });

    it("keeps the reminder inside one week", () => {
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "0").ok).toBe(true);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "10079").ok).toBe(true);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "10080").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "-1").ok).toBe(false);
    });

    it("takes an https address and drops any fragment", () => {
        expect(parseConfigValue("staffOfWeekColourPickerUrl", " https://colour.example.nz/pick#old ")).toEqual({
            ok: true,
            value: "https://colour.example.nz/pick"
        });
    });

    it("refuses anything that is not an https address", () => {
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "http://colour.example.nz").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "colour.example.nz").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "javascript:alert(1)").ok).toBe(false);
    });

    it("takes the role and channel as Discord ids", () => {
        expect(parseConfigValue("staffOfWeekRole", "<@&123456789012345678>")).toEqual({
            ok: true,
            value: "123456789012345678"
        });
        expect(parseConfigValue("staffOfWeekChannelId", "<#123456789012345678>").ok).toBe(true);
    });
});
