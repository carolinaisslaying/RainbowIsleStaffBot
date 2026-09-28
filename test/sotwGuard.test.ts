import { describe, expect, it } from "vitest";
import { colouredRoleAbove, staffOfWeekRoleOrder } from "../src/config/configGuards.js";

describe("where the Staff of the Week role sits", () => {
    it("says nothing when the feature is off or all is well", () => {
        expect(staffOfWeekRoleOrder(null)).toEqual([]);
        expect(
            staffOfWeekRoleOrder({ missing: false, roleName: "SOTW", aboveBot: false, colouredRoleAbove: null })
        ).toEqual([]);
    });

    it("warns when the bot cannot manage it", () => {
        const [warning] = staffOfWeekRoleOrder({
            missing: false,
            roleName: "SOTW",
            aboveBot: true,
            colouredRoleAbove: null
        });
        expect(warning.key).toBe("staffOfWeekRole");
        expect(warning.text).toMatch(/above the bot/);
    });

    it("warns when a coloured staff role would hide the holder's colour", () => {
        const [warning] = staffOfWeekRoleOrder({
            missing: false,
            roleName: "SOTW",
            aboveBot: false,
            colouredRoleAbove: "Senior Moderator"
        });
        expect(warning.text).toContain("Senior Moderator");
    });

    it("warns when the role no longer exists", () => {
        expect(
            staffOfWeekRoleOrder({ missing: true, roleName: "123", aboveBot: false, colouredRoleAbove: null })[0].text
        ).toMatch(/does not exist/);
    });

    it("finds the highest coloured role above it, ignoring uncoloured ones", () => {
        expect(
            colouredRoleAbove(5, [
                { name: "Plain", position: 9, colour: 0 },
                { name: "Lead", position: 8, colour: 0xff0000 },
                { name: "Senior", position: 7, colour: 0x00ff00 },
                { name: "Below", position: 2, colour: 0x0000ff }
            ])
        ).toBe("Lead");
        expect(colouredRoleAbove(5, [{ name: "Below", position: 2, colour: 1 }])).toBeNull();
    });
});
