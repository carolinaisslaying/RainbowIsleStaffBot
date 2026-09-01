import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import type { RingState } from "../db/types.js";
import { cappedArcPath, capAngle, escapeXml, polarToCartesian, round } from "./svg.js";
import { LruCache } from "../util/cache.js";
import { FONT_STACK, GLASS } from "./theme.js";

/**
 * Three concentric rings in the Apple Watch arrangement, drawn as glass.
 *
 * Outer: activity minutes against the weekly target. The only ring with
 * compliance meaning. Middle: shift hours. Inner: active days. Both soft.
 *
 * Each ring is built as a lit tube rather than a stroke. Bottom to top: the
 * filament's own colour blurred underneath as escaping glow, a frosted channel
 * with a bright inner rim and a dark outer one, the saturated filament itself,
 * a specular sheen laid across the top left where the tube curves towards the
 * light, and a bright head at the leading edge. That order is the whole
 * illusion, and it is why the empty part of a ring reads as glass with nothing
 * behind it rather than as a grey line.
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
 * An earlier palette gave each ring a darkened tint of its own progress colour,
 * which meant an empty ring rendered as a muddy dark disc that read as broken
 * rather than as empty. The track is now the same frosted glass on all three,
 * so the progress colour is the only thing carrying state.
 */
const TRACK = GLASS.frost;

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

const PANEL_TEXT = GLASS.text;
const PANEL_MUTED = GLASS.textMuted;

const OUTER_RADIUS = CENTRE - STROKE / 2 - 4;
const MIDDLE_RADIUS = OUTER_RADIUS - STROKE - GAP;
const INNER_RADIUS = MIDDLE_RADIUS - STROKE - GAP;

function ratio(value: number, target: number): number {
    if (target <= 0) return value > 0 ? 1 : 0;
    return Math.max(0, value / target);
}

/**
 * The filters and gradients every ring draws through.
 *
 * Ids are derived from the ring's name rather than randomised, so two renders
 * of the same figures produce byte-identical markup and the PNG cache is
 * actually a cache.
 */
function ringDefs(name: string, colours: RingColours): string {
    return `
    <radialGradient id="head-${name}" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.75" />
        <stop offset="0.5" stop-color="${colours.overlay}" stop-opacity="0.5" />
        <stop offset="1" stop-color="${colours.stroke}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="lit-${name}" x1="0.1" y1="0" x2="0.85" y2="1">
        <stop offset="0" stop-color="${colours.overlay}" />
        <stop offset="0.45" stop-color="${colours.stroke}" />
        <stop offset="1" stop-color="${colours.stroke}" />
    </linearGradient>
`;
}

/**
 * The sheen, as a stroke that fades rather than an arc that stops.
 *
 * Drawn as a whole circle with a gradient falling to nothing, so the highlight
 * has no ends. An arc with round caps left two white dots sitting on the track
 * like specks of dust: the eye reads a terminated highlight as an object, and a
 * fading one as a surface.
 */
const SHEEN_GRADIENT = `
    <linearGradient id="sheen" x1="0.18" y1="0.02" x2="0.72" y2="0.85">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.30" />
        <stop offset="0.16" stop-color="#ffffff" stop-opacity="0.06" />
        <stop offset="0.34" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>`;

/**
 * One ring.
 *
 * Overachievement wraps past 360 degrees with a lighter overlay arc, capped at
 * one extra revolution. A full lap is drawn as a circle, since an arc sweeping
 * a whole turn has coincident endpoints and renders as nothing.
 */
function ringMarkup(
    name: string,
    radius: number,
    progress: number,
    colours: RingColours,
    glow = true
): string {
    const parts: string[] = [];
    const firstLap = Math.min(progress, 1);
    const complete = firstLap >= 1;

    // The glow escaping the glass, drawn first so everything above sits in its
    // light rather than beside it.
    //
    // Three widening strokes rather than a Gaussian blur. The blur was prettier
    // by a hair and cost 20ms of a 27ms render, which is a second of stall on a
    // forty row leaderboard; stacked strokes land the same halo for 1ms. The
    // widths and opacities are tuned so the falloff reads as light rather than
    // as three visible rings.
    if (firstLap > 0 && glow) {
        const halo = (width: number, opacity: number) =>
            complete
                ? `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" fill="none" ` +
                  `stroke="${colours.stroke}" stroke-opacity="${opacity}" ` +
                  `stroke-width="${round(width)}" />`
                : `<path d="${cappedArcPath(CENTRE, CENTRE, radius, 0, firstLap * 360, width)}" ` +
                  `fill="none" stroke="${colours.stroke}" stroke-opacity="${opacity}" ` +
                  `stroke-width="${round(width)}" stroke-linecap="round" />`;
        parts.push(
            `<g class="ring-bloom">` +
                halo(STROKE * 1.78, 0.05) +
                halo(STROKE * 1.46, 0.08) +
                halo(STROKE * 1.18, 0.12) +
                `</g>`
        );
    }

    // The frosted channel, and the two rims that give it a cross section. A
    // stroke cannot be shaded across its own width, so the curvature is drawn
    // as a bright hairline inside and a dark one outside.
    parts.push(
        `<circle class="ring-track" cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" ` +
            `fill="none" stroke="${TRACK}" stroke-width="${STROKE}" />`,
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius + STROKE / 2 - 0.7)}" ` +
            `fill="none" stroke="${GLASS.rimShade}" stroke-width="1.4" />`,
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius - STROKE / 2 + 0.7)}" ` +
            `fill="none" stroke="${GLASS.paneRim}" stroke-width="1.4" />`
    );

    // The filament.
    if (complete) {
        parts.push(
            `<circle class="ring-progress" cx="${CENTRE}" cy="${CENTRE}" ` +
                `r="${round(radius)}" fill="none" stroke="url(#lit-${name})" ` +
                `stroke-width="${STROKE}" />`
        );
    } else if (firstLap > 0) {
        parts.push(
            `<path class="ring-progress" ` +
                `d="${cappedArcPath(CENTRE, CENTRE, radius, 0, firstLap * 360, STROKE)}" ` +
                `fill="none" stroke="url(#lit-${name})" stroke-width="${STROKE}" ` +
                `stroke-linecap="round" />`
        );
    }

    // The filament's own inner edge, mirroring the channel's cross section so
    // the lit part of the ring is the same tube as the empty part.
    if (firstLap > 0) {
        const inner = complete
            ? `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(radius - STROKE / 2 + 1.1)}" ` +
              `fill="none" stroke="rgba(0,0,0,0.20)" stroke-width="2.2" />`
            : `<path d="${cappedArcPath(CENTRE, CENTRE, radius - STROKE / 2 + 1.1, 0, firstLap * 360, 2.2)}" ` +
              `fill="none" stroke="rgba(0,0,0,0.20)" stroke-width="2.2" stroke-linecap="round" />`;
        parts.push(inner);
    }

    // Overachievement, riding on top of a lap already full.
    const excess = Math.min(Math.max(progress - 1, 0), 1);
    if (excess > 0) {
        const overlayWidth = round(STROKE * 0.5);
        if (excess >= 1) {
            parts.push(
                `<circle class="ring-overlay" cx="${CENTRE}" cy="${CENTRE}" ` +
                    `r="${round(radius)}" fill="none" stroke="${colours.overlay}" ` +
                    `stroke-width="${overlayWidth}" />`
            );
        } else {
            parts.push(
                `<path class="ring-overlay" ` +
                    `d="${cappedArcPath(CENTRE, CENTRE, radius, 0, excess * 360, overlayWidth)}" ` +
                    `fill="none" stroke="${colours.overlay}" stroke-width="${overlayWidth}" ` +
                    `stroke-linecap="round" />`
            );
        }
    }

    // The sheen: glass catching the light across its top left shoulder. Laid
    // over track and filament alike, because the surface is one surface, and
    // ridden slightly outboard of centre, where a real tube would catch it.
    parts.push(
        `<circle class="ring-sheen" cx="${CENTRE}" cy="${CENTRE}" ` +
            `r="${round(radius + STROKE * 0.24)}" fill="none" stroke="url(#sheen)" ` +
            `stroke-width="${round(STROKE * 0.30)}" />`
    );

    // The head: the bright point where the filament ends. Only while the ring
    // is still running, since a completed ring has no leading edge to light.
    if (firstLap > 0 && !complete) {
        const head = polarToCartesian(CENTRE, CENTRE, radius, firstLap * 360);
        parts.push(
            `<circle class="ring-head" cx="${round(head.x)}" cy="${round(head.y)}" ` +
                `r="${round(STROKE * 0.38)}" fill="url(#head-${name})" />`
        );
    }

    return parts.join("\n    ");
}

/** Which rings are drawn, and in what colours, for a given input. */
function ringPlan(input: RingsInput): Array<{
    name: string;
    radius: number;
    progress: number;
    colours: RingColours;
    glow: boolean;
}> {
    const onLeave = input.state === "leave";
    // Leave is meant to recede. A glowing grey ring is louder than a quiet
    // coloured one, which says the opposite of what being on leave means.
    const glow = !onLeave;
    const plan = [
        {
            name: "outer",
            radius: OUTER_RADIUS,
            progress: ratio(input.activityMinutes, input.activityTarget),
            colours: OUTER_COLOURS[input.state],
            glow
        }
    ];
    if (input.softRingsEnabled) {
        plan.push({
            name: "middle",
            radius: MIDDLE_RADIUS,
            progress: ratio(input.shiftHours, input.shiftTarget),
            colours: onLeave ? LEAVE_SOFT : MIDDLE_COLOURS,
            glow
        });
        plan.push({
            name: "inner",
            radius: INNER_RADIUS,
            progress: ratio(input.activeDays, input.activeDaysTarget),
            colours: onLeave ? LEAVE_SOFT : INNER_COLOURS,
            glow
        });
    }
    return plan;
}

/**
 * The readout in the hole, on its own small lens.
 *
 * A ring at zero is otherwise three empty channels and tells the reader
 * nothing, so the outer ring's percentage always sits in the middle. The disc
 * under it is the same material as the rings: it keeps the figure legible over
 * whatever the innermost ring is doing, and it is the one place the glass is
 * lit from directly rather than from behind.
 */
function readout(achieved: number, colour: string, size: number): string {
    const discRadius = size * 1.72;
    return [
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(discRadius)}" ` +
            `fill="url(#lens)" />`,
        `<circle cx="${CENTRE}" cy="${CENTRE}" r="${round(discRadius)}" fill="none" ` +
            `stroke="${GLASS.paneRim}" stroke-width="1" />`,
        `<text x="${CENTRE}" y="${CENTRE + size / 3}" fill="${colour}" ` +
            `font-size="${size}" font-family="${FONT_STACK}" font-weight="bold" ` +
            `letter-spacing="-0.5" text-anchor="middle">${achieved}%</text>`
    ].join("\n    ");
}

/** The lens under the readout. Shared by both ring images. */
const LENS_GRADIENT = `
    <radialGradient id="lens" cx="35%" cy="28%" r="78%">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.16" />
        <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.05" />
        <stop offset="1" stop-color="#000000" stop-opacity="0.22" />
    </radialGradient>`;

/** The SVG source. Exposed separately so tests can assert on it without resvg. */
export function ringsSvg(input: RingsInput): string {
    const plan = ringPlan(input);
    const defs = plan.map((ring) => ringDefs(ring.name, ring.colours)).join("");
    const body = plan.map((ring) =>
        ringMarkup(ring.name, ring.radius, ring.progress, ring.colours, ring.glow)
    );

    const outer = OUTER_COLOURS[input.state];
    const achieved = Math.round(ratio(input.activityMinutes, input.activityTarget) * 100);
    const labelSize = achieved >= 1000 ? 15 : 19;
    body.push(readout(achieved, outer.stroke, labelSize));

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
    <defs>${defs}${SHEEN_GRADIENT}${LENS_GRADIENT}
    </defs>
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
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
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
 * monospace.
 *
 * Here the glass gets what the compact rings cannot have: something behind it.
 * The panel is a frosted sheet over blurred blooms of the ring colours, so the
 * material actually has light to bend, and a card for a member doing well is
 * quietly a different colour from one for a member who is not.
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
    const plan = ringPlan(input);
    const defs = plan.map((ring) => ringDefs(ring.name, ring.colours)).join("");
    const rings = plan.map((ring) =>
        ringMarkup(ring.name, ring.radius, ring.progress, ring.colours, ring.glow)
    );

    const outer = OUTER_COLOURS[input.state];
    const achieved = Math.round(ratio(input.activityMinutes, input.activityTarget) * 100);
    const readoutSize = achieved >= 1000 ? 16 : 21;
    rings.push(readout(achieved, outer.stroke, readoutSize));

    const rows = legendRows(input);
    const firstRowY = rows.length === 3 ? 58 : 92;
    const rowGap = 46;
    const legendX = 224;
    const legendRight = CARD_WIDTH - 26;
    const railWidth = legendRight - legendX - 16;

    const legend: string[] = [];
    rows.forEach((row, index) => {
        const y = firstRowY + index * rowGap;
        legend.push(
            `<circle cx="${legendX}" cy="${y - 5}" r="5" fill="${row.colour}" />`,
            `<circle cx="${legendX}" cy="${y - 5}" r="5" fill="none" ` +
                `stroke="${GLASS.rimLight}" stroke-width="0.6" />`,
            `<text x="${legendX + 16}" y="${y}" fill="${PANEL_TEXT}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.2">` +
                `${escapeXml(row.label)}</text>`,
            `<text x="${legendRight}" y="${y}" fill="${row.colour}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold" text-anchor="end">` +
                `${Math.round(row.share * 100)}%</text>`,
            `<text x="${legendX + 16}" y="${y + 18}" fill="${PANEL_MUTED}" font-size="13" ` +
                `font-family="${FONT_STACK}">${escapeXml(row.detail)}</text>`,
            // A slim rail under each row, cut from the same glass as the rings,
            // so the legend shows progress as well as stating it.
            `<rect x="${legendX + 16}" y="${y + 26}" width="${railWidth}" ` +
                `height="4" rx="2" fill="${GLASS.frost}" />`,
            `<rect x="${legendX + 16}" y="${y + 26}" width="${railWidth}" height="4" rx="2" ` +
                `fill="none" stroke="${GLASS.rimShade}" stroke-width="0.5" />`,
            `<rect x="${legendX + 16}" y="${y + 26}" ` +
                `width="${round(Math.min(1, row.share) * railWidth)}" ` +
                `height="4" rx="2" fill="${row.colour}" />`
        );
    });

    // The light behind the glass: each ring's colour, blurred, placed where its
    // own ring sits. A card is tinted by how its member is actually doing.
    const blobGradients = plan
        .map((ring, index) => {
            // Lit by the filament, so a ring at zero casts no colour. Without
            // this an empty card is washed with a red haze it has not earned,
            // and reads as a failure state rather than as a week not yet begun.
            const lit = Math.min(1, ring.progress);
            const opacity = round((0.34 - index * 0.08) * lit);
            if (opacity <= 0.01) return "";
            // A radial gradient is already a soft blob, so the backdrop needs
            // no blur filter to be out of focus. That is the whole cost of the
            // card's glass: a gradient instead of a 34 pixel Gaussian.
            return (
                `<radialGradient id="blob-${ring.name}">` +
                `<stop offset="0" stop-color="${ring.colours.stroke}" stop-opacity="${opacity}" />` +
                `<stop offset="0.55" stop-color="${ring.colours.stroke}" ` +
                `stop-opacity="${round(opacity * 0.45)}" />` +
                `<stop offset="1" stop-color="${ring.colours.stroke}" stop-opacity="0" />` +
                `</radialGradient>`
            );
        })
        .filter((blob) => blob !== "")
        .join("\n    ");

    const blobs = plan
        .map((ring, index) =>
            Math.min(1, ring.progress) * (0.34 - index * 0.08) > 0.01
                ? `<ellipse cx="${RING_CENTRE + index * 26}" cy="${70 + index * 40}" ` +
                  `rx="${150 - index * 24}" ry="${120 - index * 20}" ` +
                  `fill="url(#blob-${ring.name})" />`
                : ""
        )
        .filter((blob) => blob !== "")
        .join("\n        ");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
    <defs>${defs}${SHEEN_GRADIENT}${LENS_GRADIENT}
    ${blobGradients}
    <linearGradient id="substrate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${GLASS.substrateTop}" />
        <stop offset="1" stop-color="${GLASS.substrateBottom}" />
    </linearGradient>
    <linearGradient id="paneRim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.22" />
        <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.04" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0.10" />
    </linearGradient>
    <clipPath id="panel">
        <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="22" />
    </clipPath>
    </defs>
    <g clip-path="url(#panel)">
        <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#substrate)" />
        ${blobs}
        <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${GLASS.pane}" />
    </g>
    <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="21.5" fill="none" stroke="url(#paneRim)" stroke-width="1" />
    <g transform="translate(${RING_CENTRE - CENTRE}, 0)">
    ${rings.join("\n    ")}
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
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    const png = Buffer.from(resvg.render().asPng());
    if (key) cardCache.set(key, png);
    return png;
}
