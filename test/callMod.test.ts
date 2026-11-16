import { describe, expect, it } from "vitest";
import { MessageFlags } from "discord.js";
import { CallModLimiter, callModRefusalText } from "../src/domain/callMod.js";
import { callModCard, callModRefusalCard } from "../src/render/callMod.js";
import { DEFAULT_CONFIG } from "../src/config/guildConfig.js";

const MIN = 60_000;
const cooldowns = { userMinutes: 30, serverMinutes: 5 };

describe("/callmod cooldowns", () => {
    it("ships at 30 minutes per member and 5 for the server", () => {
        expect(DEFAULT_CONFIG.callModUserCooldownMinutes).toBe(30);
        expect(DEFAULT_CONFIG.callModServerCooldownMinutes).toBe(5);
    });

    it("lets the first call through", () => {
        expect(new CallModLimiter().claim("a", 0, cooldowns)).toBeNull();
    });

    it("holds the whole server for five minutes", () => {
        const limiter = new CallModLimiter();
        limiter.claim("a", 0, cooldowns);
        expect(limiter.claim("b", 4 * MIN, cooldowns)).toBe("server");
        expect(limiter.claim("b", 5 * MIN, cooldowns)).toBeNull();
    });

    it("holds one member for thirty, and tells them that rather than the server's five", () => {
        const limiter = new CallModLimiter();
        limiter.claim("a", 0, cooldowns);
        expect(limiter.claim("a", 1 * MIN, cooldowns)).toBe("user");
        expect(limiter.claim("a", 29 * MIN, cooldowns)).toBe("user");
        expect(limiter.claim("a", 30 * MIN, cooldowns)).toBeNull();
    });

    it("does not start a clock on a refused call", () => {
        const limiter = new CallModLimiter();
        limiter.claim("a", 0, cooldowns);
        expect(limiter.claim("b", 4 * MIN, cooldowns)).toBe("server");
        // b was refused at 4, so b's own 30 minutes never started.
        expect(limiter.claim("b", 6 * MIN, cooldowns)).toBeNull();
    });

    it("gives a claim back when the call never posted", () => {
        const limiter = new CallModLimiter();
        limiter.claim("a", 0, cooldowns);
        limiter.release("a", 0);
        expect(limiter.claim("a", 1, cooldowns)).toBeNull();
    });

    it("does not release a newer claim with an older one's time", () => {
        const limiter = new CallModLimiter();
        limiter.claim("a", 0, cooldowns);
        limiter.claim("b", 10 * MIN, cooldowns);
        limiter.release("a", 0);
        expect(limiter.claim("c", 11 * MIN, cooldowns)).toBe("server");
    });

    it("turns a clock off at zero", () => {
        const limiter = new CallModLimiter();
        const off = { userMinutes: 0, serverMinutes: 0 };
        limiter.claim("a", 0, off);
        expect(limiter.claim("a", 0, off)).toBeNull();
    });

    it("refuses in the agreed words, with the configured figures", () => {
        expect(callModRefusalText("server", cooldowns)).toBe(
            "This command can only be ran on the server every 5 minutes."
        );
        expect(callModRefusalText("user", cooldowns)).toBe(
            "You can only run this command every 30 minutes."
        );
        expect(callModRefusalText("user", { userMinutes: 1, serverMinutes: 5 })).toBe(
            "You can only run this command every minute."
        );
    });
});

describe("the /callmod card", () => {
    const json = (roleId: string) => JSON.stringify(callModCard(roleId, "</callmod:42>").components[0]);

    it("is public, and a refusal is not", () => {
        expect(callModCard("1", "</callmod:1>").flags & MessageFlags.Ephemeral).toBe(0);
        expect(callModRefusalCard("x").flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
        expect(callModCard("1", "</callmod:1>").flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    });

    it("pings the available role as subtext", () => {
        expect(json("779755563776081921")).toContain("-# <@&779755563776081921>");
    });

    it("leaves the ping out when no role is configured", () => {
        expect(json("")).not.toContain("<@&");
    });

    it("names the command as a clickable mention", () => {
        expect(json("1")).toContain(
            "-# The </callmod:42> command should only be used in the event of discriminatory " +
                "behaviour, slurs, raider, or other serious rule breach."
        );
        expect(json("1")).not.toContain("`/callmod`");
    });

    it("leads with the alarm", () => {
        expect(json("1")).toContain("# 🚨 Moderators Called");
    });
});
