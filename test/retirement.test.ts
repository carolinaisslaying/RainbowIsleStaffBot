import { describe, expect, it } from "vitest";
import {
    appearsInClosedWeek,
    isOnLeaveNow,
    retiredSpans,
    retirementAction,
    staffRolesProblem,
    sweepOverThreshold
} from "../src/domain/retirement.js";

import { noLongerOnTeamLine, withRetiredLine } from "../src/render/retired.js";

const base = { active: true, seeded: false, onLeave: false };
const present = (hasTier: boolean) => ({ kind: "present", hasTier }) as const;

describe("who is on the team", () => {
    it("retires somebody without a tier", () => {
        expect(retirementAction({ ...base, reading: present(false) })).toEqual({
            kind: "retire",
            cause: "role_removed"
        });
    });

    it("keeps somebody leave took the role from", () => {
        expect(retirementAction({ ...base, onLeave: true, reading: present(false) })).toEqual({
            kind: "none"
        });
    });

    it("retires somebody who left the server, on leave or not", () => {
        for (const onLeave of [true, false]) {
            expect(retirementAction({ ...base, onLeave, reading: { kind: "absent" } })).toEqual({
                kind: "retire",
                cause: "left_server"
            });
        }
    });

    it("does nothing when the lookup failed", () => {
        for (const active of [true, false]) {
            expect(
                retirementAction({ ...base, active, reading: { kind: "unknown" } })
            ).toEqual({ kind: "none" });
        }
    });

    it("brings somebody back when they hold a tier again", () => {
        expect(retirementAction({ ...base, active: false, reading: present(true) })).toEqual({
            kind: "return"
        });
    });

    it("does not bring back somebody who rejoined the server with no role", () => {
        expect(retirementAction({ ...base, active: false, reading: present(false) })).toEqual({
            kind: "none"
        });
    });

    it("never retires a seeded admin, whatever the reading", () => {
        for (const reading of [present(false), { kind: "absent" } as const]) {
            expect(retirementAction({ ...base, seeded: true, reading })).toEqual({ kind: "none" });
        }
    });

    it("puts back a seeded admin who was retired before being named", () => {
        expect(
            retirementAction({ ...base, active: false, seeded: true, reading: { kind: "absent" } })
        ).toEqual({ kind: "return" });
    });
});

describe("whether leave explains a missing role", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const past = new Date("2026-11-01T00:00:00Z");
    const future = new Date("2026-11-03T00:00:00Z");

    it("counts approved leave whose start has arrived, because activation takes the roles first", () => {
        expect(isOnLeaveNow([{ status: "approved", startDate: past }], false, now)).toBe(true);
    });

    it("does not count approved leave still to come", () => {
        expect(isOnLeaveNow([{ status: "approved", startDate: future }], false, now)).toBe(false);
    });

    it("does not count a pending request", () => {
        expect(isOnLeaveNow([{ status: "pending", startDate: past }], false, now)).toBe(false);
    });

    it("counts active leave and the on-leave role", () => {
        expect(isOnLeaveNow([{ status: "active", startDate: past }], false, now)).toBe(true);
        expect(isOnLeaveNow([], true, now)).toBe(true);
    });
});

describe("whether the role settings can be trusted", () => {
    const roles = { moderationDepartmentRole: "m", leadRoles: ["l"], executiveRoles: ["e"] };

    it("accepts roles that all exist", () => {
        expect(staffRolesProblem(roles, new Set(["m", "l", "e"]))).toBeNull();
    });

    it("refuses an unset department role, even with the others set", () => {
        expect(
            staffRolesProblem({ ...roles, moderationDepartmentRole: "" }, new Set(["l", "e"]))
        ).toContain("unset");
    });

    it("refuses a deleted role of any kind", () => {
        expect(staffRolesProblem(roles, new Set(["l", "e"]))).toContain("moderationDepartmentRole");
        expect(staffRolesProblem(roles, new Set(["m", "e"]))).toContain("leadRoles");
        expect(staffRolesProblem(roles, new Set(["m", "l"]))).toContain("executiveRoles");
    });
});

describe("the sweep's threshold", () => {
    it("allows exactly a quarter and stops above it", () => {
        expect(sweepOverThreshold(4, 16)).toBe(false);
        expect(sweepOverThreshold(5, 16)).toBe(true);
    });

    it("has nothing to say about an empty roster", () => {
        expect(sweepOverThreshold(0, 0)).toBe(false);
    });
});

describe("closed weeks", () => {
    it("lists a retired person only with minutes, and current staff always", () => {
        expect(appearsInClosedWeek({ active: false, minutes: 0 })).toBe(false);
        expect(appearsInClosedWeek({ active: false, minutes: 12 })).toBe(true);
        expect(appearsInClosedWeek({ active: true, minutes: 0 })).toBe(true);
    });
});

describe("time off the team", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const a = new Date("2026-10-01T00:00:00Z");
    const b = new Date("2026-10-02T00:00:00Z");

    it("covers past periods and the current one", () => {
        expect(retiredSpans({ retiredAt: b, retiredPeriods: [{ from: a, to: b }] }, now)).toEqual([
            { startDate: a, endDate: b },
            { startDate: b, endDate: now }
        ]);
    });

    it("is empty for somebody never retired", () => {
        expect(retiredSpans({}, now)).toEqual([]);
    });
});

describe("the lookup line", () => {
    const retiredAt = new Date("2026-11-03T00:00:00Z");

    it("says since when and why", () => {
        expect(noLongerOnTeamLine({ retiredAt, retiredCause: "role_removed" })).toContain(
            "role removed"
        );
        expect(noLongerOnTeamLine({ retiredAt, retiredCause: "left_server" })).toContain(
            "left the server"
        );
    });

    it("leaves a card for somebody on the team alone", () => {
        const message = { components: [], files: [] } as never;
        expect(withRetiredLine(message, { active: true })).toBe(message);
    });

    it("opens the card with it for somebody off the team", () => {
        const message = { components: [], files: [] } as never;
        const result = withRetiredLine(message, { active: false, retiredAt });
        expect(result.components).toHaveLength(1);
    });
});
