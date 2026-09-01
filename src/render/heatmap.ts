import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, GLASS } from "./theme.js";
import {
    GRID_DAYS,
    GRID_HOURS,
    weekdayLabels,
    type CoverageGrid
} from "../services/coverageService.js";

/**
 * A 7 by 24 grid rendered as SVG and rasterised through the same pipeline as
 * the rings, and cut from the same glass.
 *
 * Cell colour plots demand divided by coverage, never either alone. A static
 * image has no tooltip, so the legend plus the companion text block listing the
 * worst buckets is where the raw numbers live.
 *
 * Every tile is a lit pane: the ramp colour behind frosted glass, with a sheen
 * falling across its top edge. A quiet hour is an empty pane rather than a dark
 * square, which is the same distinction the rings draw between a channel with
 * nothing in it and a filament that is off.
 */

const CELL = 34;
const LEFT_GUTTER = 52;
const TOP_GUTTER = 56;
const LEGEND_HEIGHT = 60;
const WIDTH = LEFT_GUTTER + GRID_HOURS * CELL + 16;
const HEIGHT = TOP_GUTTER + GRID_DAYS * CELL + LEGEND_HEIGHT;

/** Perceptually ordered ramp, dark to hot. Never relied on alone. */
const RAMP = ["#1c1c1e", "#173b52", "#1d6b6b", "#8a8f26", "#c9761b", "#d92b2b"];

function colourFor(ratio: number, maxRatio: number): string {
    if (ratio <= 0) return RAMP[0];
    if (maxRatio <= 0) return RAMP[0];
    const normalised = Math.min(1, ratio / maxRatio);
    const index = Math.min(RAMP.length - 1, 1 + Math.floor(normalised * (RAMP.length - 2)));
    return RAMP[index];
}

/** One glass pane: the ramp colour, a hairline rim, and a sheen off the top. */
function tile(x: number, y: number, size: number, fill: string, radius = 8): string {
    return (
        `<rect x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" ` +
        `rx="${radius}" fill="${fill}" />` +
        `<rect x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" ` +
        `rx="${radius}" fill="url(#tileSheen)" />` +
        `<rect x="${round(x + 0.5)}" y="${round(y + 0.5)}" width="${size - 1}" ` +
        `height="${size - 1}" rx="${radius - 0.5}" fill="none" ` +
        `stroke="${GLASS.paneRim}" stroke-width="0.8" />`
    );
}

export function heatmapSvg(grid: CoverageGrid): string {
    const days = weekdayLabels(grid.weekStartDay);
    const parts: string[] = [
        `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#substrate)" />`
    ];

    // Caption on its own line, above the hour axis, so the two cannot collide.
    parts.push(
        `<text x="${LEFT_GUTTER}" y="22" fill="${GLASS.text}" font-size="13" ` +
            `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.2">` +
            `${escapeXml(grid.timeZone)}, ${grid.weeks} week mean</text>`
    );

    for (let hour = 0; hour < GRID_HOURS; hour += 1) {
        if (hour % 2 !== 0) continue;
        const x = LEFT_GUTTER + hour * CELL + CELL / 2;
        parts.push(
            `<text x="${round(x)}" y="46" fill="${GLASS.textMuted}" font-size="12" ` +
                `font-family="${FONT_STACK}" text-anchor="middle">${String(hour).padStart(2, "0")}</text>`
        );
    }

    for (let weekday = 0; weekday < GRID_DAYS; weekday += 1) {
        const y = TOP_GUTTER + weekday * CELL;
        parts.push(
            `<text x="${LEFT_GUTTER - 10}" y="${round(y + CELL / 2 + 4)}" ` +
                `fill="${GLASS.textMuted}" font-size="12" font-family="${FONT_STACK}" ` +
                `text-anchor="end">${days[weekday]}</text>`
        );

        for (let hour = 0; hour < GRID_HOURS; hour += 1) {
            const x = LEFT_GUTTER + hour * CELL;
            const ratio = grid.ratio[weekday][hour];
            parts.push(tile(x, y, CELL - 2, colourFor(ratio, grid.maxRatio)));

            // The number is in the cell as well as in the colour, because
            // colour never carries meaning alone.
            if (ratio > 0) {
                const label = ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
                parts.push(
                    `<text x="${round(x + (CELL - 2) / 2)}" y="${round(y + CELL / 2 + 3)}" ` +
                        `fill="${GLASS.text}" font-size="9" font-family="${FONT_STACK}" ` +
                        `text-anchor="middle">${escapeXml(label)}</text>`
                );
            }
        }
    }

    const legendY = TOP_GUTTER + GRID_DAYS * CELL + 18;
    parts.push(
        `<text x="${LEFT_GUTTER}" y="${round(legendY)}" fill="${GLASS.textMuted}" ` +
            `font-size="11" font-family="${FONT_STACK}">Messages per available moderator, ` +
            `per hour. Higher is a worse gap.</text>`
    );

    RAMP.forEach((colour, index) => {
        const x = LEFT_GUTTER + index * 40;
        const y = legendY + 8;
        parts.push(
            `<rect x="${x}" y="${round(y)}" width="34" height="12" rx="6" fill="${colour}" />`,
            `<rect x="${x}" y="${round(y)}" width="34" height="12" rx="6" fill="url(#tileSheen)" />`,
            `<rect x="${x + 0.5}" y="${round(y + 0.5)}" width="33" height="11" rx="5.5" ` +
                `fill="none" stroke="${GLASS.paneRim}" stroke-width="0.8" />`
        );
    });
    // Anchored to each end of the ramp. Repeated spaces collapse in SVG text,
    // so the two labels must be positioned rather than padded apart.
    const rampWidth = RAMP.length * 40 - 6;
    parts.push(
        `<text x="${LEFT_GUTTER}" y="${round(legendY + 34)}" fill="${GLASS.textMuted}" ` +
            `font-size="10" font-family="${FONT_STACK}">low load</text>`,
        `<text x="${LEFT_GUTTER + rampWidth}" y="${round(legendY + 34)}" ` +
            `fill="${GLASS.textMuted}" font-size="10" font-family="${FONT_STACK}" ` +
            `text-anchor="end">high load</text>`
    );

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
    <linearGradient id="substrate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${GLASS.substrateTop}" />
        <stop offset="1" stop-color="${GLASS.substrateBottom}" />
    </linearGradient>
    <linearGradient id="tileSheen" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.16" />
        <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.02" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    </defs>
    ${parts.join("\n    ")}
</svg>`;
}

export function renderHeatmap(grid: CoverageGrid): Buffer {
    const resvg = new Resvg(heatmapSvg(grid), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        background: GLASS.substrateBottom,
        font: FONT_OPTIONS
    });
    return Buffer.from(resvg.render().asPng());
}
