import { describe, expect, it } from "vitest";
import { exportConfig, readImport } from "../src/config/configTransfer.js";
import { CONFIG_KEYS, DEFAULT_CONFIG, type StaffBotConfig } from "../src/config/guildConfig.js";

const current: StaffBotConfig = {
    ...DEFAULT_CONFIG,
    publicGuildId: "111111111111111111",
    staffGuildId: "222222222222222222",
    moderationDepartmentRole: "333333333333333333",
    executiveRoles: ["444444444444444444"],
    weeklyTargetMinutes: 120
};

const ROLE = "555555555555555555";

describe("exporting", () => {
    it("writes every configuration key, so a paste back is a whole restore", () => {
        const parsed = JSON.parse(exportConfig(current));
        expect(Object.keys(parsed).sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
    });

    it("orders keys the same way every time, so two exports diff cleanly", () => {
        const shuffled = { ...current } as Record<string, unknown>;
        delete shuffled.weeklyTargetMinutes;
        shuffled.weeklyTargetMinutes = 120;
        expect(exportConfig(shuffled as StaffBotConfig)).toBe(exportConfig(current));
    });

    it("round trips through the reader with nothing to change", () => {
        const report = readImport(exportConfig(current), current);
        expect(report.changes).toEqual([]);
        expect(report.unchanged.length).toBe(Object.keys(CONFIG_KEYS).length);
    });
});

describe("importing part of a file", () => {
    it("applies only the keys the paste names", () => {
        const report = readImport('{"weeklyTargetMinutes": 200}', current);
        expect(report.ok).toBe(true);
        expect(report.changes).toEqual([
            { key: "weeklyTargetMinutes", from: 120, to: 200, relocating: false }
        ]);
    });

    it("leaves out keys that already hold the value they name", () => {
        const report = readImport(
            '{"weeklyTargetMinutes": 120, "weeklyActiveDaysTarget": 5}',
            current
        );
        expect(report.unchanged).toEqual(["weeklyTargetMinutes"]);
        expect(report.changes.map((change) => change.key)).toEqual(["weeklyActiveDaysTarget"]);
    });

    it("refuses a file that would change nothing at all", () => {
        // Applying it would be a no-op, and reporting success for a no-op reads
        // as "the import worked" when the operator pasted the wrong file.
        const report = readImport('{"weeklyTargetMinutes": 120}', current);
        expect(report.ok).toBe(false);
        expect(report.problems[0]).toContain("already holds the value");
    });

    it("marks the two keys that move the bot to another server", () => {
        const report = readImport('{"staffGuildId": "999999999999999999"}', current);
        expect(report.changes[0].relocating).toBe(true);
        expect(readImport('{"weeklyTargetMinutes": 60}', current).changes[0].relocating).toBe(
            false
        );
    });
});

describe("importing is all or nothing", () => {
    it("applies none of a file when one key is wrong", () => {
        // A half applied configuration is harder to diagnose than one refused.
        const report = readImport(
            `{"weeklyTargetMinutes": 200, "moderationDepartmentRole": "not-an-id"}`,
            current
        );
        expect(report.ok).toBe(false);
        expect(report.changes).toEqual([]);
    });

    it("names every problem at once rather than one attempt at a time", () => {
        const report = readImport(
            `{"nosuchkey": 1, "weeklyTargetMinutes": "abc", "executiveRoles": "${ROLE}"}`,
            current
        );
        expect(report.problems).toHaveLength(3);
        expect(report.problems.join(" ")).toContain("nosuchkey");
        expect(report.problems.join(" ")).toContain("weeklyTargetMinutes");
        expect(report.problems.join(" ")).toContain("executiveRoles");
    });

    it("refuses an unknown key instead of ignoring it", () => {
        // A typo that imports silently looks exactly like a setting that did
        // not take, and the operator goes looking in the wrong place.
        const report = readImport('{"weeklyTargetMinuts": 200}', current);
        expect(report.ok).toBe(false);
        expect(report.problems[0]).toContain("not a configuration key");
    });
});

describe("shape is checked before content", () => {
    it("refuses a list where one value belongs", () => {
        const report = readImport(`{"moderationDepartmentRole": ["${ROLE}"]}`, current);
        expect(report.problems[0]).toContain("expects one value");
    });

    it("refuses one value where a list belongs", () => {
        // Without this the string would be stringified and then happen to
        // validate as a one item list, importing something nobody wrote.
        const report = readImport(`{"executiveRoles": "${ROLE}"}`, current);
        expect(report.problems[0]).toContain("expects a list");
    });

    it("refuses a string standing in for a boolean", () => {
        expect(readImport('{"softRingsEnabled": "yes"}', current).problems[0]).toContain(
            "true or false"
        );
        expect(readImport('{"softRingsEnabled": false}', current).ok).toBe(true);
    });

    it("refuses a null rather than writing one into the document", () => {
        expect(readImport('{"weeklyTargetMinutes": null}', current).problems[0]).toContain(
            "no value"
        );
    });
});

describe("bad input never throws", () => {
    for (const [label, raw] of [
        ["plain prose", "hello"],
        ["a truncated paste", '{"weeklyTargetMinutes": 20'],
        ["an array", "[1, 2, 3]"],
        ["a bare string", '"config"'],
        ["null", "null"],
        ["an empty object", "{}"],
        ["nothing at all", ""]
    ] as const) {
        it(`reports ${label} instead of failing`, () => {
            const report = readImport(raw, current);
            expect(report.ok).toBe(false);
            expect(report.problems.length).toBeGreaterThan(0);
        });
    }
});

describe("values arrive typed and still meet the command's rules", () => {
    it("accepts role mentions the way /config set does", () => {
        const report = readImport(`{"executiveRoles": ["<@&${ROLE}>"]}`, current);
        expect(report.changes[0].to).toEqual([ROLE]);
    });

    it("holds a timezone to the same check", () => {
        expect(readImport('{"accountingTimezone": "Not/AZone"}', current).ok).toBe(false);
        expect(readImport('{"accountingTimezone": "Pacific/Auckland"}', current).ok).toBe(true);
    });

    it("holds a number to the bounds the key declares", () => {
        const spec = CONFIG_KEYS.amberThresholdPercent;
        expect(spec.max).toBeDefined();
        const report = readImport(
            `{"amberThresholdPercent": ${(spec.max ?? 100) + 1}}`,
            current
        );
        expect(report.ok).toBe(false);
    });
});

describe("a half configured deployment can still be exported and read back", () => {
    // The bots most likely to want an export are the ones mid setup, which
    // carry empty roles and empty channels. Refusing to read those back would
    // leave export working only where it is least needed.
    const fresh = { ...DEFAULT_CONFIG, publicGuildId: "111111111111111111" };

    it("round trips a config with unset keys, reading every one of them back", () => {
        const report = readImport(exportConfig(fresh), fresh);
        // Nothing rejected, and nothing to change, which is the right answer
        // for a file exported from the very config it is read against.
        expect(report.unchanged.length).toBe(Object.keys(CONFIG_KEYS).length);
        expect(report.problems).toEqual([
            "Every key in that file already holds the value it names."
        ]);
    });

    it("treats clearing a key that may be empty as a change, not an error", () => {
        const report = readImport('{"onLeaveRole": ""}', {
            ...current,
            onLeaveRole: "666666666666666666"
        });
        expect(report.ok).toBe(true);
        expect(report.changes[0]).toEqual({
            key: "onLeaveRole",
            from: "666666666666666666",
            to: "",
            relocating: false
        });
    });

    it("refuses to empty a key whose default is a real value", () => {
        // accountingTimezone defines every week boundary the team is measured
        // on. A paste must not be able to blank it.
        expect(DEFAULT_CONFIG.accountingTimezone).not.toBe("");
        const report = readImport('{"accountingTimezone": ""}', current);
        expect(report.ok).toBe(false);
        expect(report.problems[0]).toContain("cannot be emptied");
    });
});

describe("the cards the operator actually sees", () => {
    const NAMES = new Map([["111111111111111111", "Rainbow Isle"]]);

    it("hands the export over as a file, not as a wall of text", async () => {
        const { configExportCard } = await import("../src/render/configCards.js");
        const card = configExportCard(current);
        expect(card.files).toHaveLength(1);
        expect(card.files[0].name).toMatch(/^staffbot-config-\d{4}-\d{2}-\d{2}\.json$/);
        expect(JSON.parse(card.files[0].attachment.toString())).toMatchObject({
            weeklyTargetMinutes: 120
        });
    });

    it("keeps the export private to whoever asked for it", async () => {
        // It names every role and channel the bot touches.
        const { configExportCard } = await import("../src/render/configCards.js");
        const { MessageFlags } = await import("discord.js");
        expect(Number(configExportCard(current).flags) & Number(MessageFlags.Ephemeral)).toBe(
            Number(MessageFlags.Ephemeral)
        );
    });

    it("lists the changes and offers to apply them", async () => {
        const { configImportCard } = await import("../src/render/configCards.js");
        const report = readImport('{"weeklyTargetMinutes": 200}', current);
        const json = JSON.stringify(configImportCard(report, "tok123", NAMES));
        expect(json).toContain("weeklyTargetMinutes");
        expect(json).toContain("config:apply:tok123");
        expect(json).toContain("config:discard:tok123");
    });

    it("offers nothing to press when the paste was refused", async () => {
        // A card that lists the errors and still shows Apply invites the click
        // that the errors exist to prevent.
        const { configImportCard } = await import("../src/render/configCards.js");
        const report = readImport('{"nosuchkey": 1}', current);
        const json = JSON.stringify(configImportCard(report, "", NAMES));
        expect(json).not.toContain("config:apply");
        expect(json).toContain("nosuchkey");
    });

    it("says plainly when a change would move the bot to another server", async () => {
        const { configImportCard } = await import("../src/render/configCards.js");
        const report = readImport('{"staffGuildId": "999999999999999999"}', current);
        const json = JSON.stringify(configImportCard(report, "tok", NAMES));
        expect(json).toContain("moves the bot");
        expect(json).toContain("Commands are registered per server");
    });
});
