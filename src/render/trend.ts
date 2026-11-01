import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";
import { panelDefs, panelGround, panelRim } from "./panel.js";
import { OUTER_COLOURS } from "./rings.js";
import type { RingState } from "../db/types.js";

/**
 * The two charts a fortnight review actually needs.
 *
 * The card already prints this fortnight's figure, so a chart that plots the
 * same number again earns nothing. Both of these answer a question the numbers
 * on the card cannot:
 *
 *  - **The member's history.** "0 of 240" reads the same whether somebody has
 *    always been at zero or fell off a cliff this fortnight, and those are
 *    opposite decisions. The rows say which.
 *  - **The fortnight's spread.** Whether 120 minutes is bad depends on what
 *    everybody else managed. A fortnight where the whole team collapsed is a
 *    different conversation from one person drifting.
 *
 * Both speak the ring card's language rather than one of their own: its panel,
 * its state colours and its track and fill, so a member's bar and their ring
 * cannot say different things. These used to be one blue, which left met and
 * below to the dashed line alone, and an Executive found the result a sea of
 * blue that meant nothing. Colour is never alone here either: every figure is
 * printed, which is what survives greyscale and colour blindness.
 *
 * There is no hover layer, because a PNG in Discord has none.
 */

const PAD = 22;
/** The ring card's own margin, width and legend sizes, for the rows drawn like it. */
const ROWS_PAD = 24;
const ROWS_WIDTH = 460;
const ROWS_GAP = 55;
const ROWS_FIRST = 62;
const ROWS_BELOW = 30;
const PIP_RADIUS = 5;
const PIP_HALO = 8.5;
const PIP_CENTRE = ROWS_PAD + PIP_HALO + 1;
const ROWS_TEXT = PIP_CENTRE + 16;
const RAIL_HEIGHT = 4;
const TITLE_BASELINE = 33;

const WIDTH = 620;
const REQUIREMENT = "rgba(255,255,255,0.42)";
/** A sentence needs a panel the size of a sentence, not the size of a chart. */
const EMPTY_HEIGHT = PAD * 2 + 30;

/** Each state's fill, rail and bead, lit the way the ring card's are. */
function stateDefs(): string {
    return (Object.keys(OUTER_COLOURS) as RingState[])
        .map((state) => {
            const { core, light } = OUTER_COLOURS[state];
            return (
                `<linearGradient id="column-${state}" x1="0" y1="0" x2="0" y2="1">` +
                `<stop offset="0" stop-color="${light}" /><stop offset="1" stop-color="${core}" />` +
                `</linearGradient>` +
                `<linearGradient id="rail-${state}" x1="0" y1="0" x2="1" y2="0">` +
                `<stop offset="0" stop-color="${core}" /><stop offset="1" stop-color="${light}" />` +
                `</linearGradient>` +
                `<radialGradient id="pip-${state}" cx="0.34" cy="0.28" r="0.85">` +
                `<stop offset="0" stop-color="${light}" /><stop offset="1" stop-color="${core}" />` +
                `</radialGradient>`
            );
        })
        .join("");
}

function panel(body: string, width: number, height: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>${panelDefs(width, height)}${stateDefs()}</defs>
    ${panelGround(width, height)}
    ${body}
    ${panelRim(width, height)}
</svg>`;
}

function chartTitle(title: string, x: number): string {
    return (
        `<text x="${x}" y="${TITLE_BASELINE}" font-family="${FONT_STACK}" font-size="14" ` +
        `font-weight="bold" letter-spacing="-0.2" fill="${SURFACE.text}">${escapeXml(title)}</text>`
    );
}

function pip(centre: number, y: number, state: RingState): string {
    return (
        `<circle class="pip-halo" cx="${centre}" cy="${round(y)}" r="${PIP_HALO}" fill="none" ` +
        `stroke="${OUTER_COLOURS[state].core}" stroke-opacity="${SURFACE.trackAlpha}" stroke-width="2" />` +
        `<circle class="pip-bead" cx="${centre}" cy="${round(y)}" r="${PIP_RADIUS}" fill="url(#pip-${state})" />`
    );
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
    /** The fortnight's start, "3 Aug". */
    label: string;
    minutes: number;
    /** On leave for the fortnight. Drawn as an absence, never as a zero. */
    exempt: boolean;
    /** What this fortnight asked for, which leave can have made lower. */
    requiredMinutes: number;
    /** `ringStateFor`'s answer against `requiredMinutes`, so this and a ring agree. */
    state: RingState;
}

/**
 * A member's recent fortnights, oldest first, as the ring card's legend rows.
 *
 * Each row is measured against what that fortnight asked for and says so in
 * words, so a fortnight leave lowered needs no second line on a shared scale,
 * which is what bars against one dashed line kept getting wrong.
 */
export function trendSvg(input: { points: TrendPoint[]; fullMinutes: number; title: string }): string {
    if (input.points.length === 0) {
        return emptyPanel("No earlier fortnight to compare against.");
    }

    const right = ROWS_WIDTH - ROWS_PAD;
    const railWidth = right - ROWS_TEXT;
    const parts = [chartTitle(input.title, ROWS_PAD)];

    for (const [index, point] of input.points.entries()) {
        const y = ROWS_FIRST + index * ROWS_GAP;
        const state: RingState = point.exempt ? "leave" : point.state;
        const share =
            point.exempt || point.requiredMinutes <= 0 ? 0 : point.minutes / point.requiredMinutes;
        const detail = point.exempt
            ? "On leave, nothing asked"
            : `${point.minutes} of ${point.requiredMinutes} minutes` +
              (point.requiredMinutes < input.fullMinutes ? " (minimum lowered for leave)" : "");

        parts.push(
            pip(PIP_CENTRE, y - 5, state),
            `<text x="${ROWS_TEXT}" y="${y}" font-family="${FONT_STACK}" font-size="15" ` +
                `font-weight="bold" letter-spacing="-0.2" fill="${SURFACE.text}">${escapeXml(point.label)}</text>`,
            `<text x="${right}" y="${y}" text-anchor="end" font-family="${FONT_STACK}" font-size="15" ` +
                `font-weight="bold" letter-spacing="-0.3" fill="${OUTER_COLOURS[state].light}">` +
                `${point.exempt ? "exempt" : `${Math.round(share * 100)}%`}</text>`,
            `<text x="${ROWS_TEXT}" y="${y + 18}" font-family="${FONT_STACK}" font-size="12.5" ` +
                `fill="${SURFACE.textMuted}">${escapeXml(detail)}</text>`,
            `<rect x="${ROWS_TEXT}" y="${y + 26}" width="${railWidth}" height="${RAIL_HEIGHT}" ` +
                `rx="2" fill="${SURFACE.rail}" />`
        );
        if (share > 0) {
            parts.push(
                `<rect class="rail-fill" x="${ROWS_TEXT}" y="${y + 26}" ` +
                    `width="${round(Math.max(RAIL_HEIGHT, Math.min(1, share) * railWidth))}" ` +
                    `height="${RAIL_HEIGHT}" rx="2" fill="url(#rail-${state})" />`
            );
        }
    }

    const height = ROWS_FIRST + (input.points.length - 1) * ROWS_GAP + ROWS_BELOW + ROWS_PAD;
    return panel(parts.join("\n    "), ROWS_WIDTH, height);
}

export function renderTrend(input: Parameters<typeof trendSvg>[0]): Buffer {
    const svg = trendSvg(input);
    const resvg = new Resvg(svg, {
        fitTo: { mode: "width", value: (input.points.length === 0 ? WIDTH : ROWS_WIDTH) * 2 },
        font: FONT_OPTIONS
    });
    return resvg.render().asPng();
}

export interface SpreadEntry {
    /** Their staff name, as `chartName` prepares it for the column. */
    name: string;
    minutes: number;
    /** Below the requirement, and so one of the rows awaiting a decision. */
    below: boolean;
    /** `ringStateFor`'s answer against the requirement, so this and a ring agree. */
    state: RingState;
}

/** The ring's own thickness, so a column and a ring read as the same mark. */
const COLUMN_WIDTH = 17;
const MAX_SLOT = 44;
/** Below this a figure and a name no longer fit beneath their column. */
const LABEL_SLOT = 30;
const NAME_CHAR_WIDTH = 4.5;
const SPREAD_TOP = 50;
const SPREAD_PLOT = 130;
/** The tallest a column goes, as a multiple of the requirement. */
const SPREAD_CEILING = 2;
const SMALLEST_FILL = 4;

/**
 * A name as the image can draw it: the two fonts installed cover Latin, Greek
 * and Cyrillic, so anything else, an emoji in a nickname above all, would come
 * out as a box. Only here. Discord's own text keeps the whole name.
 */
export function chartName(name: string): string {
    const kept = name
        .replace(/[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{Zs}]/gu, "")
        .trim();
    return kept === "" ? "?" : kept;
}

function fitName(name: string, slot: number): string {
    const room = Math.max(3, Math.floor(slot / NAME_CHAR_WIDTH));
    return name.length <= room ? name : `${name.slice(0, room - 1)}…`;
}

function column(x: number, top: number, base: number, fill: string, extra = ""): string {
    const height = base - top;
    return (
        `<rect x="${round(x)}" y="${round(top)}" width="${COLUMN_WIDTH}" height="${round(height)}" ` +
        `rx="${round(Math.min(COLUMN_WIDTH, height) / 2)}" fill="${fill}" ${extra}/>`
    );
}

/**
 * Everybody's minutes for the fortnight, sorted, with the requirement across it.
 *
 * The question this answers is whether the fortnight was bad for the two people
 * in the queue or bad for everybody, because those are different conversations
 * and the queue alone cannot tell them apart: it only ever lists the people who
 * fell short.
 *
 * The scale stops at twice the requirement. It used to run to the busiest
 * member, and two people on 3000 minutes squashed the requirement and everyone
 * below it onto the floor, which is the part of the chart a review is about.
 * Past the line a column goes lighter, as a ring does past 100%.
 */
export function spreadSvg(input: {
    entries: SpreadEntry[];
    requiredMinutes: number;
    amberPercent: number;
    title: string;
}): string {
    if (input.entries.length === 0) {
        return emptyPanel("Nobody was assessed for this fortnight.");
    }

    const sorted = [...input.entries].sort((left, right) => right.minutes - left.minutes);
    const base = SPREAD_TOP + SPREAD_PLOT;
    const ceiling = Math.max(1, input.requiredMinutes * SPREAD_CEILING);
    const y = (value: number) => base - (Math.min(value, ceiling) / ceiling) * SPREAD_PLOT;

    const room = WIDTH - PAD * 2;
    const slot = Math.min(MAX_SLOT, room / sorted.length);
    // A small roster sits in the middle rather than against one edge.
    const left = PAD + (room - slot * sorted.length) / 2;
    const labelled = slot >= LABEL_SLOT;
    const line = y(input.requiredMinutes);

    const parts = [chartTitle(input.title, PAD)];

    for (const [index, entry] of sorted.entries()) {
        const centre = left + slot * index + slot / 2;
        const x = centre - COLUMN_WIDTH / 2;
        const fill = `url(#column-${entry.state})`;

        if (entry.below) {
            parts.push(
                column(x, line, base, OUTER_COLOURS[entry.state].core,
                    `class="spread-track" fill-opacity="${SURFACE.trackAlpha}" `)
            );
        }
        // Nothing at zero: a mark there is a figure somebody did not earn, and
        // the track above it already says how far they had to go.
        if (entry.minutes > 0) {
            const top = Math.min(y(entry.minutes), base - SMALLEST_FILL);
            if (entry.minutes > input.requiredMinutes) {
                parts.push(
                    column(x, top, base, OUTER_COLOURS[entry.state].overlay, `class="spread-past" `),
                    column(x, line, base, fill, `class="spread-fill" `)
                );
            } else {
                parts.push(column(x, top, base, fill, `class="spread-fill" `));
            }
        }
        if (labelled) {
            parts.push(
                `<text x="${round(centre)}" y="${base + 18}" text-anchor="middle" font-family="${FONT_STACK}" ` +
                    `font-size="10.5" font-weight="bold" fill="${SURFACE.text}">${entry.minutes}</text>`,
                `<text class="spread-name" x="${round(centre)}" y="${base + 32}" text-anchor="middle" ` +
                    `font-family="${FONT_STACK}" font-size="9" fill="${SURFACE.textMuted}">` +
                    `${escapeXml(fitName(entry.name, slot))}</text>`
            );
        }
    }

    // Above the line at the right, where the short columns leave room for it;
    // up beside the title when even the last column reaches past the line.
    const lastClear = (sorted.at(-1)?.minutes ?? 0) < input.requiredMinutes;
    const belowCount = sorted.filter((entry) => entry.below).length;
    const captionY = base + (labelled ? 54 : 26);
    const legendY = captionY + 22;
    parts.push(
        `<line x1="${PAD}" y1="${round(line)}" x2="${WIDTH - PAD}" y2="${round(line)}" ` +
            `stroke="${REQUIREMENT}" stroke-width="2" stroke-dasharray="5 4" />`,
        `<text x="${WIDTH - PAD}" y="${round(lastClear ? line - 6 : TITLE_BASELINE)}" text-anchor="end" ` +
            `font-family="${FONT_STACK}" font-size="11" fill="${SURFACE.textMuted}">` +
            `${input.requiredMinutes} min minimum</text>`,
        `<text x="${PAD}" y="${captionY}" font-family="${FONT_STACK}" font-size="12.5" ` +
            `fill="${SURFACE.textMuted}">Minutes this fortnight. ${sorted.length - belowCount} met the ` +
            `minimum and ${belowCount} did not.` +
            (sorted.some((entry) => entry.minutes > ceiling) ? ` Bars stop at ${ceiling}.` : "") +
            `</text>`
    );

    const key: [RingState, string][] = [
        ["green", "met"],
        ["amber", `${input.amberPercent}% or more`],
        ["red", `under ${input.amberPercent}%`]
    ];
    let keyX = PAD + PIP_HALO + 1;
    for (const [state, label] of key) {
        parts.push(
            pip(keyX, legendY, state),
            `<text x="${keyX + 15}" y="${legendY + 4}" font-family="${FONT_STACK}" font-size="12.5" ` +
                `fill="${SURFACE.textMuted}">${escapeXml(label)}</text>`
        );
        keyX += 15 + label.length * 6.6 + 26;
    }

    return panel(parts.join("\n    "), WIDTH, Math.round(legendY + PIP_HALO + 1 + PAD));
}

export function renderSpread(input: Parameters<typeof spreadSvg>[0]): Buffer {
    const resvg = new Resvg(spreadSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        font: FONT_OPTIONS
    });
    return resvg.render().asPng();
}
