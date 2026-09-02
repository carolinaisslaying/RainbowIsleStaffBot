import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { conductWarningPermitted, isConductTier } from "../src/domain/conduct.js";
import type { Tier } from "../src/domain/permissions.js";

const issuer = new ObjectId();
const subject = new ObjectId();

const ask = (overrides: Partial<Parameters<typeof conductWarningPermitted>[0]> = {}) =>
    conductWarningPermitted({
        issuerTier: "executive" as Tier,
        subjectTier: "staff" as Tier,
        issuerStaffId: issuer,
        subjectStaffId: subject,
        subjectDeparted: false,
        ...overrides
    });

describe("who may issue a conduct warning", () => {
    it("permits an Executive warning a staff member", () => {
        expect(ask()).toEqual({ ok: true });
    });

    it("permits an Executive warning a Lead", () => {
        expect(ask({ subjectTier: "lead" })).toEqual({ ok: true });
    });

    it("refuses a Lead", () => {
        const result = ask({ issuerTier: "lead" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("Executive only");
    });

    it("refuses a staff member", () => {
        expect(ask({ issuerTier: "staff" }).ok).toBe(false);
    });

    it("refuses somebody who is not staff at all", () => {
        expect(ask({ issuerTier: "none" }).ok).toBe(false);
    });
});

describe("who may receive one", () => {
    it("refuses an Executive, whoever is asking", () => {
        // Deliberate: a warning here is one person's decision with no second
        // signature, and it would go on a peer's permanent record.
        const result = ask({ subjectTier: "executive" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("Executives cannot be warned");
    });

    it("refuses somebody who is not Moderation staff", () => {
        const result = ask({ subjectTier: "none" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("not Moderation staff");
    });

    it("refuses somebody who has left the team", () => {
        const result = ask({ subjectDeparted: true });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("left the team");
    });

    it("refuses warning yourself", () => {
        const result = ask({ subjectStaffId: issuer });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("cannot warn yourself");
    });

    it("reports the issuer's own rank before anything about the subject", () => {
        // A Lead who aims at an Executive should be told they cannot issue at
        // all, not that Executives are unwarnable — the first is the fact they
        // can act on.
        const result = ask({ issuerTier: "lead", subjectTier: "executive" });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("Executive only");
    });

    it("reports self-warning before departure", () => {
        // Both true for an Executive who has left; "you cannot warn yourself"
        // is the one that explains why the command will never work for them.
        const result = ask({ subjectStaffId: issuer, subjectDeparted: true });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain("cannot warn yourself");
    });
});

describe("the tier arriving from a modal", () => {
    it("accepts the three rungs", () => {
        expect(isConductTier("caution")).toBe(true);
        expect(isConductTier("misconduct")).toBe(true);
        expect(isConductTier("seriousMisconduct")).toBe(true);
    });

    it("rejects anything else, including nothing at all", () => {
        expect(isConductTier(null)).toBe(false);
        expect(isConductTier("")).toBe(false);
        expect(isConductTier("minor")).toBe(false);
        expect(isConductTier("SeriousMisconduct")).toBe(false);
    });
});
