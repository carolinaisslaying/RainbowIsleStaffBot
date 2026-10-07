import { describe, expect, it } from "vitest";
import { describePreview, PREVIEW_MESSAGE, sotwPreviewSvg } from "../src/render/sotwPreview.js";
import { HOLOGRAPHIC, hexOf } from "../src/render/sotwPalette.js";
import { splitEmoji } from "../src/domain/sotwColour.js";

const base = { name: "Robin", avatar: null, badge: null };
const count = (svg: string, needle: string) => svg.split(needle).length - 1;

describe("the name preview", () => {
    it("draws the message on Discord's four themes", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "solid", primary: 0xff66aa } });
        expect(count(svg, 'class="sotw-name"')).toBe(4);
        expect(count(svg, 'class="sotw-row"')).toBe(4);
        for (const label of ["Ash", "Dark", "Onyx", "Light"]) expect(svg).toContain(`>${label}</text>`);
        expect(count(svg, `>${PREVIEW_MESSAGE}</text>`)).toBe(4);
        // A solid colour is never darkened, on Light or anywhere else.
        expect(count(svg, 'fill="#FF66AA"')).toBe(4);
    });

    it("draws a gradient with its two stops, darkened on Light", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff } });
        expect(count(svg, "<stop ")).toBe(8); // two stops, once per theme
        expect(count(svg, 'stop-color="#3366FF"')).toBe(3);
        expect(svg).toContain('stop-color="#2850C7"'); // 0x3366ff at 0.78
    });

    it("draws holographic with Discord's three stops", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "holographic" } });
        expect(count(svg, "<stop ")).toBe(12);
        for (const stop of Object.values(HOLOGRAPHIC)) expect(svg).toContain(`stop-color="${hexOf(stop)}"`);
    });

    it("leaves a name without a colour in the theme's own name colour", () => {
        const svg = sotwPreviewSvg({ ...base, colour: null });
        expect(svg).not.toContain("<stop ");
        expect(svg).toContain('fill="#F2F3F5"');
        expect(svg).toContain('fill="#060607"');
    });

    it("omits the badge when there is none, and draws it when there is", () => {
        expect(sotwPreviewSvg({ ...base, colour: null })).not.toContain("sotw-badge");
        const withBadge = sotwPreviewSvg({ ...base, colour: null, badge: "data:image/png;base64,AAAA" });
        expect(count(withBadge, 'class="sotw-badge"')).toBe(4);
    });

    it("shows the time beside the name only when it is given", () => {
        expect(sotwPreviewSvg({ ...base, colour: null })).not.toContain("sotw-time");
        const svg = sotwPreviewSvg({ ...base, colour: null, time: "10:35 PM" });
        expect(count(svg, ">10:35 PM</text>")).toBe(4);
    });

    it("draws a placeholder avatar when none could be fetched", () => {
        const svg = sotwPreviewSvg({ ...base, colour: null });
        expect(count(svg, 'class="sotw-avatar"')).toBe(4);
        expect(svg).not.toContain("<image ");
    });

    it("draws an emoji in the name as an image, never as text the font lacks", () => {
        const svg = sotwPreviewSvg({
            ...base,
            name: "M 🐾",
            nameParts: [{ text: "M " }, { image: "data:image/png;base64,PAW" }],
            colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff }
        });
        expect(count(svg, 'class="sotw-name-emoji"')).toBe(4);
        expect(svg).not.toMatch(/class="sotw-name"[^>]*>[^<]*🐾/u);
        // One gradient across the whole name, not one per run of text.
        expect(svg).toContain('gradientUnits="userSpaceOnUse"');
    });

    it("escapes a hostile nickname", () => {
        const svg = sotwPreviewSvg({ ...base, name: `<script>&"x"`, colour: null });
        expect(svg).not.toContain("<script>");
        expect(svg).toContain("&lt;script&gt;&amp;");
    });

    it("says what it shows in words", () => {
        expect(describePreview({ ...base, colour: { style: "holographic" } })).toBe(
            "Robin's name in Holographic, on Discord's Ash, Dark, Onyx and Light themes."
        );
    });
});

describe("splitting a name around its emoji", () => {
    it("keeps text together and each emoji whole", () => {
        expect(splitEmoji("M 🐾")).toEqual([
            { kind: "text", text: "M " },
            { kind: "emoji", emoji: "🐾" }
        ]);
        expect(splitEmoji("Robin")).toEqual([{ kind: "text", text: "Robin" }]);
    });

    it("never breaks a flag, a skin tone or a joined emoji apart", () => {
        expect(splitEmoji("🇳🇿👋🏽👩‍💻x")).toEqual([
            { kind: "emoji", emoji: "🇳🇿" },
            { kind: "emoji", emoji: "👋🏽" },
            { kind: "emoji", emoji: "👩‍💻" },
            { kind: "text", text: "x" }
        ]);
    });
});
