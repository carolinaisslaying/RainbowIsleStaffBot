import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type StaffBotConfig } from "../src/config/guildConfig.js";
import {
    GLOBAL_SCOPE,
    cmd,
    recordCommandIds,
    resetCommandMentions,
    setDefaultMentionGuild
} from "../src/discord/commandMentions.js";

const config: StaffBotConfig = {
    ...DEFAULT_CONFIG,
    publicGuildId: "111111111111111111",
    staffGuildId: "222222222222222222"
};

/** Mirrors the guard in interactionCreate. */
function isAllowedSurface(
    guildId: string | null,
    cfg: StaffBotConfig,
    options: { communityFallback?: boolean; seededAdmin?: boolean } = {}
): boolean {
    if (guildId === null) return true;
    if (guildId === cfg.staffGuildId) return true;
    return (
        guildId === cfg.publicGuildId &&
        options.communityFallback === true &&
        options.seededAdmin === true
    );
}

describe("where the bot answers", () => {
    it("answers in the staff server", () => {
        expect(isAllowedSurface(config.staffGuildId, config)).toBe(true);
    });

    it("answers in a direct message", () => {
        expect(isAllowedSurface(null, config)).toBe(true);
    });

    it("refuses the community server, where 110,000 members would see it", () => {
        expect(isAllowedSurface(config.publicGuildId, config)).toBe(false);
    });

    it("refuses any other guild the bot is added to", () => {
        expect(isAllowedSurface("999999999999999999", config)).toBe(false);
    });
});

describe("the configuration recovery hatch", () => {
    const seeded = { communityFallback: true, seededAdmin: true };

    it("lets a seeded admin configure from the community server", () => {
        expect(isAllowedSurface(config.publicGuildId, config, seeded)).toBe(true);
    });

    it("refuses an ordinary member there, even an Executive", () => {
        expect(
            isAllowedSurface(config.publicGuildId, config, {
                communityFallback: true,
                seededAdmin: false
            })
        ).toBe(false);
    });

    it("refuses a seeded admin running anything else there", () => {
        // The hatch covers configuration alone. Shift and leave stay out of a
        // 110,000 member server whoever is asking.
        expect(
            isAllowedSurface(config.publicGuildId, config, {
                communityFallback: false,
                seededAdmin: true
            })
        ).toBe(false);
    });

    it("does not extend the hatch to some third guild", () => {
        expect(isAllowedSurface("999999999999999999", config, seeded)).toBe(false);
    });
});

describe("command mentions across surfaces", () => {
    it("uses the global registration in a direct message", () => {
        resetCommandMentions();
        recordCommandIds(GLOBAL_SCOPE, [{ id: "dm1", name: "shift" }]);
        recordCommandIds("222222222222222222", [{ id: "staff1", name: "shift" }]);
        setDefaultMentionGuild("222222222222222222");
        // A DM has no guild id, and a staff guild id would not resolve there.
        expect(cmd("shift start", null)).toBe("</shift start:dm1>");
        resetCommandMentions();
    });

    it("uses the staff guild registration inside the staff server", () => {
        resetCommandMentions();
        recordCommandIds(GLOBAL_SCOPE, [{ id: "dm1", name: "shift" }]);
        recordCommandIds("222222222222222222", [{ id: "staff1", name: "shift" }]);
        expect(cmd("shift start", "222222222222222222")).toBe("</shift start:staff1>");
        resetCommandMentions();
    });

    it("falls back to plain text rather than a chip that will not resolve", () => {
        resetCommandMentions();
        recordCommandIds(GLOBAL_SCOPE, [{ id: "dm1", name: "shift" }]);
        expect(cmd("rings", null)).toBe("**/rings**");
        resetCommandMentions();
    });
});
