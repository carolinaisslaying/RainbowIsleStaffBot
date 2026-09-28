import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { SOTW_CODE_VERSION, formatColourCode, parseColourCode } from "../src/domain/sotwColour.js";
import { HOLOGRAPHIC } from "../src/render/sotwPalette.js";
import { pickerFragment, type PickerFragmentInput } from "../src/domain/sotwFragment.js";
import type { SotwColour } from "../src/db/types.js";

const html = readFileSync("site/sotw-colour/index.html", "utf8");
const core = /<script id="sotw-core">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const context: Record<string, unknown> = { URLSearchParams };
runInNewContext(core, context);
const page = context.SotwCore as {
    SOTW_CODE_VERSION: string;
    HOLOGRAPHIC: Record<string, number>;
    formatCode(colour: SotwColour): string;
    parseCode(raw: string): SotwColour | null;
    readFragment(hash: string): Record<string, unknown> | null;
};

const colours: SotwColour[] = [
    { style: "solid", primary: 0xff66aa },
    { style: "solid", primary: 0 },
    { style: "gradient", primary: 0x000001, secondary: 0xffffff },
    { style: "holographic" }
];

describe("the picker page and the bot agree", () => {
    it("has its core script", () => {
        expect(core.length).toBeGreaterThan(0);
        expect(page).toBeDefined();
    });

    it("writes the same version and holographic stops", () => {
        expect(page.SOTW_CODE_VERSION).toBe(SOTW_CODE_VERSION);
        expect(page.HOLOGRAPHIC).toEqual({ ...HOLOGRAPHIC });
    });

    it("writes codes the bot reads, and reads codes the bot writes", () => {
        for (const colour of colours) {
            expect(page.formatCode(colour)).toBe(formatColourCode(colour));
            expect(parseColourCode(page.formatCode(colour))).toEqual({ ok: true, colour });
            expect(page.parseCode(formatColourCode(colour))).toEqual(colour);
        }
    });

    it("reads the fragment the bot builds", () => {
        const input: PickerFragmentInput = {
            nickname: "Ro<b>in 🌈",
            userId: "123456789012345678",
            guildId: "223456789012345678",
            avatarHash: "a_abc",
            guildAvatar: true,
            roleId: null,
            iconHash: null,
            emoji: "🌈",
            colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff },
            enhanced: false
        };
        expect(page.readFragment(`#${pickerFragment(input)}`)).toEqual(input);
    });

    it("loads nothing but Discord's CDN", () => {
        const sources = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((match) => match[1]);
        for (const source of sources) expect(source.startsWith("https://cdn.discordapp.com/")).toBe(true);
        expect(html).not.toMatch(/https:\/\/(?!cdn\.discordapp\.com)[a-z0-9.-]+\//i);
    });
});
