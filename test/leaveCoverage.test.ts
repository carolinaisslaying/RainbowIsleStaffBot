import { describe, expect, it } from "vitest";
import { coverageOf } from "../src/domain/leave.js";
import { permissionGateFor, visibleInDirectMessages } from "../src/commands/index.js";
import { PermissionFlagsBits } from "discord.js";

const monday = new Date("2026-10-05T00:00:00Z");
const nextMonday = new Date("2026-10-12T00:00:00Z");

function leave(start: string, end: string | null) {
    return { startDate: new Date(start), endDate: end ? new Date(end) : null };
}

describe("how much of a week leave actually covers", () => {
    it("reports nothing when there is no leave", () => {
        expect(coverageOf([], monday, nextMonday)).toEqual({
            full: false,
            partial: false,
            endedAt: null,
            startedAt: null
        });
    });

    it("covers the week when leave spans the whole of it", () => {
        const coverage = coverageOf(
            [leave("2026-09-28T00:00:00Z", "2026-10-20T00:00:00Z")],
            monday,
            nextMonday
        );
        expect(coverage.full).toBe(true);
        expect(coverage.partial).toBe(false);
    });

    it("treats open ended leave already running as covering the week", () => {
        expect(coverageOf([leave("2026-09-01T00:00:00Z", null)], monday, nextMonday).full).toBe(
            true
        );
    });

    it("does not cover a week the leave ended part way through", () => {
        // The bug this exists for: leave ending on the Wednesday used to grey
        // the whole week and hide the four days that were actually worked.
        const coverage = coverageOf(
            [leave("2026-09-28T00:00:00Z", "2026-10-07T12:00:00Z")],
            monday,
            nextMonday
        );
        expect(coverage.full).toBe(false);
        expect(coverage.partial).toBe(true);
        expect(coverage.endedAt?.toISOString()).toBe("2026-10-07T12:00:00.000Z");
        expect(coverage.startedAt).toBeNull();
    });

    it("does not cover a week the leave starts part way through", () => {
        const coverage = coverageOf(
            [leave("2026-10-08T09:00:00Z", "2026-10-30T00:00:00Z")],
            monday,
            nextMonday
        );
        expect(coverage.full).toBe(false);
        expect(coverage.partial).toBe(true);
        expect(coverage.startedAt?.toISOString()).toBe("2026-10-08T09:00:00.000Z");
        expect(coverage.endedAt).toBeNull();
    });

    it("covers the week when two back to back records span it between them", () => {
        const coverage = coverageOf(
            [
                leave("2026-09-28T00:00:00Z", "2026-10-08T00:00:00Z"),
                leave("2026-10-07T00:00:00Z", "2026-10-14T00:00:00Z")
            ],
            monday,
            nextMonday
        );
        expect(coverage.full).toBe(true);
    });

    it("does not cover the week when two records leave a gap in the middle", () => {
        const coverage = coverageOf(
            [
                leave("2026-09-28T00:00:00Z", "2026-10-06T00:00:00Z"),
                leave("2026-10-09T00:00:00Z", "2026-10-14T00:00:00Z")
            ],
            monday,
            nextMonday
        );
        expect(coverage.full).toBe(false);
        expect(coverage.partial).toBe(true);
    });

    it("ignores leave that finishes before the week opens", () => {
        expect(
            coverageOf([leave("2026-09-01T00:00:00Z", "2026-10-04T00:00:00Z")], monday, nextMonday)
        ).toEqual({ full: false, partial: false, endedAt: null, startedAt: null });
    });
});

describe("who can see which command", () => {
    it("gates Executive commands behind Manage Guild in the staff server", () => {
        expect(permissionGateFor({ tier: "executive" } as never)).toBe(
            String(PermissionFlagsBits.ManageGuild)
        );
    });

    it("gates Lead commands behind Moderate Members", () => {
        expect(permissionGateFor({ tier: "lead" } as never)).toBe(
            String(PermissionFlagsBits.ModerateMembers)
        );
    });

    it("leaves Staff commands ungated, because every Moderator needs them", () => {
        expect(permissionGateFor({ tier: "staff" } as never)).toBeNull();
    });

    it("offers only Staff tier commands in a DM, where no gate exists", () => {
        expect(visibleInDirectMessages({ tier: "staff" } as never)).toBe(true);
        expect(visibleInDirectMessages({ tier: "lead" } as never)).toBe(false);
        expect(visibleInDirectMessages({ tier: "executive" } as never)).toBe(false);
    });

    it("keeps /config and /admin out of the DM picker entirely", async () => {
        const { commandsByName } = await import("../src/commands/index.js");
        for (const name of ["config", "admin", "coverage"]) {
            expect(visibleInDirectMessages(commandsByName.get(name) as never)).toBe(false);
        }
        for (const name of ["shift", "rings", "leave", "leaderboard", "timezone"]) {
            expect(visibleInDirectMessages(commandsByName.get(name) as never)).toBe(true);
        }
    });
});
