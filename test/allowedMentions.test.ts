import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, NO_MENTIONS } from "../src/discord/client.js";

/**
 * The bot pings nobody unless a send names exactly who. Two sends may: the
 * Executive ping role on a card's ping reply, and the available role on
 * /callmod. A per-send `allowedMentions` replaces the client's rather than
 * merging with it, so any other file setting one is a hole in the rule.
 */

const PERMITTED = new Set([
    join("src", "discord", "client.ts"),
    join("src", "services", "pings.ts"),
    join("src", "commands", "callmod.ts")
]);

const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
    );

describe("who the bot can ping", () => {
    it("pings nobody by default", () => {
        expect(NO_MENTIONS).toEqual({ parse: [], repliedUser: false });
        const client = createClient();
        expect(client.options.allowedMentions).toEqual(NO_MENTIONS);
        void client.destroy();
    });

    it("lets only Executive pings and /callmod choose for themselves", () => {
        const offenders = walk("src")
            .filter((file) => file.endsWith(".ts"))
            .filter((file) => !PERMITTED.has(file))
            .filter((file) => /allowedMentions\s*:/.test(readFileSync(file, "utf8")));
        expect(offenders).toEqual([]);
    });

    it("has each permitted send name a role and parse nothing", () => {
        for (const file of ["services/pings.ts", "commands/callmod.ts"]) {
            const source = readFileSync(join("src", file), "utf8");
            const block = source.slice(source.indexOf("allowedMentions"));
            expect(block, file).toMatch(/parse:\s*\[\]/);
            expect(block, file).toMatch(/roles:/);
            expect(block.slice(0, 200), file).not.toMatch(/users:/);
        }
    });
});
