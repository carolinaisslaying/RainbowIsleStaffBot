import { describe, expect, it } from "vitest";
import { describePreview, sotwPreviewSvg } from "../src/render/sotwPreview.js";
import { HOLOGRAPHIC, hexOf } from "../src/render/sotwPalette.js";

const base = { name: "Robin", avatar: null, badge: null };
const count = (svg: string, needle: string) => svg.split(needle).length - 1;

describe("the name preview", () => {
    it("draws the message on a dark and a light theme", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "solid", primary: 0xff66aa } });
        expect(count(svg, 'class="sotw-name"')).toBe(2);
        expect(svg).toContain('fill="#FF66AA"');
    });

    it("draws a gradient with its two stops", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff } });
        expect(count(svg, "<stop ")).toBe(4); // two stops, once per theme
        expect(svg).toContain('stop-color="#3366FF"');
    });

    it("draws holographic with Discord's three stops", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "holographic" } });
        expect(count(svg, "<stop ")).toBe(6);
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
        expect(count(withBadge, 'class="sotw-badge"')).toBe(2);
    });

    it("draws a placeholder avatar when none could be fetched", () => {
        const svg = sotwPreviewSvg({ ...base, colour: null });
        expect(count(svg, 'class="sotw-avatar"')).toBe(2);
        expect(svg).not.toContain("<image ");
    });

    it("escapes a hostile nickname", () => {
        const svg = sotwPreviewSvg({ ...base, name: `<script>&"x"`, colour: null });
        expect(svg).not.toContain("<script>");
        expect(svg).toContain("&lt;script&gt;&amp;");
    });

    it("says what it shows in words", () => {
        expect(describePreview({ ...base, colour: { style: "holographic" } })).toBe(
            "Robin's name in Holographic, on Discord's dark and light themes."
        );
    });
});
