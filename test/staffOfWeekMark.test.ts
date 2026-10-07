import { describe, expect, it } from "vitest";
import { EMOJI, emojiForColour } from "../src/render/emoji.js";
import { COLOUR } from "../src/render/theme.js";

const TROPHY = "\u{1F3C6}";

describe("the trophy means Staff of the Week and nothing else", () => {
    it("is the feature's mark, by name and from its colour", () => {
        expect(EMOJI.staffOfWeek).toBe(TROPHY);
        expect(emojiForColour(COLOUR.staffOfWeek)).toBe(TROPHY);
    });

    it("no longer marks standings", () => {
        expect(emojiForColour(COLOUR.standings)).toBe("\u{1F4C8}");
    });

    it("appears in no source file but the emoji table", async () => {
        const { readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
            );
        const offenders = walk("src")
            .filter((file) => file.endsWith(".ts") && !file.endsWith(join("render", "emoji.ts")))
            .filter((file) => readFileSync(file, "utf8").includes(TROPHY));
        expect(offenders).toEqual([]);
    });

    it("is not the colour of anything else", () => {
        const others = Object.entries(COLOUR).filter(([role]) => role !== "staffOfWeek");
        expect(others.map(([, value]) => value)).not.toContain(COLOUR.staffOfWeek);
    });
});
