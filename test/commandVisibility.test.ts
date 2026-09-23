import { describe, expect, it } from "vitest";
import { permissionGateFor, visibleInDirectMessages } from "../src/commands/index.js";
import { PermissionFlagsBits } from "discord.js";

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
        for (const name of ["shift", "leave", "stats", "warnings", "settings"]) {
            expect(visibleInDirectMessages(commandsByName.get(name) as never)).toBe(true);
        }
    });
});
