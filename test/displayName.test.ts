import { describe, expect, it } from "vitest";
import { preferredName } from "../src/discord/displayName.js";

/**
 * The precedence rule alone. The fetching around it needs a Discord fixture,
 * which this suite deliberately does not have; what matters here is that the
 * staff server's name wins whenever there is one.
 */
describe("which name gets printed", () => {
    it("prefers the staff server's nickname over the community one", () => {
        // The whole point of the rule: cards are read in the staff server, so
        // they carry the name the staff server uses.
        expect(preferredName(["Cass (Mod)", "xX_dragonlord_Xx"], "fallback")).toBe("Cass (Mod)");
    });

    it("falls back to the community name for someone not in the staff server", () => {
        expect(preferredName([null, "Robin"], "fallback")).toBe("Robin");
    });

    it("uses the last resort only when neither guild knows them", () => {
        // A departed member on a historical record: the leaderboard passes a
        // mention here so the row still points at a person.
        expect(preferredName([null, null], "<@123>")).toBe("<@123>");
    });

    it("treats a blank nickname as no nickname", () => {
        // An empty name renders as an empty bold line where the member should
        // be, which reads as a broken card rather than as a missing name.
        expect(preferredName(["   ", "Robin"], "fallback")).toBe("Robin");
        expect(preferredName(["", ""], "You")).toBe("You");
    });

    it("trims a name rather than printing its padding", () => {
        expect(preferredName([" Cass "], "fallback")).toBe("Cass");
    });

    it("skips a guild the bot could not read at all", () => {
        // staffDisplayName pushes nothing for an unconfigured guild id, so the
        // list it passes can be shorter than two.
        expect(preferredName([], "You")).toBe("You");
        expect(preferredName([undefined, "Robin"], "You")).toBe("Robin");
    });
});
