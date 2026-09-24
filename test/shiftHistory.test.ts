import { describe, expect, it } from "vitest";
import { shiftHistoryLine } from "../src/render/shiftHistory.js";

/**
 * One line per shift on `/shift history`. Pure: the command measures an open
 * shift up to now and passes the figures in, so nothing here reads or writes
 * the database.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const at = (iso: string) => new Date(iso);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("a finished shift", () => {
    const line = shiftHistoryLine({
        startedAt: at("2026-09-24T01:04:00Z"),
        endedAt: at("2026-09-24T06:26:00Z"),
        endReason: "auto_ended_away",
        availableMs: 4 * HOUR + 12 * MINUTE,
        activityMinutes: 133,
        awaySince: null
    });

    it("shows when it ended as well as when it began, so nobody adds up the length", () => {
        expect(line).toContain(
            `<t:${unix("2026-09-24T01:04:00Z")}:f> → <t:${unix("2026-09-24T06:26:00Z")}:t>`
        );
        expect(line).toContain("5 h 22 min");
    });

    it("names why it ended in words, never the stored code", () => {
        expect(line).toContain("auto-ended while away");
        expect(line).not.toContain("auto_ended_away");
    });

    it("keeps its stored figures", () => {
        expect(line).toContain("4 h 12 min available");
        expect(line).toContain("133 min earned");
    });
});

describe("a shift still open", () => {
    const base = {
        startedAt: at("2026-09-24T15:51:00Z"),
        endedAt: null,
        endReason: null,
        availableMs: 6 * HOUR,
        activityMinutes: 41,
        now: at("2026-09-24T23:22:00Z")
    };

    it("shows the figures so far rather than the zeros stored until it closes", () => {
        const line = shiftHistoryLine({ ...base, awaySince: null });
        expect(line).toContain("→ now");
        expect(line).toContain("7 h 31 min so far");
        expect(line).toContain("6 h available");
        expect(line).toContain("41 min earned");
        expect(line).not.toContain("0 min available");
    });

    it("says whether they are available or away right now", () => {
        expect(shiftHistoryLine({ ...base, awaySince: null })).toContain("**on shift**");
        const away = shiftHistoryLine({ ...base, awaySince: at("2026-09-24T22:00:00Z") });
        expect(away).toContain(`**away** since <t:${unix("2026-09-24T22:00:00Z")}:t>`);
    });
});

describe("every end reason", () => {
    it("reads in the third person, because a Lead reads other people's history", () => {
        for (const endReason of [
            "manual",
            "max_duration",
            "auto_ended_away",
            "leave_started",
            "reconciled",
            "terminated"
        ] as const) {
            const line = shiftHistoryLine({
                startedAt: at("2026-09-24T01:00:00Z"),
                endedAt: at("2026-09-24T02:00:00Z"),
                endReason,
                availableMs: HOUR,
                activityMinutes: 10,
                awaySince: null
            });
            expect(line).not.toMatch(/\byou\b|_/i);
        }
    });
});
