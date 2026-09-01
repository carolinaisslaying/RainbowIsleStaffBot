import { Resvg } from "@resvg/resvg-js";
import type { RingState } from "../db/types.js";
import { arcPath, escapeXml, polarToCartesian, round } from "./svg.js";
import { LruCache } from "../util/cache.js";
import { FONT_STACK } from "./theme.js";

/**
 * Three concentric rings in the Apple Watch arrangement.
 *
 * Outer: activity minutes against the weekly target. The only ring with
 * compliance meaning. Middle: shift hours. Inner: active days. Both soft.
 *
 * renderRings is a pure function of its input. No Discord types reach inside it.
 */

export interface RingsInput {
    activityMinutes: number;
    activityTarget: number;
    shiftHours: number;
    shiftTarget: number;
    activeDays: number;
    activeDaysTarget: number;
    state: RingState;
    softRingsEnabled: boolean;
    /** Cache identity. Not drawn. */
    cacheKey?: string;
}

interface RingColours {
    stroke: string;
    overlay: string;
}

/**
 * One neutral track for every ring.
 *
 * The previous palette gave each ring a darkened tint of its own progress
 * colour, which meant an empty ring rendered as a muddy dark disc that read as
 * broken rather than as empty. A single light grey track keeps the geometry
 * legible at zero and lets the progress colour be the only thing that carries
 * state.
 */
const TRACK = "#42444d";

const OUTER_COLOURS: Record<RingState, RingColours> = {
    green: { stroke: "#32d74b", overlay: "#9af5b0" },
    amber: { stroke: "#ff9f0a", overlay: "#ffd08a" },
    red: { stroke: "#ff453a", overlay: "#ffa39c" },
    leave: { stroke: "#98989d", overlay: "#d1d1d6" }
};

const MIDDLE_COLOURS: RingColours = { stroke: "#0a84ff", overlay: "#8ac4ff" };
const INNER_COLOURS: RingColours = { stroke: "#bf5af2", overlay: "#e0aaf8" };
const LEAVE_SOFT: RingColours = { stroke: "#6e6e73", overlay: "#aeaeb2" };

const CANVAS = 200;
const CENTRE = CANVAS / 2;
const STROKE = 18;
const GAP = 7;

/** Panel behind the detailed card, so its labels are legible in either theme. */
const PANEL = "#1e1f24";
const PANEL_TEXT = "#f2f3f5";
const PANEL_MUTED = "#9a9ba1";

const OUTER_RADIUS = CENTRE - STROKE / 2 - 4;
const MIDDLE_RADIUS = OUTER_RADIUS - STROKE - GAP;
const INNER_RADIUS = MIDDLE_RADIUS - STROKE - GAP;

function ratio(value: number, target: number): number {
    if (target <= 0) return value > 0 ? 1 : 0;
    return Math.max(0, value / target);
}

/**
 * One ring.
 *
 * Butt line caps rather than round: the arc ends on the exact angle its figure
 * describes, so the drawing agrees with the number beside it instead of
 * overhanging it by half a stroke width.
 *
 * Overachievement wraps past 360 degrees with a lighter overlay arc, capped at
 * one extra revolution. A full lap is drawn as a circle, since an arc sweeping
 * a whole turn has coincident endpoints and renders as nothing.
 */
function ringMarkup(radius: number, progress: number, colours: RingColours): string {
    const parts: string[] = [];

    parts.push(
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" fill="none" ` +
            `stroke="${TRACK}" stroke-width="${STROKE}" />`
    );

    const firstLap = Math.min(progress, 1);
    if (firstLap >= 1) {
        parts.push(
            `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" fill="none" ` +
                `stroke="${colours.stroke}" stroke-width="${STROKE}" />`
        );
    } else if (firstLap > 0) {
        parts.push(
            `<path d="${arcPath(CENTRE, CENTRE, radius, 0, firstLap * 360)}" fill="none" ` +
                `stroke="${colours.stroke}" stroke-width="${STROKE}" stroke-linecap="butt" />`
        );
    }

    const excess = Math.min(Math.max(progress - 1, 0), 1);
    if (excess > 0) {
        const overlayWidth = round(STROKE * 0.5);
        if (excess >= 1) {
            parts.push(
                `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" fill="none" ` +
                    `stroke="${colours.overlay}" stroke-width="${overlayWidth}" />`
            );
        } else {
            parts.push(
                `<path d="${arcPath(CENTRE, CENTRE, radius, 0, excess * 360)}" fill="none" ` +
                    `stroke="${colours.overlay}" stroke-width="${overlayWidth}" ` +
                    `stroke-linecap="butt" />`
            );
        }
    }

    return parts.join("\n    ");
}

/** The SVG source. Exposed separately so tests can assert on it without resvg. */
export function ringsSvg(input: RingsInput): string {
    const outer = OUTER_COLOURS[input.state];
    const onLeave = input.state === "leave";
    const middle = onLeave ? LEAVE_SOFT : MIDDLE_COLOURS;
    const inner = onLeave ? LEAVE_SOFT : INNER_COLOURS;

    const body: string[] = [
        ringMarkup(
            input.softRingsEnabled ? OUTER_RADIUS : OUTER_RADIUS,
            ratio(input.activityMinutes, input.activityTarget),
            outer
        )
    ];

    if (input.softRingsEnabled) {
        body.push(ringMarkup(MIDDLE_RADIUS, ratio(input.shiftHours, input.shiftTarget), middle));
        body.push(ringMarkup(INNER_RADIUS, ratio(input.activeDays, input.activeDaysTarget), inner));
    }

    // The outer ring's percentage, in the hole. A ring at zero is otherwise
    // three grey circles and tells the reader nothing on its own.
    const achieved = Math.round(ratio(input.activityMinutes, input.activityTarget) * 100);
    const labelSize = achieved >= 1000 ? 15 : 19;
    body.push(
        `<text x="${CENTRE}" y="${CENTRE + labelSize / 3}" fill="${outer.stroke}" ` +
            `font-size="${labelSize}" font-family="${FONT_STACK}" font-weight="bold" ` +
            `text-anchor="middle">${achieved}%</text>`
    );

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
    <rect width="${CANVAS}" height="${CANVAS}" fill="none" />
    ${body.join("\n    ")}
    <title>${escapeXml(describeRings(input))}</title>
</svg>`;
}

/** Text equivalent of the image. Also used as the alt text on the attachment. */
export function describeRings(input: RingsInput): string {
    const outer = `${input.activityMinutes} of ${input.activityTarget} activity minutes`;
    if (!input.softRingsEnabled) return outer;
    return (
        `${outer}, ${round(input.shiftHours)} of ${input.shiftTarget} shift hours, ` +
        `${input.activeDays} of ${input.activeDaysTarget} active days`
    );
}

/**
 * PNG cache keyed by identity plus the three numerator values, so refreshing a
 * 40 row leaderboard does not rasterise 40 images.
 */
const pngCache = new LruCache<string, Buffer>(512);

export function ringsCacheKey(
    staffId: string,
    weekStart: Date,
    input: Pick<RingsInput, "activityMinutes" | "shiftHours" | "activeDays" | "state" | "softRingsEnabled">
): string {
    return [
        staffId,
        weekStart.getTime(),
        input.activityMinutes,
        Math.round(input.shiftHours * 100),
        input.activeDays,
        input.state,
        input.softRingsEnabled ? 1 : 0
    ].join(":");
}

/** Pure function: state in, PNG buffer out. Rasterised at 2x. */
export function renderRings(input: RingsInput): Buffer {
    const key = input.cacheKey;
    if (key) {
        const hit = pngCache.get(key);
        if (hit) return hit;
    }

    const resvg = new Resvg(ringsSvg(input), {
        fitTo: { mode: "width", value: CANVAS * 2 },
        background: "rgba(0,0,0,0)"
    });
    const png = Buffer.from(resvg.render().asPng());

    if (key) pngCache.set(key, png);
    return png;
}

export function clearRingCache(): void {
    pngCache.clear();
}

/**
 * The detailed ring card.
 *
 * Rings on the left, a legend on the right naming what each ring measures and
 * how far along it is. Putting the figures inside the image is what lets the
 * message itself be ordinary prose: no fenced block, no column padding, no
 * monospace. It also makes the picture say something on its own, which three
 * grey circles never did.
 *
 * The panel is opaque because the labels have to stay legible whichever theme
 * the reader uses; a transparent background would put light text on white.
 */
const CARD_WIDTH = 470;
const CARD_HEIGHT = 200;
const RING_CENTRE = 104;

interface LegendRow {
    label: string;
    detail: string;
    share: number;
    colour: string;
}

function legendRows(input: RingsInput): LegendRow[] {
    const rows: LegendRow[] = [
        {
            label: "Activity",
            detail: `${input.activityMinutes} of ${input.activityTarget} minutes`,
            share: ratio(input.activityMinutes, input.activityTarget),
            colour: OUTER_COLOURS[input.state].stroke
        }
    ];
    if (input.softRingsEnabled) {
        const onLeave = input.state === "leave";
        rows.push({
            label: "Shift time",
            detail: `${formatHours(input.shiftHours)} of ${input.shiftTarget} hours`,
            share: ratio(input.shiftHours, input.shiftTarget),
            colour: (onLeave ? LEAVE_SOFT : MIDDLE_COLOURS).stroke
        });
        rows.push({
            label: "Active days",
            detail: `${input.activeDays} of ${input.activeDaysTarget} days`,
            share: ratio(input.activeDays, input.activeDaysTarget),
            colour: (onLeave ? LEAVE_SOFT : INNER_COLOURS).stroke
        });
    }
    return rows;
}

function formatHours(hours: number): string {
    const rounded = Math.round(hours * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function ringCardSvg(input: RingsInput): string {
    const outer = OUTER_COLOURS[input.state];
    const onLeave = input.state === "leave";
    const middle = onLeave ? LEAVE_SOFT : MIDDLE_COLOURS;
    const inner = onLeave ? LEAVE_SOFT : INNER_COLOURS;

    const rings: string[] = [
        ringMarkup(OUTER_RADIUS, ratio(input.activityMinutes, input.activityTarget), outer)
    ];
    if (input.softRingsEnabled) {
        rings.push(ringMarkup(MIDDLE_RADIUS, ratio(input.shiftHours, input.shiftTarget), middle));
        rings.push(ringMarkup(INNER_RADIUS, ratio(input.activeDays, input.activeDaysTarget), inner));
    }

    const achieved = Math.round(ratio(input.activityMinutes, input.activityTarget) * 100);
    const readoutSize = achieved >= 1000 ? 16 : 21;

    const rows = legendRows(input);
    const firstRowY = rows.length === 3 ? 58 : 92;
    const rowGap = 46;
    const legendX = 224;
    const legendRight = CARD_WIDTH - 26;

    const legend: string[] = [];
    rows.forEach((row, index) => {
        const y = firstRowY + index * rowGap;
        legend.push(
            `<circle cx="${legendX}" cy="${y - 5}" r="5" fill="${row.colour}" />`,
            `<text x="${legendX + 16}" y="${y}" fill="${PANEL_TEXT}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold">${escapeXml(row.label)}</text>`,
            `<text x="${legendRight}" y="${y}" fill="${row.colour}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold" text-anchor="end">` +
                `${Math.round(row.share * 100)}%</text>`,
            `<text x="${legendX + 16}" y="${y + 18}" fill="${PANEL_MUTED}" font-size="13" ` +
                `font-family="${FONT_STACK}">${escapeXml(row.detail)}</text>`,
            // A slim rail under each row, so the legend shows progress as well
            // as stating it.
            `<rect x="${legendX + 16}" y="${y + 26}" width="${legendRight - legendX - 16}" ` +
                `height="3" rx="1.5" fill="${TRACK}" />`,
            `<rect x="${legendX + 16}" y="${y + 26}" ` +
                `width="${round(Math.min(1, row.share) * (legendRight - legendX - 16))}" ` +
                `height="3" rx="1.5" fill="${row.colour}" />`
        );
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
    <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="14" fill="${PANEL}" />
    <g transform="translate(${RING_CENTRE - CENTRE}, 0)">
    ${rings.join("\n    ")}
    <text x="${CENTRE}" y="${CENTRE + readoutSize / 3}" fill="${outer.stroke}" font-size="${readoutSize}" font-family="${FONT_STACK}" font-weight="bold" text-anchor="middle">${achieved}%</text>
    </g>
    ${legend.join("\n    ")}
    <title>${escapeXml(describeRings(input))}</title>
</svg>`;
}

const cardCache = new LruCache<string, Buffer>(512);

/** Wide labelled card. Rasterised at 2x, like the compact rings. */
export function renderRingCard(input: RingsInput): Buffer {
    const key = input.cacheKey ? `card:${input.cacheKey}` : null;
    if (key) {
        const hit = cardCache.get(key);
        if (hit) return hit;
    }
    const resvg = new Resvg(ringCardSvg(input), {
        fitTo: { mode: "width", value: CARD_WIDTH * 2 },
        background: "rgba(0,0,0,0)"
    });
    const png = Buffer.from(resvg.render().asPng());
    if (key) cardCache.set(key, png);
    return png;
}
