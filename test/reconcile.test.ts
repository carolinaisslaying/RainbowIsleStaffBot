import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import type { ShiftDoc } from "../src/db/types.js";
import {
    planLeaveRoleRemoval,
    planReconciliation,
    planRoleRestore
} from "../src/domain/reconcile.js";

const NOW = new Date("2026-09-28T12:00:00Z");

let counter = 0;
function seedShift(startedAt: string, staffId = new ObjectId()): ShiftDoc {
    counter += 1;
    return {
        _id: new ObjectId(),
        staffId,
        startedAt: new Date(startedAt),
        endedAt: null,
        endReason: null,
        pauses: [],
        availableMs: 0,
        activityMinutes: 0
    };
}

describe("boot reconciliation against a seeded state", () => {
    it("does nothing when roles and open shifts agree", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-28T10:00:00Z", staffId);
        const plan = planReconciliation({
            roleHolders: ["100"],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(["100"]),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.stripRoleFrom).toEqual([]);
        expect(plan.closeReconciled).toEqual([]);
        expect(plan.closeMaxDuration).toEqual([]);
    });

    it("strips an orphaned role from a member with no open shift", () => {
        const plan = planReconciliation({
            roleHolders: ["100", "200"],
            openShifts: [],
            staffDiscordIds: new Map(),
            presentMembers: new Set(["100", "200"]),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.stripRoleFrom.sort()).toEqual(["100", "200"]);
    });

    it("closes an orphaned shift whose member lost the role while the bot was down", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-28T10:00:00Z", staffId);
        const plan = planReconciliation({
            roleHolders: [],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(["100"]),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeReconciled).toEqual([
            { shiftId: shift._id, staffId, reason: "reconciled" }
        ]);
        expect(plan.stripRoleFrom).toEqual([]);
    });

    it("closes an orphaned shift whose member left the guild entirely", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-28T10:00:00Z", staffId);
        const plan = planReconciliation({
            roleHolders: [],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeReconciled).toHaveLength(1);
        expect(plan.closeReconciled[0].reason).toBe("reconciled");
    });

    it("closes a shift with no resolvable staff record", () => {
        const shift = seedShift("2026-09-28T10:00:00Z");
        const plan = planReconciliation({
            roleHolders: [],
            openShifts: [shift],
            staffDiscordIds: new Map(),
            presentMembers: new Set(),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeReconciled).toHaveLength(1);
    });

    it("closes a shift past the ceiling as max_duration, not reconciled", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-27T20:00:00Z", staffId); // 16 hours old
        const plan = planReconciliation({
            roleHolders: ["100"],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(["100"]),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeMaxDuration).toEqual([
            { shiftId: shift._id, staffId, reason: "max_duration" }
        ]);
        expect(plan.closeReconciled).toEqual([]);
        // The role is now unbacked, so it must come off too.
        expect(plan.stripRoleFrom).toEqual(["100"]);
    });

    it("prefers max_duration over reconciled when both would apply", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-26T00:00:00Z", staffId);
        const plan = planReconciliation({
            roleHolders: [],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeMaxDuration).toHaveLength(1);
        expect(plan.closeReconciled).toHaveLength(0);
    });

    it("leaves a shift exactly at the ceiling open", () => {
        const staffId = new ObjectId();
        const shift = seedShift("2026-09-28T00:00:00Z", staffId); // exactly 12 hours
        const plan = planReconciliation({
            roleHolders: ["100"],
            openShifts: [shift],
            staffDiscordIds: new Map([[staffId.toHexString(), "100"]]),
            presentMembers: new Set(["100"]),
            maxShiftHours: 12,
            now: NOW
        });
        expect(plan.closeMaxDuration).toEqual([]);
    });

    it("handles a mixed guild of orphans in both directions at once", () => {
        const healthy = new ObjectId();
        const stale = new ObjectId();
        const ancient = new ObjectId();

        const plan = planReconciliation({
            roleHolders: ["100", "400"], // 400 wears the role with nothing behind it
            openShifts: [
                seedShift("2026-09-28T09:00:00Z", healthy),
                seedShift("2026-09-28T09:00:00Z", stale), // lost the role
                seedShift("2026-09-27T18:00:00Z", ancient) // 18 hours old
            ],
            staffDiscordIds: new Map([
                [healthy.toHexString(), "100"],
                [stale.toHexString(), "200"],
                [ancient.toHexString(), "300"]
            ]),
            presentMembers: new Set(["100", "200", "300", "400"]),
            maxShiftHours: 12,
            now: NOW
        });

        expect(plan.stripRoleFrom).toEqual(["400"]);
        expect(plan.closeReconciled.map((entry) => entry.staffId)).toEqual([stale]);
        expect(plan.closeMaxDuration.map((entry) => entry.staffId)).toEqual([ancient]);
    });
});

describe("leave role snapshot and restore", () => {
    it("snapshots exactly the roles the member actually holds", () => {
        const removal = planLeaveRoleRemoval(
            new Set(["dept", "rankB", "unrelated"]),
            "dept",
            ["rankA", "rankB", "rankC"]
        );
        expect(removal).toEqual(["dept", "rankB"]);
    });

    it("does not grant a rank the member never had", () => {
        const removal = planLeaveRoleRemoval(new Set(["dept"]), "dept", ["rankA"]);
        expect(removal).toEqual(["dept"]);
        const restore = planRoleRestore(removal, new Set(["dept", "rankA"]));
        expect(restore.restore).toEqual(["dept"]);
    });

    it("restores every snapshotted role that still exists", () => {
        const restore = planRoleRestore(["dept", "rankB"], new Set(["dept", "rankA", "rankB"]));
        expect(restore.restore).toEqual(["dept", "rankB"]);
        expect(restore.errors).toEqual([]);
    });

    it("records a role deleted while the member was away, and restores the rest", () => {
        const restore = planRoleRestore(
            ["dept", "rankB", "rankGone"],
            new Set(["dept", "rankB"])
        );
        expect(restore.restore).toEqual(["dept", "rankB"]);
        expect(restore.errors).toEqual(["rankGone"]);
    });

    it("reports every missing role rather than stopping at the first", () => {
        const restore = planRoleRestore(["a", "b", "c"], new Set(["b"]));
        expect(restore.restore).toEqual(["b"]);
        expect(restore.errors).toEqual(["a", "c"]);
    });
});
