import { describe, expect, it } from "vitest";
import {
    BITMAP_BYTES,
    countRange,
    emptyBitmap,
    hourHistogram,
    isMinuteSet,
    minuteOfUtcDay,
    normaliseBitmap,
    popcount,
    setMinute,
    setMinutes
} from "../src/domain/bitmap.js";

describe("bitmap shape", () => {
    it("is 180 bytes, 1440 bits", () => {
        expect(emptyBitmap().length).toBe(180);
        expect(BITMAP_BYTES).toBe(180);
    });

    it("starts empty", () => {
        expect(popcount(emptyBitmap())).toBe(0);
    });

    it("rejects minutes outside the day", () => {
        const bitmap = emptyBitmap();
        expect(() => setMinute(bitmap, -1)).toThrow(RangeError);
        expect(() => setMinute(bitmap, 1440)).toThrow(RangeError);
        expect(() => setMinute(bitmap, 1.5)).toThrow(RangeError);
    });
});

describe("set and popcount", () => {
    it("sets and reads back every minute of the day independently", () => {
        const bitmap = emptyBitmap();
        for (let minute = 0; minute < 1440; minute += 1) {
            expect(isMinuteSet(bitmap, minute)).toBe(false);
            setMinute(bitmap, minute);
            expect(isMinuteSet(bitmap, minute)).toBe(true);
        }
        expect(popcount(bitmap)).toBe(1440);
    });

    it("packs minute 0 through 7 into byte 0, least significant bit first", () => {
        const bitmap = emptyBitmap();
        setMinute(bitmap, 0);
        expect(bitmap[0]).toBe(0x01);
        setMinute(bitmap, 7);
        expect(bitmap[0]).toBe(0x81);
        setMinute(bitmap, 8);
        expect(bitmap[1]).toBe(0x01);
    });

    it("counts a sparse day correctly", () => {
        const bitmap = emptyBitmap();
        for (const minute of [0, 59, 60, 600, 1439]) setMinute(bitmap, minute);
        expect(popcount(bitmap)).toBe(5);
        expect(setMinutes(bitmap)).toEqual([0, 59, 60, 600, 1439]);
    });
});

describe("idempotency", () => {
    it("crediting the same minute twice changes nothing", () => {
        const bitmap = emptyBitmap();
        expect(setMinute(bitmap, 421)).toBe(true);
        const snapshot = Buffer.from(bitmap);

        expect(setMinute(bitmap, 421)).toBe(false);
        expect(setMinute(bitmap, 421)).toBe(false);

        expect(bitmap.equals(snapshot)).toBe(true);
        expect(popcount(bitmap)).toBe(1);
    });

    it("reports newly set versus already set so count stays truthful", () => {
        const bitmap = emptyBitmap();
        let credited = 0;
        for (const minute of [10, 10, 10, 11, 11, 12]) {
            if (setMinute(bitmap, minute)) credited += 1;
        }
        expect(credited).toBe(3);
        expect(popcount(bitmap)).toBe(3);
    });
});

describe("range counting", () => {
    it("counts a half open range", () => {
        const bitmap = emptyBitmap();
        setMinute(bitmap, 59);
        setMinute(bitmap, 60);
        setMinute(bitmap, 61);
        expect(countRange(bitmap, 60, 61)).toBe(1);
        expect(countRange(bitmap, 59, 62)).toBe(3);
        expect(countRange(bitmap, 0, 60)).toBe(1);
    });

    it("handles ranges that begin and end mid byte", () => {
        const bitmap = emptyBitmap();
        for (let minute = 0; minute < 1440; minute += 1) setMinute(bitmap, minute);
        expect(countRange(bitmap, 3, 5)).toBe(2);
        expect(countRange(bitmap, 3, 100)).toBe(97);
        expect(countRange(bitmap, 0, 1440)).toBe(1440);
    });

    it("clamps out of range windows rather than throwing", () => {
        const bitmap = emptyBitmap();
        setMinute(bitmap, 0);
        setMinute(bitmap, 1439);
        expect(countRange(bitmap, -500, 1)).toBe(1);
        expect(countRange(bitmap, 1439, 9000)).toBe(1);
        expect(countRange(bitmap, 100, 100)).toBe(0);
        expect(countRange(bitmap, 500, 100)).toBe(0);
    });

    it("sums a window spanning a UTC day boundary across two bitmaps", () => {
        // 23:30 on day one to 00:30 on day two: 30 minutes either side.
        const dayOne = emptyBitmap();
        const dayTwo = emptyBitmap();
        for (let minute = 1410; minute < 1440; minute += 1) setMinute(dayOne, minute);
        for (let minute = 0; minute < 30; minute += 1) setMinute(dayTwo, minute);

        const total = countRange(dayOne, 1410, 1440) + countRange(dayTwo, 0, 30);
        expect(total).toBe(60);

        // The same window shifted an hour earlier picks up only day one.
        expect(countRange(dayOne, 1350, 1410) + countRange(dayTwo, 0, 0)).toBe(0);
    });
});

describe("hour histogram", () => {
    it("buckets minutes into 24 UTC hours", () => {
        const bitmap = emptyBitmap();
        for (let minute = 0; minute < 60; minute += 1) setMinute(bitmap, minute);
        setMinute(bitmap, 13 * 60 + 5);
        const hours = hourHistogram(bitmap);
        expect(hours).toHaveLength(24);
        expect(hours[0]).toBe(60);
        expect(hours[13]).toBe(1);
        expect(hours.reduce((a, b) => a + b, 0)).toBe(61);
    });
});

describe("normalisation and minute derivation", () => {
    it("pads and truncates to 180 bytes", () => {
        expect(normaliseBitmap(null).length).toBe(180);
        expect(normaliseBitmap(Buffer.alloc(10)).length).toBe(180);
        expect(normaliseBitmap(Buffer.alloc(400)).length).toBe(180);
    });

    it("derives minute of the UTC day from an instant", () => {
        expect(minuteOfUtcDay(new Date("2026-09-28T00:00:00Z"))).toBe(0);
        expect(minuteOfUtcDay(new Date("2026-09-28T00:00:59Z"))).toBe(0);
        expect(minuteOfUtcDay(new Date("2026-09-28T13:45:30Z"))).toBe(825);
        expect(minuteOfUtcDay(new Date("2026-09-28T23:59:59Z"))).toBe(1439);
    });
});
