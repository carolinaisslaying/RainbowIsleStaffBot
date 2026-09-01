import { describe, expect, it, vi, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import type { LeaveDoc } from "../src/db/types.js";
import { holdsUnrestoredRoles } from "../src/domain/leavePurge.js";
import { pendingCount, stage } from "../src/events/leaveConfirm.js";

function leave(overrides: Partial<LeaveDoc> = {}): LeaveDoc {
    return {
        _id: new ObjectId(),
        staffId: new ObjectId(),
        requestedAt: new Date("2026-09-01T00:00:00Z"),
        startDate: new Date("2026-10-01T00:00:00Z"),
        endDate: new Date("2026-10-15T00:00:00Z"),
        reason: "a fortnight away",
        status: "approved",
        decidedBy: new ObjectId(),
        decidedAt: new Date("2026-09-02T00:00:00Z"),
        removedRoles: [],
        rolesRestoredAt: null,
        restoreErrors: [],
        ...overrides
    };
}

describe("the guard that stops a purge stranding someone", () => {
    it("refuses while leave is running and the roles are still set aside", () => {
        // The record is the only list of what to give back. Destroy it and the
        // member is left stripped with nothing anywhere saying what they held.
        expect(
            holdsUnrestoredRoles(
                leave({ status: "active", removedRoles: ["111", "222"], rolesRestoredAt: null })
            )
        ).toBe(true);
    });

    it("allows it once the roles have gone back", () => {
        expect(
            holdsUnrestoredRoles(
                leave({
                    status: "active",
                    removedRoles: ["111"],
                    rolesRestoredAt: new Date("2026-10-15T00:00:00Z")
                })
            )
        ).toBe(false);
    });

    it("allows it when the leave never took any roles away", () => {
        // Approved but not yet started: nothing has been touched, so there is
        // nothing to strand.
        expect(holdsUnrestoredRoles(leave({ status: "active", removedRoles: [] }))).toBe(false);
        expect(holdsUnrestoredRoles(leave({ status: "approved" }))).toBe(false);
    });

    it("allows it for leave that is over or was never granted", () => {
        expect(
            holdsUnrestoredRoles(leave({ status: "ended", removedRoles: ["111"] }))
        ).toBe(false);
        expect(
            holdsUnrestoredRoles(leave({ status: "declined", removedRoles: ["111"] }))
        ).toBe(false);
    });
});

describe("the half-finished request waiting to be confirmed", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("hands back a token that is not guessable from the request", () => {
        const token = stage({
            kind: "request",
            staffId: new ObjectId(),
            discordId: "1100295355800748073",
            displayName: "Ash",
            startDate: new Date("2026-10-06T00:00:00Z"),
            endDate: new Date("2026-10-16T00:00:00Z"),
            reason: "away"
        });
        expect(token).toMatch(/^[0-9a-f]{16}$/);
    });

    it("forgets a draft nobody confirmed, so abandoned forms are not a store", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));

        const before = pendingCount();
        stage({
            kind: "request",
            staffId: new ObjectId(),
            discordId: "1",
            displayName: "Ash",
            startDate: new Date("2026-10-06T00:00:00Z"),
            endDate: new Date("2026-10-16T00:00:00Z"),
            reason: "away"
        });
        expect(pendingCount()).toBe(before + 1);

        vi.setSystemTime(new Date("2026-09-01T00:14:00Z"));
        expect(pendingCount()).toBe(before + 1);

        vi.setSystemTime(new Date("2026-09-01T00:16:00Z"));
        expect(pendingCount()).toBe(before);
    });
});
