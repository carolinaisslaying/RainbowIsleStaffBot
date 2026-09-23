import { describe, expect, it } from "vitest";
import { leaveTermsText } from "../src/render/leaveTerms.js";

/**
 * The approval and start DMs said "set aside" for both staff roles and exempt
 * weeks, so a member read that a week with too little leave kept their roles
 * from them. Roles follow the dates; exemption follows the days in a week.
 */
describe("what leave does, in words", () => {
    const text = leaveTermsText(3);

    it("gives roles and the requirement a word each, and never the old shared one", () => {
        expect(text).toContain("removed when the leave starts and given back");
        expect(text).toContain("is exempt");
        expect(text).not.toContain("set aside");
    });

    it("says roles come back whatever happens to the weeks", () => {
        const [roles, requirement] = text.split("\n\n");
        expect(roles).toContain("staff roles");
        expect(roles).not.toContain("exempt");
        expect(requirement).toContain("is separate");
        expect(requirement).toContain("still counts in full");
    });

    it("names the minimum it was given", () => {
        expect(leaveTermsText(4)).toContain("at least 4 days");
    });

    it("says what the run of weeks is instead of calling it a streak", () => {
        expect(text).not.toMatch(/streak/i);
        expect(text).toContain("weeks in a row meeting the target");
    });
});

describe("nobody is pointed at their data export unprompted", () => {
    // Both warning DMs used to end by telling the member the export existed.
    // The command is there for anybody who wants it; a card read at the
    // moment somebody is being warned is not the place to advertise it.
    it("is mentioned only by the command that provides it", async () => {
        const { readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
            );
        const offenders = walk("src")
            .filter((file) => file.endsWith(".ts"))
            .filter((file) => readFileSync(file, "utf8").includes('cmd("settings export"'));
        expect(offenders).toEqual([]);
    });
});
