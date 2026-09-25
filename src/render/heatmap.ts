import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";
import { panelDefs, panelGround, panelRim } from "./panel.js";
import {
    GRID_DAYS,
    GRID_HOURS,
    weekdayLabels,
    type CoverageGrid,
    type GapCell
} from "../services/coverageService.js";

/**
 * A 7 by 24 grid rendered as SVG and rasterised through the same pipeline as
 * the rings.
 *
 * Three readings of the same grid. `coverage` plots moderators short of what
 * each hour's messages need; `activity` plots messages per hour; `member` plots one
 * member's activity minutes per hour. A static image has no
 * tooltip, so the legend plus the companion text block listing the top cells is
 * where the raw numbers live.
 *
 * Two things a heatmap has to get right and this one previously did not. An
 * hour with no demand is drawn as almost nothing rather than as an outlined
 * box: a hundred and sixty-eight empty boxes is a loading skeleton, not a
 * chart. And a window with no demand at all is not drawn as a grid: an empty
 * grid says the renderer failed, so it says in words that there is nothing to
 * plot.
 *
 * A third state sits between the two. An hour the bot has not heard yet, on a
 * deployment a few hours old or across an outage, is drawn dashed: it is not
 * quiet, it is unknown, and the grid is read very differently depending on which.
 */

export type HeatmapKind = "coverage" | "activity" | "member";

const CELL = 30;
/** The same margin on all four sides, as on the ring card. */
const PAD = 22;
/** The weekday column, right aligned into the margin. */
const DAY_COLUMN = 26;
const LEFT_GUTTER = PAD + DAY_COLUMN;
const TOP_GUTTER = 58;
const LEGEND_HEIGHT = 60;
const WIDTH = LEFT_GUTTER + GRID_HOURS * CELL + PAD;
const HEIGHT = TOP_GUTTER + GRID_DAYS * CELL + LEGEND_HEIGHT;

/**
 * Leaf to burgundy, for the coverage gap: the one heatmap whose reading is a
 * problem, so a light load reading green and a heavy one burgundy is the
 * point. Never relied on alone: every cell prints its figure.
 *
 * Built in OKLCH: lightness falls in even steps (0.83 to 0.46) while the hue
 * turns from leaf through gold and amber to brick and burgundy, so the order
 * survives greyscale and every colour-vision deficiency the validator checks.
 * The burgundy is as dark as it can be and still clear the panel at 2.25:1.
 * It replaced a blue-to-red status ramp whose top was the red this bot uses
 * for something broken.
 *
 * An hour nobody spoke in is deliberately not a colour: it recedes into the
 * panel rather than sitting on it.
 */
const GAP_RAMP = ["#86df9a", "#d0a83e", "#d27c02", "#c14b24", "#9a273a"];
const EMPTY = "rgba(255,255,255,0.045)";
const UNSEEN_STROKE = "rgba(255,255,255,0.16)";

/** Dark ink for the figure inside a light cell. */
const CELL_INK = "rgba(0,0,0,0.82)";

/**
 * Whichever ink out-contrasts each step. The figures are 9.5px and bold, where
 * contrast is worth more than anything else: dark on the three light steps
 * (9.6, 7.4 and 5.5:1), white on brick and burgundy (4.9 and 7.7:1, where dark
 * managed 3.8 and 2.5).
 */
const GAP_INK = [CELL_INK, CELL_INK, CELL_INK, "#ffffff", "#ffffff"];

/**
 * For readings of how much rather than how bad: a member's minutes and the
 * server's messages. One hue, dim to bright, never a status ramp like the
 * coverage gap's. On one of those the busiest hour was red: the colour this
 * bot uses for something having gone wrong, on a card about one person, and on
 * a server chart where busy is not bad. The review charts' teal (`render/trend.ts`) stepped in OKLCH
 * lightness at a fixed hue, so more is brighter and nothing says good or bad.
 *
 * Validated as an ordinal ramp against the panel ground: lightness rises
 * monotonically, and the dimmest step clears the panel at 2.2:1.
 */
const MAGNITUDE_RAMP = ["#035160", "#0b758a", "#169cb7", "#4ec2de", "#8fe7fe"];

/**
 * A one-hue ramp spans dark to light, so a single ink cannot read on all of it
 * the way it does on the ramp above. Light ink on the two dim steps (8.9:1 and
 * 5.4:1), dark on the three bright ones (6.5:1 and up).
 */
const MAGNITUDE_INK = ["#ffffff", "#ffffff", CELL_INK, CELL_INK, CELL_INK];

interface Palette {
    ramp: readonly string[];
    /** Ink for the figure printed on each band, index for index. */
    ink: readonly string[];
}

const HEAT: Palette = { ramp: GAP_RAMP, ink: GAP_INK };
const MAGNITUDE: Palette = { ramp: MAGNITUDE_RAMP, ink: MAGNITUDE_INK };

const PALETTE: Record<HeatmapKind, Palette> = {
    coverage: HEAT,
    activity: MAGNITUDE,
    member: MAGNITUDE
};

/**
 * The value the top of the ramp stands for: the 95th percentile of the readings,
 * not the largest. On a thin grid one event hour would otherwise take the top
 * band alone and wash every other cell down into the bottom two. Anything above
 * it is simply hot.
 */
export function scaleTop(values: readonly number[]): number {
    const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (positive.length === 0) return 0;
    return positive[Math.max(0, Math.ceil(positive.length * 0.95) - 1)];
}

/**
 * A member's grid is scaled to the hour itself, not to their own busiest cell:
 * "30" should be the same colour on everybody's card, or two members read side
 * by side look alike whatever they did.
 */
function topFor(values: readonly number[], kind: HeatmapKind): number {
    if (kind !== "member") return scaleTop(values);
    return values.some((value) => value > 0) ? 60 : 0;
}

function bandFor(value: number, top: number): number {
    if (value <= 0 || top <= 0) return -1;
    const normalised = Math.min(1, value / top);
    return Math.min(GAP_RAMP.length - 1, Math.floor(normalised * GAP_RAMP.length));
}

/**
 * The coverage grid arrives with its steps already decided (`gapBand` in
 * `domain/observation.ts`), because they turn on whether anybody was on shift
 * as well as on the figure, and the list of worst hours has to agree with them.
 */
function cellBand(grid: CoverageGrid, kind: HeatmapKind, weekday: number, hour: number, top: number): number {
    if (kind === "coverage") return grid.severity[weekday][hour];
    return bandFor(grid.demand[weekday][hour], top);
}

/**
 * A dark ring just inside an hour nobody was on shift for, so it reads as a
 * hole punched in the cell and never passes for staffed. Dark rather than
 * white: a white ring competed with the white figures on the dark steps, and
 * hatching made the figures underneath hard to read.
 */
const UNSTAFFED_RING = "#111216";

/** The legend's sample cell for the ring: grey, so it names no step. */
const RING_KEY_FILL = "#8a8d96";

function figure(value: number): string {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

const WORDING: Record<
    HeatmapKind,
    { empty: string; legend: string; ends: string; unseen: string }
> = {
    coverage: {
        empty: "No demand recorded",
        legend: "Messages per moderator on shift.",
        ends: "light to heavy load",
        unseen: "Dashed hours have not been heard yet."
    },
    activity: {
        empty: "No messages recorded",
        legend: "Average messages per hour.",
        ends: "quiet to busiest",
        unseen: "Dashed hours have not been heard yet."
    },
    member: {
        empty: "No activity recorded",
        legend: "Average activity minutes per hour, out of 60.",
        ends: "1 to 60 minutes",
        unseen: "Dashed hours were on leave or not heard."
    }
};

function panel(body: string, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <defs>${panelDefs(WIDTH, height)}
    </defs>
    ${panelGround(WIDTH, height)}
    ${panelRim(WIDTH, height)}
    ${body}
</svg>`;
}

/** Nothing was recorded. Say so, rather than drawing an empty grid. */
function emptyGrid(grid: CoverageGrid, kind: HeatmapKind): string {
    const height = 132;
    return panel(
        [
            `<text x="${WIDTH / 2}" y="${height / 2 - 8}" fill="${SURFACE.text}" ` +
                `font-size="16" font-family="${FONT_STACK}" font-weight="bold" ` +
                `letter-spacing="-0.2" text-anchor="middle">${WORDING[kind].empty}</text>`,
            `<text x="${WIDTH / 2}" y="${height / 2 + 16}" fill="${SURFACE.textMuted}" ` +
                `font-size="13" font-family="${FONT_STACK}" text-anchor="middle">` +
                `${escapeXml(grid.timeZone)}, ${sampleLabel(grid.observedHours)}. Nothing to plot yet.</text>`
        ].join("\n    "),
        height
    );
}

export function heatmapSvg(grid: CoverageGrid, kind: HeatmapKind = "coverage"): string {
    const values = kind === "coverage" ? grid.load : grid.demand;
    const top = topFor(values.flat(), kind);
    const palette = PALETTE[kind];
    if (top <= 0) return emptyGrid(grid, kind);
    let unstaffed = 0;
    let unseen = 0;

    const days = weekdayLabels(grid.weekStartDay);
    const parts: string[] = [
        `<text x="${LEFT_GUTTER}" y="28" fill="${SURFACE.text}" font-size="14" ` +
            `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.2">` +
            `${escapeXml(grid.timeZone)}, ${sampleLabel(grid.observedHours)}</text>`
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
            `<text x="${LEFT_GUTTER - 11}" y="${round(y + CELL / 2 + 4)}" ` +
                `fill="${SURFACE.textMuted}" font-size="11.5" font-family="${FONT_STACK}" ` +
                `text-anchor="end">${days[weekday]}</text>`
        );

        for (let hour = 0; hour < GRID_HOURS; hour += 1) {
            const x = LEFT_GUTTER + hour * CELL;
            const value = values[weekday][hour];
            if (grid.observed[weekday][hour] === 0) {
                unseen += 1;
                parts.push(
                    `<rect x="${round(x + 1.5)}" y="${round(y + 1.5)}" width="${CELL - 3}" ` +
                        `height="${CELL - 3}" rx="7" fill="none" stroke="${UNSEEN_STROKE}" ` +
                        `stroke-width="1" stroke-dasharray="3 3" />`
                );
                continue;
            }
            const band = cellBand(grid, kind, weekday, hour, top);
            parts.push(
                `<rect x="${round(x + 1.5)}" y="${round(y + 1.5)}" width="${CELL - 3}" ` +
                    `height="${CELL - 3}" rx="7" fill="${band < 0 ? EMPTY : palette.ramp[band]}" />`
            );
            // Colour alone would not say it: an unstaffed hour is lifted up the
            // scale, and the ring is what tells it from a staffed hour that was
            // merely heavy, in greyscale too.
            if (kind === "coverage" && band >= 0 && grid.unstaffed[weekday][hour]) {
                unstaffed += 1;
                parts.push(
                    `<rect x="${round(x + 3.5)}" y="${round(y + 3.5)}" width="${CELL - 7}" ` +
                        `height="${CELL - 7}" rx="5.5" fill="none" stroke="${UNSTAFFED_RING}" ` +
                        `stroke-width="2" />`
                );
            }

            // The number is in the cell as well as in the colour, because
            // colour never carries meaning alone. An empty hour has no number:
            // a grid of zeroes is noise, and its emptiness is already the point.
            if (band >= 0) {
                const label = figure(value);
                parts.push(
                    `<text x="${round(x + CELL / 2)}" y="${round(y + CELL / 2 + 3.5)}" ` +
                        `fill="${palette.ink[band]}" font-size="9.5" ` +
                        `font-family="${FONT_STACK}" ` +
                        `font-weight="bold" text-anchor="middle">${escapeXml(label)}</text>`
                );
            }
        }
    }

    const legendY = TOP_GUTTER + GRID_DAYS * CELL + 22;
    parts.push(
        `<text x="${LEFT_GUTTER}" y="${round(legendY)}" fill="${SURFACE.textMuted}" ` +
            `font-size="11" font-family="${FONT_STACK}">${WORDING[kind].legend}` +
            (kind === "coverage" && grid.typicalHour > 0
                ? ` A typical hour here is ${figure(grid.typicalHour)} messages.`
                : "") +
            (unseen > 0 ? ` ${WORDING[kind].unseen}` : "") +
            `</text>`
    );

    // Zero gets a swatch of its own before the bar. Empty cells are drawn in
    // the panel's own grey and carry no figure, and a bar starting at the
    // ramp's first colour beside "0 to …" said a zero was that colour.
    const zeroX = LEFT_GUTTER;
    const barY = round(legendY + 12);
    parts.push(
        `<rect x="${zeroX}" y="${barY}" width="18" height="9" rx="4.5" fill="${EMPTY}" ` +
            `stroke="url(#panelRim)" stroke-width="1" />`,
        `<text x="${zeroX + 24}" y="${round(barY + 8)}" fill="${SURFACE.textMuted}" ` +
            `font-size="10.5" font-family="${FONT_STACK}">0</text>`
    );

    // One continuous bar rather than separate chips: the scale is continuous,
    // and five detached lozenges implied five discrete bands.
    const barX = zeroX + 42;
    const barWidth = 168;
    const segments = palette.ramp.map((colour, index) => {
        const segment = barWidth / palette.ramp.length;
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
            `stroke="url(#panelRim)" stroke-width="1" />`,
        `<text x="${barX + barWidth + 10}" y="${round(barY + 8)}" fill="${SURFACE.textMuted}" ` +
            `font-size="10.5" font-family="${FONT_STACK}">${WORDING[kind].ends}</text>`
    );

    // Only when the grid has one, so the key never explains a mark nobody
    // can find.
    if (unstaffed > 0) {
        const ringX = barX + barWidth + 130;
        parts.push(
            // A grey sample cell: the ring goes on any step, so a swatch in
            // one of the ramp's colours would say it meant that step.
            `<rect x="${ringX}" y="${round(barY - 2.5)}" width="14" height="14" rx="4" ` +
                `fill="${RING_KEY_FILL}" />`,
            `<rect x="${ringX + 1.5}" y="${round(barY - 1)}" width="11" height="11" rx="3" ` +
                `fill="none" stroke="${UNSTAFFED_RING}" stroke-width="1.6" />`,
            `<text x="${ringX + 22}" y="${round(barY + 8)}" fill="${SURFACE.textMuted}" ` +
                `font-size="10.5" font-family="${FONT_STACK}">nobody on for most of the hour</text>`
        );
    }

    return panel(parts.join("\n    "), HEIGHT);
}

function perHour(value: number): string {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * One of the worst hours, in words: the share each moderator carried, or how
 * long nobody was there. Below one moderator there is no share to give, and
 * "504 messages an hour across 0.0 moderators: 504 each" was on the card for
 * an hour with ninety seconds of cover.
 */
export function gapLine(cell: GapCell): string {
    const messages = `${perHour(cell.demand)} messages an hour`;
    if (cell.coverage >= 1) {
        return (
            `${messages} across ${cell.coverage.toFixed(1)} moderators: ` +
            `**${perHour(cell.load)} each**`
        );
    }
    if (cell.uncovered >= 0.99) return `${messages}, **nobody on shift**`;
    const gapMinutes = Math.max(1, Math.round(cell.uncovered * 60));
    return `${messages}, **nobody on for ${gapMinutes} min** of it`;
}

/** How much data a grid rests on, for its header. */
export function sampleLabel(observedHours: number): string {
    if (observedHours < 24) {
        return `${observedHours} hour${observedHours === 1 ? "" : "s"} of data`;
    }
    if (observedHours < 14 * 24) {
        const days = Math.floor(observedHours / 24);
        return `${days} day${days === 1 ? "" : "s"} of data`;
    }
    return `${Math.round(observedHours / (7 * 24))} week mean`;
}

/**
 * What the reader should discount, or null once there is nothing to say.
 * Two weeks is where it stops: every cell has two readings, which is enough for
 * the shape of a week even if one evening can still move a single cell.
 */
export function reliabilityNote(
    observedHours: number,
    kind: HeatmapKind = "coverage"
): string | null {
    if (observedHours < 24) {
        // On a member's card a dashed cell is usually leave, not an hour that is
        // still to come; the chart's own legend already says so.
        const dashed = kind === "member" ? "were on leave or not heard" : "have not come round yet";
        return (
            `Based on ${observedHours} hour${observedHours === 1 ? "" : "s"}. Each filled cell ` +
            `is a single hour, and the dashed ones ${dashed}.`
        );
    }
    if (observedHours < 7 * 24) {
        const days = Math.floor(observedHours / 24);
        return (
            `Based on ${days} day${days === 1 ? "" : "s"}. Each cell is one reading, so a ` +
            "single unusual day can move it."
        );
    }
    if (observedHours < 14 * 24) {
        const days = Math.floor(observedHours / 24);
        return `Based on ${days} days. Cells will settle as the second week comes in.`;
    }
    return null;
}

function hours(count: number): string {
    return `${count} hour${count === 1 ? "" : "s"}`;
}

/** The subtext saying how much leave a member's grid left out, or nothing. */
export function leaveHoursNote(leaveHours: number): string {
    return leaveHours > 0 ? `\n-# ${hours(leaveHours)} on leave left out of the averages.` : "";
}

/**
 * What a member's card says in place of a grid with nothing on it.
 *
 * A window that was all leave is not a member who did nothing, and must not
 * read like one: it says so and stops, with no reliability note, because
 * "the dashed ones have not come round yet" is untrue of hours that came
 * round and were leave.
 */
export function memberEmptyNote(
    name: string,
    observedHours: number,
    leaveHours: number,
    windowHours: number
): string {
    if (observedHours === 0 && leaveHours > 0) {
        return leaveHours >= windowHours
            ? `_${name} was on leave for the whole of this window, so there is nothing to average._`
            : `_Nothing to average: ${name} was on leave for ${hours(leaveHours)} of this window, ` +
                  "and the bot was not listening for the rest._";
    }
    const note = reliabilityNote(observedHours, "member");
    return (
        `_No activity minutes recorded for ${name} in this window._` +
        leaveHoursNote(leaveHours) +
        (note === null ? "" : `\n-# ${note}`)
    );
}

export function renderHeatmap(grid: CoverageGrid, kind: HeatmapKind = "coverage"): Buffer {
    const resvg = new Resvg(heatmapSvg(grid, kind), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    return Buffer.from(resvg.render().asPng());
}
