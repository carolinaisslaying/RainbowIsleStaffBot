import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import type { RingState } from "../db/types.js";
import { cappedArcPath, escapeXml, round } from "./svg.js";
import { LruCache } from "../util/cache.js";
import { FONT_STACK, SURFACE } from "./theme.js";

/**
 * Three concentric rings in the Apple Watch arrangement.
 *
 * Outer: activity minutes against the weekly target. The only ring with
 * compliance meaning. Middle: shift hours. Inner: active days. Both soft.
 *
 * A ring is two strokes and nothing else: a flat track in its own colour at low
 * alpha, and a gradient arc over it with round ends. That is what the Watch
 * draws. Rims, sheens, lens discs and bright heads were tried and removed; each
 * one is defensible alone and together they turn three rings into twenty-seven
 * concentric circles that read as a camera lens.
 *
 * The track matters most at small percentages. Without it, eight percent is a
 * detached capsule floating at the top of the image with no indication of what
 * it is eight percent of.
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

/**
 * Each ring is a two stop gradient, light into deep, the way the Watch's are.
 * `light` is the 12 o'clock end and `core` the far end of the sweep.
 */
interface RingColours {
    core: string;
    light: string;
    /** The extra lap, once the ring has gone past its target. */
    overlay: string;
}

const OUTER_COLOURS: Record<RingState, RingColours> = {
    green: { core: "#30d158", light: "#6ef08d", overlay: "#a8f7bd" },
    amber: { core: "#ff9f0a", light: "#ffc960", overlay: "#ffdca6" },
    red: { core: "#ff453a", light: "#ff7b72", overlay: "#ffada7" },
    leave: { core: "#8e8e93", light: "#aeaeb2", overlay: "#c7c7cc" }
};

const MIDDLE_COLOURS: RingColours = {
    core: "#0a84ff",
    light: "#5cb3ff",
    overlay: "#a5d6ff"
};
const INNER_COLOURS: RingColours = {
    core: "#bf5af2",
    light: "#d99bf7",
    overlay: "#ecc9fb"
};
const LEAVE_SOFT: RingColours = { core: "#6e6e73", light: "#8e8e93", overlay: "#aeaeb2" };

const CANVAS = 200;
const CENTRE = CANVAS / 2;
const STROKE = 17;
const GAP = 9;

const OUTER_RADIUS = CENTRE - STROKE / 2 - 5;
const MIDDLE_RADIUS = OUTER_RADIUS - STROKE - GAP;
const INNER_RADIUS = MIDDLE_RADIUS - STROKE - GAP;

function ratio(value: number, target: number): number {
    if (target <= 0) return value > 0 ? 1 : 0;
    return Math.max(0, value / target);
}

/**
 * One ring: a track, an arc, and at most one extra lap.
 *
 * Overachievement wraps past 360 degrees with a lighter arc riding on the full
 * one, capped at a single extra revolution. A complete lap is drawn as a
 * circle, since an arc sweeping a whole turn has coincident endpoints and
 * renders as nothing.
 */
function ringMarkup(
    name: string,
    radius: number,
    progress: number,
    colours: RingColours
): string {
    const parts: string[] = [
        `<circle class="ring-track" cx="${CENTRE}" cy="${CENTRE}" r="${round(radius)}" ` +
            `fill="none" stroke="${colours.core}" stroke-opacity="${SURFACE.trackAlpha}" ` +
            `stroke-width="${STROKE}" />`
    ];

    const firstLap = Math.min(progress, 1);
    if (firstLap >= 1) {
        parts.push(
            `<circle class="ring-progress" cx="${CENTRE}" cy="${CENTRE}" ` +
                `r="${round(radius)}" fill="none" stroke="url(#arc-${name})" ` +
                `stroke-width="${STROKE}" />`
        );
    } else if (firstLap > 0) {
        parts.push(
            `<path class="ring-progress" ` +
                `d="${cappedArcPath(CENTRE, CENTRE, radius, 0, firstLap * 360, STROKE)}" ` +
                `fill="none" stroke="url(#arc-${name})" stroke-width="${STROKE}" ` +
                `stroke-linecap="round" />`
        );
    }

    const excess = Math.min(Math.max(progress - 1, 0), 1);
    if (excess > 0) {
        const width = round(STROKE * 0.46);
        parts.push(
            excess >= 1
                ? `<circle class="ring-overlay" cx="${CENTRE}" cy="${CENTRE}" ` +
                  `r="${round(radius)}" fill="none" stroke="${colours.overlay}" ` +
                  `stroke-width="${width}" />`
                : `<path class="ring-overlay" ` +
                  `d="${cappedArcPath(CENTRE, CENTRE, radius, 0, excess * 360, width)}" ` +
                  `fill="none" stroke="${colours.overlay}" stroke-width="${width}" ` +
                  `stroke-linecap="round" />`
        );
    }

    return parts.join("\n    ");
}

/**
 * The gradient for one arc.
 *
 * SVG has no conic gradient, so the colour runs across the ring's box instead
 * of around its circumference. Angled from the top left, that puts the light
 * end near twelve o'clock where every arc starts and deepens it as the arc
 * sweeps, which is close enough to the Watch's to read as the same idea.
 */
function arcGradient(name: string, colours: RingColours): string {
    return `
    <linearGradient id="arc-${name}" x1="0.15" y1="0" x2="0.9" y2="0.95">
        <stop offset="0" stop-color="${colours.light}" />
        <stop offset="1" stop-color="${colours.core}" />
    </linearGradient>`;
}

interface PlannedRing {
    name: string;
    radius: number;
    progress: number;
    colours: RingColours;
}

/** Which rings are drawn, at what radius, in what colours. */
function ringPlan(input: RingsInput): PlannedRing[] {
    const onLeave = input.state === "leave";
    const plan: PlannedRing[] = [
        {
            name: "outer",
            radius: OUTER_RADIUS,
            progress: ratio(input.activityMinutes, input.activityTarget),
            colours: OUTER_COLOURS[input.state]
        }
    ];
    if (input.softRingsEnabled) {
        plan.push({
            name: "middle",
            radius: MIDDLE_RADIUS,
            progress: ratio(input.shiftHours, input.shiftTarget),
            colours: onLeave ? LEAVE_SOFT : MIDDLE_COLOURS
        });
        plan.push({
            name: "inner",
            radius: INNER_RADIUS,
            progress: ratio(input.activeDays, input.activeDaysTarget),
            colours: onLeave ? LEAVE_SOFT : INNER_COLOURS
        });
    }
    return plan;
}

function draw(plan: PlannedRing[]): { defs: string; body: string } {
    return {
        defs: plan.map((ring) => arcGradient(ring.name, ring.colours)).join(""),
        body: plan
            .map((ring) => ringMarkup(ring.name, ring.radius, ring.progress, ring.colours))
            .join("\n    ")
    };
}

/**
 * The compact rings, for a thumbnail beside a line of text.
 *
 * These carry the percentage in the hole because nothing else on the row states
 * it. The labelled card does not: its legend already gives the same figure, and
 * printing it twice was half of why that card felt cluttered.
 */
export function ringsSvg(input: RingsInput): string {
    const plan = ringPlan(input);
    const { defs, body } = draw(plan);
    const achieved = Math.round(ratio(input.activityMinutes, input.activityTarget) * 100);
    // The hole is only 55 across. Four characters at 26 do not fit inside it,
    // and a readout overlapping the innermost ring is worse than a smaller one.
    const size = achieved >= 1000 ? 15 : achieved >= 100 ? 20 : 26;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
    <defs>${defs}
    </defs>
    ${body}
    <text x="${CENTRE}" y="${CENTRE + size / 3}" fill="${SURFACE.text}" font-size="${size}" font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.8" text-anchor="middle">${achieved}%</text>
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
 * The labelled ring card.
 *
 * Rings on the left, a legend on the right naming what each ring measures and
 * how far along it is. Putting the figures inside the image is what lets the
 * message itself be ordinary prose: no fenced block, no column padding, no
 * monospace.
 *
 * The panel is lighter than the Discord container behind it. That is the whole
 * fix for the card reading as a box inside a box: glass lifts off a surface,
 * and a panel darker than its surround reads as a hole cut in one. A wash of
 * each ring's colour, in proportion to how far that ring has actually gone,
 * gives the panel something to be lit by.
 */
const CARD_WIDTH = 460;
const CARD_HEIGHT = 196;
const RING_CENTRE = 100;
const RING_SCALE = 0.86;

interface LegendRow {
    label: string;
    detail: string;
    share: number;
    colour: string;
}

function legendRows(input: RingsInput): LegendRow[] {
    const onLeave = input.state === "leave";
    const rows: LegendRow[] = [
        {
            label: "Activity",
            detail: `${input.activityMinutes} of ${input.activityTarget} minutes`,
            share: ratio(input.activityMinutes, input.activityTarget),
            colour: OUTER_COLOURS[input.state].core
        }
    ];
    if (input.softRingsEnabled) {
        rows.push({
            label: "Shift time",
            detail: `${formatHours(input.shiftHours)} of ${input.shiftTarget} hours`,
            share: ratio(input.shiftHours, input.shiftTarget),
            colour: (onLeave ? LEAVE_SOFT : MIDDLE_COLOURS).core
        });
        rows.push({
            label: "Active days",
            detail: `${input.activeDays} of ${input.activeDaysTarget} days`,
            share: ratio(input.activeDays, input.activeDaysTarget),
            colour: (onLeave ? LEAVE_SOFT : INNER_COLOURS).core
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
    const { defs, body } = draw(plan);

    const rows = legendRows(input);
    const firstRowY = rows.length === 3 ? 52 : 88;
    const rowGap = 48;
    const legendX = 212;
    const legendRight = CARD_WIDTH - 24;
    const railWidth = legendRight - legendX;

    const legend = rows.flatMap((row, index) => {
        const y = firstRowY + index * rowGap;
        const filled = round(Math.min(1, row.share) * railWidth);
        return [
            `<text x="${legendX}" y="${y}" fill="${SURFACE.text}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.2">` +
                `${escapeXml(row.label)}</text>`,
            `<text x="${legendRight}" y="${y}" fill="${row.colour}" font-size="15" ` +
                `font-family="${FONT_STACK}" font-weight="bold" letter-spacing="-0.3" ` +
                `text-anchor="end">${Math.round(row.share * 100)}%</text>`,
            `<text x="${legendX}" y="${y + 17}" fill="${SURFACE.textMuted}" font-size="12.5" ` +
                `font-family="${FONT_STACK}">${escapeXml(row.detail)}</text>`,
            `<rect x="${legendX}" y="${y + 25}" width="${railWidth}" height="3" rx="1.5" ` +
                `fill="${SURFACE.rail}" />`,
            filled > 0
                ? `<rect x="${legendX}" y="${y + 25}" width="${filled}" height="3" rx="1.5" ` +
                  `fill="${row.colour}" />`
                : ""
        ].filter((line) => line !== "");
    });

    // One glow, centred under the rings, in the colour of the only ring that
    // carries compliance meaning. Three overlapping washes -- one per ring --
    // put a blotchy off-centre cloud in the corner of the card that read as a
    // smudge on the lens rather than as light.
    const lit = Math.min(1, plan[0].progress);
    const washOpacity = round(SURFACE.washMax * lit);
    const wash =
        washOpacity > 0.01
            ? {
                  def:
                      `<radialGradient id="wash">` +
                      `<stop offset="0" stop-color="${plan[0].colours.core}" ` +
                      `stop-opacity="${washOpacity}" />` +
                      `<stop offset="1" stop-color="${plan[0].colours.core}" ` +
                      `stop-opacity="0" />` +
                      `</radialGradient>`,
                  shape:
                      `<circle cx="${RING_CENTRE}" cy="${CARD_HEIGHT / 2}" r="128" ` +
                      `fill="url(#wash)" />`
              }
            : { def: "", shape: "" };

    const ringOffset = round(RING_CENTRE - CENTRE * RING_SCALE);
    const ringTop = round(CARD_HEIGHT / 2 - CENTRE * RING_SCALE);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
    <defs>${defs}
    ${wash.def}
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SURFACE.panelTop}" />
        <stop offset="1" stop-color="${SURFACE.panelBottom}" />
    </linearGradient>
    <clipPath id="panelClip">
        <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="18" />
    </clipPath>
    </defs>
    <g clip-path="url(#panelClip)">
        <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#panel)" />
        ${wash.shape}
    </g>
    <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${CARD_HEIGHT - 1}" rx="17.5" fill="none" stroke="${SURFACE.rimLight}" stroke-width="1" />
    <g transform="translate(${ringOffset}, ${ringTop}) scale(${RING_SCALE})">
    ${body}
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
