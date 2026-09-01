import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";
import {
    GRID_DAYS,
    GRID_HOURS,
    weekdayLabels,
    type CoverageGrid
} from "../services/coverageService.js";

/**
 * A 7 by 24 grid rendered as SVG and rasterised through the same pipeline as
 * the rings.
 *
 * Cell colour plots demand divided by coverage, never either alone. A static
 * image has no tooltip, so the legend plus the companion text block listing the
 * worst buckets is where the raw numbers live.
 *
 * Two things a heatmap has to get right and this one previously did not. An
 * hour with no demand is drawn as almost nothing rather than as an outlined
 * box: a hundred and sixty-eight empty boxes is a loading skeleton, not a
 * chart. And a window with no demand at all is not drawn as a grid: an empty
 * grid says the renderer failed, so it says in words that there is nothing to
 * plot.
 */

const CELL = 30;
const PAD = 18;
const LEFT_GUTTER = 46;
const TOP_GUTTER = 58;
const LEGEND_HEIGHT = 54;
const WIDTH = LEFT_GUTTER + GRID_HOURS * CELL + PAD;
const HEIGHT = TOP_GUTTER + GRID_DAYS * CELL + LEGEND_HEIGHT;

/**
 * Perceptually ordered ramp, cool to hot. Never relied on alone.
 *
 * Index 0 is the empty reading and is deliberately not a colour: an hour that
 * recorded nothing should recede into the panel rather than sit on it.
 */
const RAMP = ["#0a84ff", "#2bb1a8", "#c3c33a", "#ff9f0a", "#ff453a"];
const EMPTY = "rgba(255,255,255,0.045)";

function colourFor(ratio: number, maxRatio: number): string {
    if (ratio <= 0 || maxRatio <= 0) return EMPTY;
    const normalised = Math.min(1, ratio / maxRatio);
    return RAMP[Math.min(RAMP.length - 1, Math.floor(normalised * RAMP.length))];
}

function panel(body: string, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SURFACE.panelTop}" />
        <stop offset="1" stop-color="${SURFACE.panelBottom}" />
    </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${height}" rx="18" fill="url(#panel)" />
    <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="17.5" fill="none" stroke="${SURFACE.rimLight}" stroke-width="1" />
    ${body}
</svg>`;
}

/** Nothing was recorded. Say so, rather than drawing an empty grid. */
function emptyGrid(grid: CoverageGrid): string {
    const height = 132;
    return panel(
        [
            `<text x="${WIDTH / 2}" y="${height / 2 - 8}" fill="${SURFACE.text}" ` +
                `font-size="16" font-family="${FONT_STACK}" font-weight="bold" ` +
                `letter-spacing="-0.2" text-anchor="middle">No demand recorded</text>`,
            `<text x="${WIDTH / 2}" y="${height / 2 + 16}" fill="${SURFACE.textMuted}" ` +
                `font-size="13" font-family="${FONT_STACK}" text-anchor="middle">` +
                `${escapeXml(grid.timeZone)}, ${grid.weeks} week mean. Nothing to plot yet.</text>`
        ].join("\n    "),
        height
    );
}

export function heatmapSvg(grid: CoverageGrid): string {
    if (grid.maxRatio <= 0) return emptyGrid(grid);

    const days = weekdayLabels(grid.weekStartDay);
    const parts: string[] = [
        `<text x="${LEFT_GUTTER}" y="26" fill="${SURFACE.text}" font-size="14" ` +
            `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.2">` +
            `${escapeXml(grid.timeZone)}, ${grid.weeks} week mean</text>`
    ];

    for (let hour = 0; hour < GRID_HOURS; hour += 1) {
        if (hour % 3 !== 0) continue;
        const x = LEFT_GUTTER + hour * CELL + CELL / 2;
        parts.push(
            `<text x="${round(x)}" y="48" fill="${SURFACE.textMuted}" font-size="11" ` +
                `font-family="${FONT_STACK}" text-anchor="middle">` +
                `${String(hour).padStart(2, "0")}</text>`
        );
    }

    for (let weekday = 0; weekday < GRID_DAYS; weekday += 1) {
        const y = TOP_GUTTER + weekday * CELL;
        parts.push(
            `<text x="${LEFT_GUTTER - 12}" y="${round(y + CELL / 2 + 4)}" ` +
                `fill="${SURFACE.textMuted}" font-size="11.5" font-family="${FONT_STACK}" ` +
                `text-anchor="end">${days[weekday]}</text>`
        );

        for (let hour = 0; hour < GRID_HOURS; hour += 1) {
            const x = LEFT_GUTTER + hour * CELL;
            const ratio = grid.ratio[weekday][hour];
            parts.push(
                `<rect x="${round(x + 1.5)}" y="${round(y + 1.5)}" width="${CELL - 3}" ` +
                    `height="${CELL - 3}" rx="7" fill="${colourFor(ratio, grid.maxRatio)}" />`
            );

            // The number is in the cell as well as in the colour, because
            // colour never carries meaning alone. An empty hour has no number:
            // a grid of zeroes is noise, and its emptiness is already the point.
            if (ratio > 0) {
                const label = ratio >= 10 ? String(Math.round(ratio)) : ratio.toFixed(1);
                parts.push(
                    `<text x="${round(x + CELL / 2)}" y="${round(y + CELL / 2 + 3.5)}" ` +
                        `fill="rgba(0,0,0,0.72)" font-size="9.5" font-family="${FONT_STACK}" ` +
                        `font-weight="bold" text-anchor="middle">${escapeXml(label)}</text>`
                );
            }
        }
    }

    const legendY = TOP_GUTTER + GRID_DAYS * CELL + 20;
    parts.push(
        `<text x="${LEFT_GUTTER}" y="${round(legendY)}" fill="${SURFACE.textMuted}" ` +
            `font-size="11" font-family="${FONT_STACK}">Messages per available moderator, ` +
            `per hour. Higher is a worse gap.</text>`
    );

    // One continuous bar rather than separate chips: the scale is continuous,
    // and five detached lozenges implied five discrete bands.
    const barX = LEFT_GUTTER;
    const barY = round(legendY + 10);
    const barWidth = 168;
    const segments = RAMP.map((colour, index) => {
        const segment = barWidth / RAMP.length;
        return (
            `<rect x="${round(barX + index * segment)}" y="${barY}" ` +
            `width="${round(segment) + 0.5}" height="9" fill="${colour}" />`
        );
    }).join("");
    // Clipped, or the square ends of the first and last segments sit outside
    // the bar's own rounded corners.
    parts.push(
        `<clipPath id="rampClip"><rect x="${barX}" y="${barY}" width="${barWidth}" ` +
            `height="9" rx="4.5" /></clipPath>`,
        `<g clip-path="url(#rampClip)">${segments}</g>`,
        `<rect x="${barX}" y="${barY}" width="${barWidth}" height="9" rx="4.5" fill="none" ` +
            `stroke="${SURFACE.rimLight}" stroke-width="1" />`,
        `<text x="${barX + barWidth + 10}" y="${round(barY + 8)}" fill="${SURFACE.textMuted}" ` +
            `font-size="10.5" font-family="${FONT_STACK}">quiet to worst gap</text>`
    );

    return panel(parts.join("\n    "), HEIGHT);
}

export function renderHeatmap(grid: CoverageGrid): Buffer {
    const resvg = new Resvg(heatmapSvg(grid), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    return Buffer.from(resvg.render().asPng());
}
