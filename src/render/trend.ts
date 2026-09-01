import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";
import { panelDefs, panelGround, panelRim } from "./panel.js";

/**
 * The two charts a fortnight review actually needs.
 *
 * The card already prints this fortnight's figure, so a chart that plots the
 * same number again earns nothing. Both of these answer a question the numbers
 * on the card cannot:
 *
 *  - **The member's history.** "0 of 240" reads the same whether somebody has
 *    always been at zero or fell off a cliff this fortnight, and those are
 *    opposite decisions. The bars say which.
 *  - **The fortnight's spread.** Whether 120 minutes is bad depends on what
 *    everybody else managed. A fortnight where the whole team collapsed is a
 *    different conversation from one person drifting.
 *
 * One hue, not a status palette. The requirement line carries met and below
 * geometrically, so colour never has to, which matters because red against
 * green is the worst pair there is for the commonest colour blindness: ΔE 7.9
 * under deuteranopia, well inside the band that is only legal with a second
 * encoding. Height against a labelled line is that encoding, and it works in
 * greyscale and in print.
 *
 * There is no hover layer, because a PNG in Discord has none. The card's text
 * carries every figure the chart shows, which is what stands in for the table.
 */

/** One hue, snapped to a step that passes the lightness band on this surface. */
const SERIES = "#2e9fb8";
/** The same hue, lifted, for the fortnight being decided right now. */
const SERIES_CURRENT = "#5ed0e6";
/** Neither a series nor a value: an absence. Exempt fortnights and no data. */
const ABSENT = "rgba(255,255,255,0.13)";
const REQUIREMENT = "rgba(255,255,255,0.42)";

/**
 * One margin, and everything else derived from it, as on the ring card and the
 * heatmap. The failure mode here is an image that looks a few pixels off-centre
 * and nobody can say why, so no position below is typed in twice.
 */
const PAD = 22;
/** Baseline of the title: inset by PAD, plus the cap height it sits on. */
const TITLE_BASELINE = PAD + 11;
const PLOT_TOP = TITLE_BASELINE + 20;
const PLOT_HEIGHT = 128;
const PLOT_BASE = PLOT_TOP + PLOT_HEIGHT;
/** Axis labels hang below the baseline; the panel ends PAD under their tails. */
const LABEL_BASELINE = PLOT_BASE + 18;
const LABEL_DESCENT = 3;
const WIDTH = 620;
const HEIGHT = LABEL_BASELINE + LABEL_DESCENT + PAD;
/** A sentence needs a panel the size of a sentence, not the size of a chart. */
const EMPTY_HEIGHT = PAD * 2 + 30;

function panel(body: string, width: number, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>${panelDefs(width, height)}</defs>
    ${panelGround(width, height)}
    ${panelRim(width, height)}
    ${body}
</svg>`;
}

/**
 * The nothing-to-plot panel, shared by both charts.
 *
 * Every empty-state bug in this codebase has been an axis drawn with no data on
 * it, which reads as a renderer that failed rather than as a fact about the
 * member. So the fact is written out instead.
 */
function emptyPanel(message: string): string {
    return panel(
        `<text x="${WIDTH / 2}" y="${EMPTY_HEIGHT / 2 + 5}" text-anchor="middle" ` +
            `font-family="${FONT_STACK}" font-size="13" fill="${SURFACE.textMuted}">` +
            `${escapeXml(message)}</text>`,
        WIDTH,
        EMPTY_HEIGHT
    );
}

export interface TrendPoint {
    /** Short label under the bar: the fortnight's start, "3 Aug". */
    label: string;
    minutes: number;
    /** On leave for the fortnight. Drawn as an absence, never as a zero. */
    exempt: boolean;
    /** The fortnight being decided. Lifted, and the only bar with its value on it. */
    current: boolean;
}

/**
 * A member's recent fortnights against the requirement.
 *
 * Bars rather than a line: six fortnights is a handful of discrete periods, and
 * a line between them implies readings in between that do not exist.
 */
export function trendSvg(input: {
    points: TrendPoint[];
    requiredMinutes: number;
    title: string;
}): string {
    // Nothing to plot is said in words. An empty axis reads as a broken
    // renderer, which is the failure mode every empty state here has had.
    if (input.points.length === 0) {
        return emptyPanel("No earlier fortnight to compare against.");
    }

    const plotLeft = PAD;
    const plotRight = WIDTH - PAD;
    const plotWidth = plotRight - plotLeft;
    const base = PLOT_BASE;

    // The requirement is always on the scale, so the line is never off the top
    // of a chart where everybody missed it, and a single huge fortnight cannot
    // squash the line to the floor.
    const peak = Math.max(input.requiredMinutes, ...input.points.map((p) => p.minutes));
    const ceiling = peak * 1.15;
    const y = (value: number) => base - (value / ceiling) * PLOT_HEIGHT;

    const slot = plotWidth / input.points.length;
    // A 2px gap of surface between neighbouring fills, as everywhere else.
    const barWidth = Math.min(46, slot - 10);

    const parts: string[] = [
        `<text x="${plotLeft}" y="${TITLE_BASELINE}" font-family="${FONT_STACK}" ` +
            `font-size="13" font-weight="600" fill="${SURFACE.text}">` +
            `${escapeXml(input.title)}</text>`
    ];

    for (const [index, point] of input.points.entries()) {
        const centre = plotLeft + slot * index + slot / 2;
        const x = centre - barWidth / 2;
        const fill = point.exempt
            ? ABSENT
            : point.current
              ? SERIES_CURRENT
              : SERIES;

        if (point.exempt) {
            // An absence is drawn at the full height of the plot in almost
            // nothing, so the fortnight is visibly accounted for rather than
            // looking like a zero somebody earned.
            parts.push(
                `<rect x="${round(x)}" y="${PLOT_TOP}" width="${round(barWidth)}" ` +
                    `height="${PLOT_HEIGHT}" rx="4" fill="${ABSENT}" />`,
                `<text x="${round(centre)}" y="${base - 8}" text-anchor="middle" ` +
                    `font-family="${FONT_STACK}" font-size="10" fill="${SURFACE.textMuted}">` +
                    "leave</text>"
            );
        } else {
            const top = y(point.minutes);
            const height = Math.max(2, base - top);
            parts.push(
                `<rect x="${round(x)}" y="${round(top)}" width="${round(barWidth)}" ` +
                    `height="${round(height)}" rx="4" fill="${fill}" />`
            );
        }

        parts.push(
            `<text x="${round(centre)}" y="${LABEL_BASELINE}" text-anchor="middle" ` +
                `font-family="${FONT_STACK}" font-size="10" fill="${SURFACE.textMuted}">` +
                `${escapeXml(point.label)}</text>`
        );

        // Selective direct labels: the fortnight being decided, and nothing
        // else. A number on every bar is a table pretending to be a chart.
        if (point.current && !point.exempt) {
            parts.push(
                `<text x="${round(centre)}" y="${round(y(point.minutes) - 7)}" ` +
                    `text-anchor="middle" font-family="${FONT_STACK}" font-size="11" ` +
                    `font-weight="700" fill="${SURFACE.text}">${point.minutes}</text>`
            );
        }
    }

    // The requirement, over the bars, labelled. This is what makes the chart
    // readable without colour.
    const line = y(input.requiredMinutes);
    parts.push(
        `<line x1="${plotLeft}" y1="${round(line)}" x2="${plotRight}" y2="${round(line)}" ` +
            `stroke="${REQUIREMENT}" stroke-width="2" stroke-dasharray="5 4" />`,
        `<text x="${plotRight}" y="${round(line - 6)}" text-anchor="end" ` +
            `font-family="${FONT_STACK}" font-size="10" fill="${SURFACE.textMuted}">` +
            `${input.requiredMinutes} min required</text>`
    );

    return panel(parts.join("\n    "), WIDTH, HEIGHT);
}

export function renderTrend(input: Parameters<typeof trendSvg>[0]): Buffer {
    const resvg = new Resvg(trendSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        font: FONT_OPTIONS
    });
    return resvg.render().asPng();
}

export interface SpreadEntry {
    minutes: number;
    /** Below the requirement, and so one of the rows awaiting a decision. */
    below: boolean;
}

const SPREAD_CAPTION = PLOT_BASE + 20;
const SPREAD_HEIGHT = SPREAD_CAPTION + LABEL_DESCENT + PAD;

/**
 * Everybody's minutes for the fortnight, sorted, with the requirement across it.
 *
 * The question this answers is whether the fortnight was bad for the two people
 * in the queue or bad for everybody, because those are different conversations
 * and the queue alone cannot tell them apart: it only ever lists the people who
 * fell short.
 */
export function spreadSvg(input: {
    entries: SpreadEntry[];
    requiredMinutes: number;
    title: string;
}): string {
    if (input.entries.length === 0) {
        return emptyPanel("Nobody was assessed for this fortnight.");
    }

    const sorted = [...input.entries].sort((left, right) => right.minutes - left.minutes);
    const plotLeft = PAD;
    const plotRight = WIDTH - PAD;
    const base = PLOT_BASE;
    const peak = Math.max(input.requiredMinutes, ...sorted.map((entry) => entry.minutes));
    const ceiling = peak * 1.15;
    const y = (value: number) => base - (value / ceiling) * PLOT_HEIGHT;

    const slot = (plotRight - plotLeft) / sorted.length;
    const barWidth = Math.max(3, Math.min(26, slot - 3));

    const parts: string[] = [
        `<text x="${plotLeft}" y="${TITLE_BASELINE}" font-family="${FONT_STACK}" ` +
            `font-size="13" font-weight="600" fill="${SURFACE.text}">` +
            `${escapeXml(input.title)}</text>`
    ];

    for (const [index, entry] of sorted.entries()) {
        const x = plotLeft + slot * index + (slot - barWidth) / 2;
        const top = y(entry.minutes);
        parts.push(
            `<rect x="${round(x)}" y="${round(top)}" width="${round(barWidth)}" ` +
                `height="${round(Math.max(2, base - top))}" rx="2" ` +
                // Below the line is drawn in the absence value rather than in a
                // second hue: the line already says which side they are on, and
                // a red bar here would be the bot expressing an opinion the
                // Executive has not formed yet.
                `fill="${entry.below ? ABSENT : SERIES}" />`
        );
    }

    const line = y(input.requiredMinutes);
    const belowCount = sorted.filter((entry) => entry.below).length;
    parts.push(
        `<line x1="${plotLeft}" y1="${round(line)}" x2="${plotRight}" y2="${round(line)}" ` +
            `stroke="${REQUIREMENT}" stroke-width="2" stroke-dasharray="5 4" />`,
        `<text x="${plotRight}" y="${round(line - 6)}" text-anchor="end" ` +
            `font-family="${FONT_STACK}" font-size="10" fill="${SURFACE.textMuted}">` +
            `${input.requiredMinutes} min required</text>`,
        `<text x="${plotLeft}" y="${SPREAD_CAPTION}" font-family="${FONT_STACK}" font-size="10" ` +
            `fill="${SURFACE.textMuted}">${sorted.length} assessed, ${belowCount} below ` +
            `the line</text>`
    );

    return panel(parts.join("\n    "), WIDTH, SPREAD_HEIGHT);
}

export function renderSpread(input: Parameters<typeof spreadSvg>[0]): Buffer {
    const resvg = new Resvg(spreadSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        font: FONT_OPTIONS
    });
    return resvg.render().asPng();
}
