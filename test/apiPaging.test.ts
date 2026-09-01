import { describe, expect, it } from "vitest";
import { parsePaging } from "../src/api/server.js";

/**
 * /api/assessments used to read every matching document with no bound at all.
 * `Number("abc")` is NaN and NaN compares false against every limit, so a
 * coerced argument would have sailed past a naive range check and landed in
 * `.limit(NaN)`.
 */
describe("assessment paging arguments", () => {
    it("defaults to a bounded page when nothing is asked for", () => {
        const result = parsePaging(null, null);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.limit).toBe(500);
        expect(result.skip).toBe(0);
    });

    it("accepts a page inside the bounds", () => {
        const result = parsePaging("100", "50");
        expect(result).toEqual({ ok: true, limit: 100, skip: 50 });
    });

    it("accepts the maximum exactly", () => {
        expect(parsePaging("2000", "0")).toEqual({ ok: true, limit: 2000, skip: 0 });
    });

    it("refuses a limit above the ceiling", () => {
        const result = parsePaging("2001", null);
        expect(result.ok).toBe(false);
    });

    it("refuses zero and negative limits", () => {
        expect(parsePaging("0", null).ok).toBe(false);
        expect(parsePaging("-1", null).ok).toBe(false);
    });

    it("refuses a limit that is not a number at all", () => {
        // The one that used to reach the driver as NaN.
        const result = parsePaging("abc", null);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain("whole number");
    });

    it("refuses a fractional limit", () => {
        expect(parsePaging("1.5", null).ok).toBe(false);
    });

    it("refuses a negative skip", () => {
        expect(parsePaging(null, "-5").ok).toBe(false);
    });

    it("refuses a skip that is not a number", () => {
        expect(parsePaging(null, "yesterday").ok).toBe(false);
    });

    it("treats an empty string as absent rather than as zero", () => {
        // Number("") is 0, which would silently become an unusable limit.
        expect(parsePaging("", null).ok).toBe(false);
    });
});
