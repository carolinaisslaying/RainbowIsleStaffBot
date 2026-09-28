import { Resvg } from "@resvg/resvg-js";
import type { SotwColour } from "../db/types.js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK } from "./theme.js";
import { HOLOGRAPHIC, hexOf } from "./sotwPalette.js";
import { LruCache } from "../util/cache.js";

/**
 * A mock Discord message in the member's chosen colour, on the dark theme and
 * the light one, so they see what everybody else will.
 *
 * The name is the public-guild nickname, not `staffDisplayName`'s staff-server
 * one: the colour only exists in the community server, so that is the name it
 * colours. A still image shows the colours and not Discord's shimmer.
 *
 * Pure: the avatar and badge arrive as data URIs fetched by the service.
 */

export const PREVIEW_FILE = "sotw-preview.png";

export interface SotwPreviewInput {
    name: string;
    colour: SotwColour | null;
    avatar: string | null;
    badge: string | null;
}

const WIDTH = 520;
const PAD = 16;
const ROW = 76;
const GAP = 8;
const HEIGHT = PAD * 2 + ROW * 2 + GAP;
const AVATAR = 40;
const NAME_SIZE = 16;

const THEMES = [
    { id: "dark", ground: "#313338", body: "#DBDEE1", plainName: "#F2F3F5", muted: "#949BA4", placeholder: "#5865F2" },
    { id: "light", ground: "#FFFFFF", body: "#313338", plainName: "#060607", muted: "#5C5E66", placeholder: "#5865F2" }
] as const;

/** A bold 16px Inter glyph averages about 9px; close enough to seat the badge. */
const approxNameWidth = (name: string) => [...name].length * 9.2;

function nameFill(colour: SotwColour | null, theme: (typeof THEMES)[number]): { defs: string; fill: string } {
    if (!colour) return { defs: "", fill: theme.plainName };
    if (colour.style === "solid") return { defs: "", fill: hexOf(colour.primary) };
    const id = `sotw-name-${theme.id}`;
    const stops =
        colour.style === "gradient"
            ? [colour.primary, colour.secondary]
            : [HOLOGRAPHIC.primary, HOLOGRAPHIC.secondary, HOLOGRAPHIC.tertiary];
    const stopMarkup = stops
        .map((stop, index) => {
            const offset = round((index / (stops.length - 1)) * 100);
            return `<stop offset="${offset}%" stop-color="${hexOf(stop)}"/>`;
        })
        .join("");
    return {
        defs: `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stopMarkup}</linearGradient>`,
        fill: `url(#${id})`
    };
}

function row(input: SotwPreviewInput, theme: (typeof THEMES)[number], top: number): { defs: string; body: string } {
    const fill = nameFill(input.colour, theme);
    const clipId = `sotw-avatar-${theme.id}`;
    const cx = PAD + 16 + AVATAR / 2;
    const cy = top + 18 + AVATAR / 2;
    const nameX = PAD + 16 + AVATAR + 16;
    const nameY = top + 34;
    const badgeX = round(nameX + approxNameWidth(input.name) + 6);

    const avatar = input.avatar
        ? `<image class="sotw-avatar" href="${input.avatar}" x="${cx - AVATAR / 2}" y="${cy - AVATAR / 2}" ` +
          `width="${AVATAR}" height="${AVATAR}" clip-path="url(#${clipId})"/>`
        : `<circle class="sotw-avatar" cx="${cx}" cy="${cy}" r="${AVATAR / 2}" fill="${theme.placeholder}"/>`;

    const badge = input.badge
        ? `<image class="sotw-badge" href="${input.badge}" x="${badgeX}" y="${nameY - 15}" width="18" height="18"/>`
        : "";

    return {
        defs:
            fill.defs +
            `<clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${AVATAR / 2}"/></clipPath>`,
        body:
            `<rect x="${PAD}" y="${top}" width="${WIDTH - PAD * 2}" height="${ROW}" rx="8" fill="${theme.ground}"/>` +
            avatar +
            `<text class="sotw-name" x="${nameX}" y="${nameY}" fill="${fill.fill}" font-size="${NAME_SIZE}" ` +
            `font-weight="bold" font-family="${FONT_STACK}">${escapeXml(input.name)}</text>` +
            badge +
            `<text x="${nameX}" y="${nameY + 22}" fill="${theme.body}" font-size="14" ` +
            `font-family="${FONT_STACK}">Staff of the Week, reporting for duty.</text>`
    };
}

export function describePreview(input: SotwPreviewInput): string {
    const colour =
        !input.colour
            ? "no colour"
            : input.colour.style === "solid"
              ? hexOf(input.colour.primary)
              : input.colour.style === "gradient"
                ? `a gradient from ${hexOf(input.colour.primary)} to ${hexOf(input.colour.secondary)}`
                : "Holographic";
    return `${input.name}'s name in ${colour}, on Discord's dark and light themes.`;
}

export function sotwPreviewSvg(input: SotwPreviewInput): string {
    const rows = THEMES.map((theme, index) => row(input, theme, PAD + index * (ROW + GAP)));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${rows.map((part) => part.defs).join("")}</defs>
    ${rows.map((part) => part.body).join("\n    ")}
    <title>${escapeXml(describePreview(input))}</title>
</svg>`;
}

const cache = new LruCache<string, Buffer>(128);

/** Rasterised at 2x, like the rings. Cached only when the caller supplies a key. */
export function renderSotwPreview(input: SotwPreviewInput, cacheKey?: string): Buffer {
    if (cacheKey) {
        const hit = cache.get(cacheKey);
        if (hit) return hit;
    }
    const resvg = new Resvg(sotwPreviewSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    const png = Buffer.from(resvg.render().asPng());
    if (cacheKey) cache.set(cacheKey, png);
    return png;
}
