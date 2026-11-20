import { describe, expect, it } from "vitest";
import { carriedShortfall, weekTargetFor } from "../src/domain/carryOver.js";
import { ringCardSvg, describeRings, ringsCacheKey } from "../src/render/rings.js";
import { ringFigures, type RingCardInput } from "../src/render/cards.js";

const rule = {
    weeklyTargetMinutes: 120,
    secondWeek: true,
    assessable: true,
    thisWeekExempt: false,
    previousWeek: { activityMinutes: 80, onLeave: false }
};

describe("carriedShortfall", () => {
    it("carries what last week was short of the target", () => {
        expect(carriedShortfall(rule)).toBe(40);
        expect(carriedShortfall({ ...rule, previousWeek: { activityMinutes: 0, onLeave: false } })).toBe(120);
    });

    it("never carries a surplus, and never goes negative", () => {
        expect(carriedShortfall({ ...rule, previousWeek: { activityMinutes: 120, onLeave: false } })).toBe(0);
        expect(carriedShortfall({ ...rule, previousWeek: { activityMinutes: 300, onLeave: false } })).toBe(0);
    });

    it("carries nothing into the first week of a fortnight", () => {
        expect(carriedShortfall({ ...rule, secondWeek: false })).toBe(0);
    });

    it("carries nothing in a fortnight that is not assessed", () => {
        expect(carriedShortfall({ ...rule, assessable: false })).toBe(0);
    });

    it("carries nothing when either week is exempt for leave", () => {
        expect(carriedShortfall({ ...rule, thisWeekExempt: true })).toBe(0);
        expect(carriedShortfall({ ...rule, previousWeek: { activityMinutes: 0, onLeave: true } })).toBe(0);
    });

    it("carries nothing when there was no previous week to fall short in", () => {
        expect(carriedShortfall({ ...rule, previousWeek: null })).toBe(0);
    });
});

describe("weekTargetFor", () => {
    const config = { weeklyTargetMinutes: 120, amberThresholdPercent: 75 };

    it("raises the target by the carry and judges the ring against it", () => {
        expect(weekTargetFor({ activityMinutes: 90, onLeave: false }, 40, config)).toEqual({
            activityTarget: 160,
            carriedMinutes: 40,
            state: "red"
        });
        expect(weekTargetFor({ activityMinutes: 160, onLeave: false }, 40, config).state).toBe("green");
    });

    it("is the plain weekly target without a carry", () => {
        expect(weekTargetFor({ activityMinutes: 90, onLeave: false }, 0, config)).toEqual({
            activityTarget: 120,
            carriedMinutes: 0,
            state: "amber"
        });
    });

    it("stays grey on leave", () => {
        expect(weekTargetFor({ activityMinutes: 0, onLeave: true }, 40, config).state).toBe("leave");
    });
});

describe("drawing the carry", () => {
    const rings = {
        activityMinutes: 90,
        activityTarget: 160,
        carriedMinutes: 40,
        shiftHours: 6.5,
        shiftTarget: 10,
        activeDays: 3,
        activeDaysTarget: 4,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("names the carry in the legend and the alt text", () => {
        expect(ringCardSvg(rings)).toContain("90 of 160 · 40 carried over");
        expect(describeRings(rings)).toContain("90 of 160 activity minutes, including 40 carried over from last week");
    });

    it("says nothing about a carry that is not there", () => {
        expect(ringCardSvg({ ...rings, activityTarget: 120, carriedMinutes: 0 })).toContain(">90 of 120 minutes<");
        expect(describeRings({ ...rings, carriedMinutes: 0 })).not.toContain("carried");
    });

    it("keys the cached image on the carry", () => {
        const week = new Date("2026-11-16T11:00:00Z");
        const stats = { activityMinutes: 90, shiftHours: 6.5, activeDays: 3, state: "red" as const, softRingsEnabled: true, face: null };
        expect(ringsCacheKey("s", week, { ...stats, carriedMinutes: 40 })).not.toBe(
            ringsCacheKey("s", week, { ...stats, carriedMinutes: 0 })
        );
    });

    it("explains the raised target beneath the headline", () => {
        const card: RingCardInput = {
            staffId: "s",
            displayName: "Sam",
            weekStart: new Date(),
            weekEnd: new Date(),
            activityMinutes: 90,
            activityTarget: 160,
            carriedMinutes: 40,
            shiftMs: 0,
            shiftTargetHours: 10,
            activeDays: 3,
            activeDaysTarget: 4,
            state: "red",
            softRingsEnabled: true
        };
        const figures = ringFigures(card);
        expect(figures).toContain("**90 of 160 activity minutes** this week, below the minimum.");
        expect(figures).toContain("-# 120 for this week, plus **40** left over from last week.");
        expect(ringFigures({ ...card, activityTarget: 120, carriedMinutes: 0, state: "amber" })).not.toContain("left over");
    });
});
