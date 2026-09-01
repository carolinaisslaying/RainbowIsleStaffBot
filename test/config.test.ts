import { afterEach, describe, expect, it } from "vitest";
import { parseConfigValue } from "../src/config/guildConfig.js";
import { isBootstrapAdmin } from "../src/domain/permissions.js";

const ROLE = "123456789012345678";

afterEach(() => {
    delete process.env.BOOTSTRAP_ADMIN_IDS;
});

describe("config value parsing", () => {
    it("accepts a bare snowflake for a role key", () => {
        expect(parseConfigValue("availabilityRole", ROLE)).toEqual({ ok: true, value: ROLE });
    });

    it("accepts a pasted role mention and stores the ID underneath", () => {
        expect(parseConfigValue("availabilityRole", `<@&${ROLE}>`)).toEqual({
            ok: true,
            value: ROLE
        });
    });

    it("accepts a pasted channel mention for a channel key", () => {
        expect(parseConfigValue("leaveChannelId", `<#${ROLE}>`)).toEqual({
            ok: true,
            value: ROLE
        });
    });

    it("rejects a role name typed instead of an ID", () => {
        const result = parseConfigValue("moderationDepartmentRole", "Moderator");
        expect(result.ok).toBe(false);
        expect(result.error).toContain("Expected a Discord ID");
    });

    it("rejects an empty value", () => {
        expect(parseConfigValue("onLeaveRole", "   ").ok).toBe(false);
    });

    it("parses a list from mentions, spaces and commas together", () => {
        const result = parseConfigValue("staffRankRoles", `<@&${ROLE}>, 234567890123456789`);
        expect(result).toEqual({ ok: true, value: [ROLE, "234567890123456789"] });
    });

    it("rejects a list containing a non-snowflake", () => {
        const result = parseConfigValue("leadRoles", `${ROLE} Moderator`);
        expect(result.ok).toBe(false);
    });

    it("validates numeric bounds", () => {
        expect(parseConfigValue("amberThresholdPercent", "75")).toEqual({ ok: true, value: 75 });
        expect(parseConfigValue("amberThresholdPercent", "0").ok).toBe(false);
        expect(parseConfigValue("amberThresholdPercent", "100").ok).toBe(false);
        expect(parseConfigValue("weeklyActiveDaysTarget", "8").ok).toBe(false);
    });

    it("parses booleans in the forms people actually type", () => {
        for (const yes of ["true", "yes", "on", "1", "enabled"]) {
            expect(parseConfigValue("softRingsEnabled", yes)).toEqual({ ok: true, value: true });
        }
        for (const no of ["false", "no", "off", "0", "disabled"]) {
            expect(parseConfigValue("softRingsEnabled", no)).toEqual({ ok: true, value: false });
        }
        expect(parseConfigValue("softRingsEnabled", "maybe").ok).toBe(false);
    });

    it("rejects a fixed offset as an accounting timezone", () => {
        expect(parseConfigValue("accountingTimezone", "UTC+13").ok).toBe(false);
        expect(parseConfigValue("accountingTimezone", "Pacific/Auckland")).toEqual({
            ok: true,
            value: "Pacific/Auckland"
        });
    });

    it("normalises the fortnight anchor to an ISO instant", () => {
        expect(parseConfigValue("fortnightAnchor", "2026-09-28T00:00:00Z")).toEqual({
            ok: true,
            value: "2026-09-28T00:00:00.000Z"
        });
        expect(parseConfigValue("fortnightAnchor", "not a date").ok).toBe(false);
    });

    it("bounds the week start day to a real weekday", () => {
        expect(parseConfigValue("weekStartDay", "1")).toEqual({ ok: true, value: 1 });
        expect(parseConfigValue("weekStartDay", "7").ok).toBe(false);
        expect(parseConfigValue("weekStartDay", "-1").ok).toBe(false);
    });
});

describe("bootstrap escape hatch", () => {
    it("is empty when the variable is unset, so it is not a standing backdoor", () => {
        expect(isBootstrapAdmin("111111111111111111")).toBe(false);
    });

    it("recognises a configured admin", () => {
        process.env.BOOTSTRAP_ADMIN_IDS = "111111111111111111";
        expect(isBootstrapAdmin("111111111111111111")).toBe(true);
        expect(isBootstrapAdmin("222222222222222222")).toBe(false);
    });

    it("accepts several IDs separated by commas or spaces", () => {
        process.env.BOOTSTRAP_ADMIN_IDS = "111111111111111111, 222222222222222222";
        expect(isBootstrapAdmin("111111111111111111")).toBe(true);
        expect(isBootstrapAdmin("222222222222222222")).toBe(true);
    });

    it("ignores anything that is not a snowflake", () => {
        process.env.BOOTSTRAP_ADMIN_IDS = "not-an-id, 111111111111111111";
        expect(isBootstrapAdmin("not-an-id")).toBe(false);
        expect(isBootstrapAdmin("111111111111111111")).toBe(true);
    });
});

describe("server names", () => {
    it("falls back to the Rainbow Isle names before anything is fetched", async () => {
        const { publicGuildName, staffGuildName, FALLBACK_PUBLIC, FALLBACK_STAFF } = await import(
            "../src/discord/guildNames.js"
        );
        expect(FALLBACK_PUBLIC).toBe("Rainbow Isle");
        expect(FALLBACK_STAFF).toBe("Rainbow Isle: Offices");
        expect(publicGuildName()).toBe(FALLBACK_PUBLIC);
        expect(staffGuildName()).toBe(FALLBACK_STAFF);
    });

    it("uses whatever Discord actually calls the servers once resolved", async () => {
        const { publicGuildName, staffGuildName, setGuildNamesForTest } = await import(
            "../src/discord/guildNames.js"
        );
        // A rename must be picked up without a code change.
        setGuildNamesForTest("Rainbow Isle 🌈", "Rainbow Isle: Head Office");
        expect(publicGuildName()).toBe("Rainbow Isle 🌈");
        expect(staffGuildName()).toBe("Rainbow Isle: Head Office");
        setGuildNamesForTest("Rainbow Isle", "Rainbow Isle: Offices");
    });
});

describe("command mentions", () => {
    it("renders a clickable chip once the id is known", async () => {
        const { cmd, recordCommandIds, resetCommandMentions } = await import(
            "../src/discord/commandMentions.js"
        );
        resetCommandMentions();
        recordCommandIds("999", [{ id: "555", name: "timezone" }]);
        // A subcommand mention carries the ROOT command's id.
        expect(cmd("timezone set", "999")).toBe("</timezone set:555>");
        expect(cmd("timezone", "999")).toBe("</timezone:555>");
        resetCommandMentions();
    });

    it("falls back to a bold command name rather than a broken chip", async () => {
        const { cmd, resetCommandMentions } = await import("../src/discord/commandMentions.js");
        resetCommandMentions();
        // Unknown id: raw `</name:id>` with a wrong id renders as literal text
        // in Discord, which is worse than plain backticks.
        expect(cmd("shift start", "999")).toBe("**/shift start**");
        resetCommandMentions();
    });

    it("uses the default guild when there is no guild context, as in a DM", async () => {
        const { cmd, recordCommandIds, setDefaultMentionGuild, resetCommandMentions } =
            await import("../src/discord/commandMentions.js");
        resetCommandMentions();
        recordCommandIds("public-1", [{ id: "777", name: "shift" }]);
        setDefaultMentionGuild("public-1");
        expect(cmd("shift start")).toBe("</shift start:777>");
        resetCommandMentions();
    });

    it("does not borrow another guild's id for the requested guild", async () => {
        const { cmd, recordCommandIds, resetCommandMentions } = await import(
            "../src/discord/commandMentions.js"
        );
        resetCommandMentions();
        // Same command, different id per guild. With no default set there is
        // nothing to fall back to, so it must degrade to backticks.
        recordCommandIds("guild-a", [{ id: "111", name: "rings" }]);
        expect(cmd("rings", "guild-b")).toBe("**/rings**");
        expect(cmd("rings", "guild-a")).toBe("</rings:111>");
        resetCommandMentions();
    });
});
