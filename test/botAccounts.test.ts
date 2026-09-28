import type { GuildMember } from "discord.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/guildConfig.js";
import { tierOf } from "../src/domain/permissions.js";
import { conductWarningPermitted } from "../src/domain/conduct.js";
import { botRecordAction } from "../src/domain/botRecords.js";

/**
 * A bot is never staff. This bot once held the Moderation role for a while,
 * picked up a staff record, and stayed on every leaderboard at 0 minutes long
 * after the role was gone. Holding a role is not being a person on the team.
 */
const config = {
    ...DEFAULT_CONFIG,
    moderationDepartmentRole: "mod",
    leadRoles: ["lead"],
    executiveRoles: ["exec"]
};

function member(roles: string[], bot: boolean): GuildMember {
    return {
        user: { bot },
        roles: { cache: new Map(roles.map((role) => [role, {}])) }
    } as unknown as GuildMember;
}

describe("a bot's tier", () => {
    it("is none, whatever roles it holds", () => {
        for (const role of ["mod", "lead", "exec"]) {
            expect(tierOf(member([role], true), config)).toBe("none");
        }
    });

    it("leaves a person with the Moderation role as staff", () => {
        expect(tierOf(member(["mod"], false), config)).toBe("staff");
    });
});

describe("warning a bot for conduct", () => {
    it("is refused, and says it is a bot account", () => {
        const result = conductWarningPermitted({
            issuerTier: "executive",
            subjectTier: "none",
            issuerDiscordId: "1",
            subjectDiscordId: "2",
            subjectIsBot: true,
            subjectDeparted: false
        });
        expect(result).toEqual({
            ok: false,
            reason: "That is a bot account, so it has no staff record."
        });
    });
});

describe("what the boot cleanup does with a staff record", () => {
    it("removes a record whose account is a bot", () => {
        expect(botRecordAction({ kind: "bot" })).toBe("remove");
    });

    it("keeps a record whose account is a person", () => {
        expect(botRecordAction({ kind: "person" })).toBe("keep");
    });

    it("keeps a record it could not look up: not knowing is not knowing it is a bot", () => {
        expect(botRecordAction({ kind: "unknown" })).toBe("keep");
    });
});
