import { describe, expect, it } from "vitest";
import { Constants } from "discord.js";
import {
    SOTW_CODE_VERSION,
    describeColour,
    downgradeNote,
    formatColourCode,
    highestIconRole,
    parseColourCode,
    roleColoursFor,
    twemojiCodepoints,
    twemojiUrl
} from "../src/domain/sotwColour.js";
import { HOLOGRAPHIC, hexOf } from "../src/render/sotwPalette.js";
import type { SotwColour } from "../src/db/types.js";

const solid: SotwColour = { style: "solid", primary: 0xff66aa };
const gradient: SotwColour = { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff };
const holo: SotwColour = { style: "holographic" };

describe("the colour code", () => {
    it("reads every form the picker writes", () => {
        expect(parseColourCode("SOTW1-S-FF66AA")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("SOTW1-G-FF66AA-3366FF")).toEqual({ ok: true, colour: gradient });
        expect(parseColourCode("SOTW1-H")).toEqual({ ok: true, colour: holo });
    });

    it("reads bare hex as a solid colour", () => {
        expect(parseColourCode("#FF66AA")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("ff66aa")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("#f6a")).toEqual({ ok: true, colour: solid });
    });

    it("tolerates how people paste", () => {
        expect(parseColourCode("  sotw1-g-ff66aa-3366ff\n")).toEqual({ ok: true, colour: gradient });
        expect(parseColourCode("\tSoTw1-h ")).toEqual({ ok: true, colour: holo });
    });

    it("refuses what is not a colour, in words", () => {
        for (const raw of ["", "pink", "#12345", "SOTW1-S-GGGGGG", "SOTW1-G-FF66AA", "SOTW1-X-FF66AA"]) {
            const parsed = parseColourCode(raw);
            expect(parsed.ok, raw).toBe(false);
            if (!parsed.ok) expect(parsed.error).toMatch(/colour/i);
        }
    });

    it("explains a code from a newer picker", () => {
        const parsed = parseColourCode("SOTW2-S-FF66AA");
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toMatch(/newer/i);
    });

    it("writes what it reads", () => {
        for (const colour of [solid, gradient, holo]) {
            const code = formatColourCode(colour);
            expect(code.startsWith(`${SOTW_CODE_VERSION}-`)).toBe(true);
            expect(parseColourCode(code)).toEqual({ ok: true, colour });
        }
        expect(formatColourCode(solid)).toBe("SOTW1-S-FF66AA");
    });
});

describe("what goes on the role", () => {
    it("clears the role when there is no preference", () => {
        for (const pref of [null, undefined]) {
            expect(roleColoursFor(pref, true)).toEqual({
                colours: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
                downgraded: false
            });
        }
    });

    it("puts a solid colour on as it is", () => {
        expect(roleColoursFor(solid, false).colours).toEqual({
            primaryColor: 0xff66aa,
            secondaryColor: null,
            tertiaryColor: null
        });
    });

    it("keeps black visible, because Discord reads zero as no colour", () => {
        expect(roleColoursFor({ style: "solid", primary: 0 }, true).colours.primaryColor).toBe(1);
    });

    it("draws gradient and holographic in full where the server supports them", () => {
        expect(roleColoursFor(gradient, true)).toEqual({
            colours: { primaryColor: 0xff66aa, secondaryColor: 0x3366ff, tertiaryColor: null },
            downgraded: false
        });
        expect(roleColoursFor(holo, true).colours).toEqual({
            primaryColor: HOLOGRAPHIC.primary,
            secondaryColor: HOLOGRAPHIC.secondary,
            tertiaryColor: HOLOGRAPHIC.tertiary
        });
    });

    it("falls back to one colour where it does not, and says so", () => {
        const flat = roleColoursFor(gradient, false);
        expect(flat).toEqual({
            colours: { primaryColor: 0xff66aa, secondaryColor: null, tertiaryColor: null },
            downgraded: true
        });
        expect(roleColoursFor(holo, false).colours.primaryColor).toBe(HOLOGRAPHIC.primary);
        expect(downgradeNote(gradient)).toMatch(/gradient/i);
        expect(downgradeNote(holo)).toMatch(/holographic/i);
        expect(downgradeNote(solid)).toBeNull();
    });

    it("never rewrites the preference it was given", () => {
        const pref: SotwColour = { style: "gradient", primary: 1, secondary: 2 };
        const before = JSON.stringify(pref);
        roleColoursFor(pref, false);
        expect(JSON.stringify(pref)).toBe(before);
    });

    it("uses Discord's own holographic stops", () => {
        expect(HOLOGRAPHIC.primary).toBe(Constants.HolographicStyle.Primary);
        expect(HOLOGRAPHIC.secondary).toBe(Constants.HolographicStyle.Secondary);
        expect(HOLOGRAPHIC.tertiary).toBe(Constants.HolographicStyle.Tertiary);
    });

    it("describes each choice in words", () => {
        expect(describeColour(null)).toBe("No colour");
        expect(describeColour(solid)).toBe("Solid #FF66AA");
        expect(describeColour(gradient)).toBe("Gradient #FF66AA to #3366FF");
        expect(describeColour(holo)).toBe("Holographic");
        expect(hexOf(0xa)).toBe("#00000A");
    });
});

describe("the badge beside a name", () => {
    it("is the icon of the highest role that has one", () => {
        const roles = [
            { id: "1", position: 9, icon: null, unicodeEmoji: null },
            { id: "2", position: 5, icon: "abc", unicodeEmoji: null },
            { id: "3", position: 7, icon: null, unicodeEmoji: "🌈" },
            { id: "4", position: 1, icon: "def", unicodeEmoji: null }
        ];
        expect(highestIconRole(roles)?.id).toBe("3");
        expect(highestIconRole([{ id: "1", position: 1, icon: null, unicodeEmoji: null }])).toBeNull();
    });

    it("names Twemoji's file the way Twemoji does", () => {
        expect(twemojiCodepoints("🌈")).toBe("1f308");
        // A lone variation selector is dropped.
        expect(twemojiCodepoints("❤️")).toBe("2764");
        // Inside a ZWJ sequence it is kept.
        expect(twemojiCodepoints("🏳️‍🌈")).toBe("1f3f3-fe0f-200d-1f308");
    });

    it("always asks for the latest Twemoji, never a pinned version", () => {
        const url = twemojiUrl("🌈");
        expect(url).toBe("https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/1f308.png");
        expect(url).not.toMatch(/@\d/);
    });
});
