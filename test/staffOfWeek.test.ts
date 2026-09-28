import { describe, expect, it } from "vitest";
import {
    barredIds,
    creditedHolders,
    decideHandoff,
    draw,
    drawPool,
    eligibilityFor,
    isHardRefusal,
    refusalText,
    type Candidate,
    type Eligibility
} from "../src/domain/staffOfWeek.js";

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
    staffId: "a",
    active: true,
    tier: "staff",
    exemptByLeave: false,
    pendingLeave: false,
    ...overrides
});

describe("who held it", () => {
    it("credits everyone who held it except those removed", () => {
        expect(creditedHolders({ holders: ["a", "b"], removedHolders: ["a"] })).toEqual(["b"]);
        expect(creditedHolders(null)).toEqual([]);
    });

    it("bars the credited holders of the two weeks before, and nobody for a skipped or empty week", () => {
        const barred = barredIds([
            { holders: ["a", "b"], removedHolders: ["a"] },
            { holders: [], removedHolders: [] },
            null
        ]);
        expect([...barred]).toEqual(["b"]);
    });
});

describe("eligibility", () => {
    it("refuses in the spec's order", () => {
        const everything = candidate({ active: false, tier: "executive", exemptByLeave: true });
        expect(eligibilityFor(everything, new Set(["a"]))).toEqual({ eligible: false, reason: "inactive" });
        expect(eligibilityFor(candidate({ tier: "none", exemptByLeave: true }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "notStaff"
        });
        expect(eligibilityFor(candidate({ tier: "executive" }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "executive"
        });
        expect(eligibilityFor(candidate({ exemptByLeave: true }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "recentHolder"
        });
        expect(eligibilityFor(candidate({ exemptByLeave: true }), new Set())).toEqual({
            eligible: false,
            reason: "onLeave"
        });
    });

    it("admits Staff and Leads, flagging pending leave rather than refusing it", () => {
        expect(eligibilityFor(candidate({ tier: "lead" }), new Set())).toEqual({ eligible: true, pendingLeave: false });
        expect(eligibilityFor(candidate({ pendingLeave: true }), new Set())).toEqual({
            eligible: true,
            pendingLeave: true
        });
    });

    it("treats only the first three refusals as hard", () => {
        expect(isHardRefusal({ eligible: false, reason: "notStaff" })).toBe(true);
        expect(isHardRefusal({ eligible: false, reason: "onLeave" })).toBe(false);
        expect(isHardRefusal({ eligible: true, pendingLeave: false })).toBe(false);
    });

    it("words every refusal for the Executive reading it", () => {
        for (const reason of ["inactive", "notStaff", "executive", "recentHolder", "onLeave"] as const) {
            expect(refusalText(reason, "Robin")).toContain("**Robin**");
        }
    });
});

describe("the draw", () => {
    const yes: Eligibility = { eligible: true, pendingLeave: false };
    const all = (ids: string[], value: Eligibility = yes) => new Map(ids.map((id) => [id, value]));

    it("takes the top three who met the target", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 300 },
                { staffId: "b", minutes: 250 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 150 },
                { staffId: "e", minutes: 100 }
            ],
            120,
            all(["a", "b", "c", "d", "e"])
        );
        expect(pool.map((row) => row.staffId)).toEqual(["a", "b", "c"]);
    });

    it("keeps every member tied at the cut", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 200 },
                { staffId: "b", minutes: 200 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 200 },
                { staffId: "e", minutes: 199 }
            ],
            120,
            all(["a", "b", "c", "d", "e"])
        );
        expect(pool.map((row) => row.staffId).sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("leaves out anyone ineligible or with pending leave", () => {
        const eligibility = new Map<string, Eligibility>([
            ["a", { eligible: false, reason: "recentHolder" }],
            ["b", { eligible: true, pendingLeave: true }],
            ["c", yes]
        ]);
        const pool = drawPool(
            [
                { staffId: "a", minutes: 300 },
                { staffId: "b", minutes: 250 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 500 }
            ],
            120,
            eligibility
        );
        expect(pool.map((row) => row.staffId)).toEqual(["c"]);
    });

    it("draws from a thin week", () => {
        const pool = drawPool([{ staffId: "a", minutes: 130 }], 120, all(["a"]));
        expect(draw(pool, () => 0.99)?.staffId).toBe("a");
    });

    it("returns nobody when nobody met the target", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 0 },
                { staffId: "b", minutes: 0 }
            ],
            120,
            all(["a", "b"])
        );
        expect(pool).toEqual([]);
        expect(draw(pool, () => 0.5)).toBeNull();
    });

    it("is uniform over the pool with the rng given", () => {
        const pool = ["a", "b", "c"];
        expect(draw(pool, () => 0)).toBe("a");
        expect(draw(pool, () => 0.34)).toBe("b");
        expect(draw(pool, () => 0.999999)).toBe("c");
        expect(draw(pool, () => 1)).toBe("c");
    });
});

describe("the handoff decision", () => {
    const pool = [{ staffId: "z", minutes: 300 }];

    it("honours a pick that can still hold it, late leave included", () => {
        expect(
            decideHandoff({
                week: { status: "pending", staffId: "p" },
                pickEligibility: { eligible: false, reason: "onLeave" },
                pool,
                rng: () => 0
            })
        ).toEqual({ decision: { kind: "picked", staffId: "p" }, pickFailed: null });
    });

    it("falls back to the draw when the pick can no longer hold it at all", () => {
        expect(
            decideHandoff({
                week: { status: "pending", staffId: "p" },
                pickEligibility: { eligible: false, reason: "notStaff" },
                pool,
                rng: () => 0
            })
        ).toEqual({ decision: { kind: "random", staffId: "z" }, pickFailed: "notStaff" });
    });

    it("hands a skipped week to nobody and never draws", () => {
        expect(
            decideHandoff({ week: { status: "skipped", staffId: null }, pickEligibility: null, pool, rng: () => 0 })
                .decision
        ).toEqual({ kind: "skipped" });
    });

    it("draws for an undecided week, and records nobody when the pool is empty", () => {
        expect(decideHandoff({ week: null, pickEligibility: null, pool, rng: () => 0 }).decision).toEqual({
            kind: "random",
            staffId: "z"
        });
        expect(decideHandoff({ week: null, pickEligibility: null, pool: [], rng: () => 0 }).decision).toEqual({
            kind: "empty"
        });
    });
});
