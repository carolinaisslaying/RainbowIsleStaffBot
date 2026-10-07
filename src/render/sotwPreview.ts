import { Resvg } from "@resvg/resvg-js";
import type { SotwColour } from "../db/types.js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK } from "./theme.js";
import { HOLOGRAPHIC, hexOf } from "./sotwPalette.js";
import { LruCache } from "../util/cache.js";

/**
 * A mock Discord message in the member's chosen colour, once on each of
 * Discord's four themes (Ash, Dark, Onyx and Light), the way the picker page
 * shows it, so they see what everybody else will.
 *
 * The name is the public-guild nickname, not `staffDisplayName`'s staff-server
 * one: the colour only exists in the community server, so that is the name it
 * colours. A still image shows the colours and not Discord's shimmer. On
 * Light, a gradient or holographic name is darkened, as Discord darkens it.
 *
 * Pure: the avatar and badge arrive as data URIs fetched by the service, and
 * the time beside the name is formatted by the caller.
 */

export const PREVIEW_FILE = "sotw-preview.png";

export const PREVIEW_MESSAGE = "Staff of the Week!";

export interface SotwPreviewInput {
    name: string;
    colour: SotwColour | null;
    avatar: string | null;
    badge: string | null;
    /** The time shown beside the name, already formatted. Omitted when null. */
    time?: string | null;
    /**
     * The name in runs of text and emoji images (data URIs), because the
     * preview's fonts have no emoji. Absent means the name is plain text.
     */
    nameParts?: NamePart[] | null;
}

export type NamePart = { text: string } | { image: string };

const EMOJI_SIZE = 20;

const WIDTH = 520;
const PAD = 12;
const ROW = 76;
const HEIGHT = PAD * 2 + ROW * 4;
const AVATAR = 44;
const NAME_SIZE = 19;
const BODY_SIZE = 18;
const STAMP_SIZE = 13;
const TAG_SIZE = 13;
const LIGHT_DARKEN = 0.78;

const THEMES = [
    { id: "ash", label: "Ash", ground: "#2C2D32", body: "#DBDEE1", plainName: "#F2F3F5", muted: "#949BA4", light: false },
    { id: "dark", label: "Dark", ground: "#1A1A1E", body: "#DBDEE1", plainName: "#F2F3F5", muted: "#949BA4", light: false },
    { id: "onyx", label: "Onyx", ground: "#000000", body: "#D4D5D9", plainName: "#F2F3F5", muted: "#8C8D94", light: false },
    { id: "light", label: "Light", ground: "#FBFBFB", body: "#313338", plainName: "#060607", muted: "#5C5E66", light: true }
] as const;

type Theme = (typeof THEMES)[number];

/** A semibold 19px Inter glyph averages about 11px; close enough to seat what follows the name. */
const approxTextWidth = (text: string) => [...text].length * 10.9;

/** Each channel scaled towards black, as Discord darkens a gradient name on Light. */
function darken(value: number, factor: number): number {
    const channel = (shift: number) => Math.round(((value >> shift) & 255) * factor);
    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * Spans the whole name in user space, so a gradient runs once across text
 * broken up by emoji rather than restarting in every run.
 */
function nameFill(colour: SotwColour | null, theme: Theme, span: { x1: number; x2: number }): { defs: string; fill: string } {
    if (!colour) return { defs: "", fill: theme.plainName };
    if (colour.style === "solid") return { defs: "", fill: hexOf(colour.primary) };
    const id = `sotw-name-${theme.id}`;
    const raw =
        colour.style === "gradient"
            ? [colour.primary, colour.secondary]
            : [HOLOGRAPHIC.primary, HOLOGRAPHIC.secondary, HOLOGRAPHIC.tertiary];
    const stops = theme.light ? raw.map((stop) => darken(stop, LIGHT_DARKEN)) : raw;
    const stopMarkup = stops
        .map((stop, index) => {
            const offset = round((index / (stops.length - 1)) * 100);
            return `<stop offset="${offset}%" stop-color="${hexOf(stop)}"/>`;
        })
        .join("");
    return {
        defs:
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(span.x1)}" y1="0" ` +
            `x2="${round(span.x2)}" y2="0">${stopMarkup}</linearGradient>`,
        fill: `url(#${id})`
    };
}

function row(input: SotwPreviewInput, theme: Theme, top: number): { defs: string; body: string } {
    const clipId = `sotw-avatar-${theme.id}`;
    const cx = PAD + 16 + AVATAR / 2;
    const cy = top + ROW / 2;
    const nameX = PAD + 16 + AVATAR + 16;
    const nameY = top + 33;

    const parts: NamePart[] = input.nameParts && input.nameParts.length > 0 ? input.nameParts : [{ text: input.name }];
    const placed: { part: NamePart; x: number }[] = [];
    let cursor = nameX;
    for (const part of parts) {
        placed.push({ part, x: cursor });
        cursor += "text" in part ? approxTextWidth(part.text) : EMOJI_SIZE + 2;
    }
    const nameEnd = cursor;
    const fill = nameFill(input.colour, theme, { x1: nameX, x2: Math.max(nameEnd, nameX + 1) });
    const name = placed
        .map(({ part, x }) =>
            "text" in part
                ? `<text class="sotw-name" x="${round(x)}" y="${nameY}" fill="${fill.fill}" font-size="${NAME_SIZE}" ` +
                  `font-weight="600" font-family="${FONT_STACK}" xml:space="preserve">${escapeXml(part.text)}</text>`
                : `<image class="sotw-name-emoji" href="${part.image}" x="${round(x)}" y="${nameY - 16}" ` +
                  `width="${EMOJI_SIZE}" height="${EMOJI_SIZE}"/>`
        )
        .join("");
    const badgeX = round(nameEnd + 6);
    const stampX = input.badge ? badgeX + 26 : badgeX + 2;

    const avatar = input.avatar
        ? `<image class="sotw-avatar" href="${input.avatar}" x="${cx - AVATAR / 2}" y="${cy - AVATAR / 2}" ` +
          `width="${AVATAR}" height="${AVATAR}" clip-path="url(#${clipId})"/>`
        : `<circle class="sotw-avatar" cx="${cx}" cy="${cy}" r="${AVATAR / 2}" fill="#5865F2"/>`;

    const badge = input.badge
        ? `<image class="sotw-badge" href="${input.badge}" x="${badgeX}" y="${nameY - 17}" width="20" height="20"/>`
        : "";

    const stamp = input.time
        ? `<text class="sotw-time" x="${stampX}" y="${nameY - 1}" fill="${theme.muted}" font-size="${STAMP_SIZE}" ` +
          `font-family="${FONT_STACK}">${escapeXml(input.time)}</text>`
        : "";

    const tag =
        `<text class="sotw-theme" x="${WIDTH - PAD - 14}" y="${top + 22}" text-anchor="end" fill="${theme.muted}" ` +
        `font-size="${TAG_SIZE}" font-weight="600" font-family="${FONT_STACK}">${theme.label}</text>`;

    return {
        defs:
            fill.defs +
            `<clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${AVATAR / 2}"/></clipPath>`,
        body:
            `<rect class="sotw-row" x="${PAD}" y="${top}" width="${WIDTH - PAD * 2}" height="${ROW}" fill="${theme.ground}"/>` +
            avatar +
            name +
            badge +
            stamp +
            tag +
            `<text x="${nameX}" y="${nameY + 25}" fill="${theme.body}" font-size="${BODY_SIZE}" ` +
            `font-family="${FONT_STACK}">${PREVIEW_MESSAGE}</text>`
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
    return `${input.name}'s name in ${colour}, on Discord's Ash, Dark, Onyx and Light themes.`;
}

export function sotwPreviewSvg(input: SotwPreviewInput): string {
    const rows = THEMES.map((theme, index) => row(input, theme, PAD + index * ROW));
    const inner = WIDTH - PAD * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${rows.map((part) => part.defs).join("")}<clipPath id="sotw-frame"><rect x="${PAD}" y="${PAD}" width="${inner}" height="${ROW * 4}" rx="10"/></clipPath></defs>
    <g clip-path="url(#sotw-frame)">
    ${rows.map((part) => part.body).join("\n    ")}
    </g>
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
