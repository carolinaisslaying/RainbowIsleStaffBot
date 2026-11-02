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
 *    opposite decisions. The rows say which, and how each one ended.
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
/**
 * The divider under the row being reviewed sits 21 clear of the rail above and
 * the date below, one and a half times the 14 between ordinary rows. That takes
 * 28 more than an ordinary gap, and puts it 32 above the next row's baseline.
 */
const ROWS_DIVIDER_ROOM = 28;
const ROWS_DIVIDER_ABOVE_TITLE = 32;
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
    /** Leave made `requiredMinutes` lower than that fortnight's full requirement. */
    lowered: boolean;
    /** `ringStateFor`'s answer against `requiredMinutes`, so this and a ring agree. */
    state: RingState;
    /** How an earlier fortnight ended. Null on the one still being decided. */
    word: string | null;
}

/** The sub-line of one row. One pattern on every row, whatever it is about. */
export function trendDetail(point: TrendPoint): string {
    if (point.exempt) return `${point.minutes} minutes · on leave`;
    const under = point.requiredMinutes - point.minutes;
    return [
        `${point.minutes} of ${point.requiredMinutes} minutes`,
        ...(under > 0 ? [`${under} under`] : []),
        ...(point.lowered ? ["minimum lowered"] : []),
        ...(point.word ? [point.word] : [])
    ].join(" · ");
}

/**
 * The fortnight under review and those before it, newest first, as the ring
 * card's legend rows. The first point is always the one under review.
 *
 * Each row is measured against what that fortnight asked for and says so in
 * words, so a fortnight leave lowered needs no second line on a shared scale,
 * which is what bars against one dashed line kept getting wrong.
 *
 * An exempt row draws no rail, since nothing was asked to fill one, and keeps
 * the rail's height so the gaps between rows stay even.
 */
export function trendSvg(input: { points: TrendPoint[]; title: string }): string {
    if (input.points.length === 0) {
        return emptyPanel("No earlier fortnight to compare against.");
    }

    const right = ROWS_WIDTH - ROWS_PAD;
    const railWidth = right - ROWS_TEXT;
    const hasEarlier = input.points.length > 1;
    const parts = [chartTitle(input.title, ROWS_PAD)];

    for (const [index, point] of input.points.entries()) {
        const y = ROWS_FIRST + index * ROWS_GAP + (index > 0 ? ROWS_DIVIDER_ROOM : 0);
        const state: RingState = point.exempt ? "leave" : point.state;
        const share =
            point.exempt || point.requiredMinutes <= 0 ? 0 : point.minutes / point.requiredMinutes;

        if (index === 1) {
            parts.push(
                `<rect class="rows-divider" x="${ROWS_TEXT}" y="${y - ROWS_DIVIDER_ABOVE_TITLE}" ` +
                    `width="${railWidth}" height="1" fill="${SURFACE.rail}" />`
            );
        }

        parts.push(
            pip(PIP_CENTRE, y - 5, state),
            `<text x="${ROWS_TEXT}" y="${y}" font-family="${FONT_STACK}" font-size="15" ` +
                `font-weight="bold" letter-spacing="-0.2" fill="${SURFACE.text}">` +
                `${escapeXml(index === 0 ? `This fortnight · ${point.label}` : point.label)}</text>`,
            `<text x="${right}" y="${y}" text-anchor="end" font-family="${FONT_STACK}" font-size="15" ` +
                `font-weight="bold" letter-spacing="-0.3" fill="${OUTER_COLOURS[state].light}">` +
                `${point.exempt ? "exempt" : `${Math.round(share * 100)}%`}</text>`,
            `<text x="${ROWS_TEXT}" y="${y + 18}" font-family="${FONT_STACK}" font-size="12.5" ` +
                `fill="${SURFACE.textMuted}">${escapeXml(trendDetail(point))}</text>`
        );
        if (!point.exempt) {
            parts.push(
                `<rect class="rail-track" x="${ROWS_TEXT}" y="${y + 26}" width="${railWidth}" height="${RAIL_HEIGHT}" ` +
                    `rx="2" fill="${SURFACE.rail}" />`
            );
        }
        if (share > 0) {
            parts.push(
                `<rect class="rail-fill" x="${ROWS_TEXT}" y="${y + 26}" ` +
                    `width="${round(Math.max(RAIL_HEIGHT, Math.min(1, share) * railWidth))}" ` +
                    `height="${RAIL_HEIGHT}" rx="2" fill="url(#rail-${state})" />`
            );
        }
    }

    const height =
        ROWS_FIRST +
        (input.points.length - 1) * ROWS_GAP +
        (hasEarlier ? ROWS_DIVIDER_ROOM : 0) +
        ROWS_BELOW +
        ROWS_PAD;
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
    /** Below their own requirement, and so one of the rows awaiting a decision. */
    below: boolean;
    /** What this fortnight asked of them, when it differs from the chart's main line. */
    requiredMinutes?: number;
    /** `ringStateFor`'s answer against their own requirement, so this and a ring agree. */
    state: RingState;
}

/** The ring's own thickness, so a column and a ring read as the same mark. */
const COLUMN_WIDTH = 17;
const MAX_SLOT = 44;
/** Below this a figure and a name no longer fit beneath their column. */
const LABEL_SLOT = 30;
const NAME_CHAR_WIDTH = 5.2;
/** Room at the end of each line for its label, where no column can be. */
const SPREAD_GUTTER = 60;
const LINE_LABEL_GAP = 8;
/** Below this, "had leave" under each name would run into the next one's. */
const NOTE_SLOT = 42;
/** The extra height that line of text takes when any is drawn. */
const SPREAD_NOTE_ROW = 12;
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

/** People measured against one minimum: one dashed line and its label. */
interface SpreadGroup {
    requiredMinutes: number;
    entries: SpreadEntry[];
    left: number;
}

/**
 * Everybody's minutes for the fortnight, sorted, with the requirement across it.
 *
 * The question this answers is whether the fortnight was bad for the two people
 * in the queue or bad for everybody, because those are different conversations
 * and the queue alone cannot tell them apart: it only ever lists the people who
 * fell short.
 *
 * Leave can lower somebody's minimum, and they get their own group with their
 * own line rather than being read against one that is not theirs. They used to
 * be left off, so a chart titled "Everyone" counted one fewer below the line
 * than the queue beneath it, and nothing said why.
 *
 * Every line is labelled in a gutter at its own end, where no column can ever
 * be, so no figure can run through a label whatever the data.
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

    const base = SPREAD_TOP + SPREAD_PLOT;
    const ceiling = Math.max(1, input.requiredMinutes * SPREAD_CEILING);
    const y = (value: number) => base - (Math.min(value, ceiling) / ceiling) * SPREAD_PLOT;

    const byMinimum = new Map<number, SpreadEntry[]>();
    for (const entry of input.entries) {
        const minimum = entry.requiredMinutes ?? input.requiredMinutes;
        byMinimum.set(minimum, [...(byMinimum.get(minimum) ?? []), entry]);
    }

    const room = WIDTH - PAD * 2;
    const available = room - SPREAD_GUTTER * byMinimum.size;
    const slot = Math.min(MAX_SLOT, available / input.entries.length);
    const labelled = slot >= LABEL_SLOT;

    // A small roster sits in the middle rather than against one edge.
    let nextLeft = PAD + (available - slot * input.entries.length) / 2;
    const groups: SpreadGroup[] = [...byMinimum.entries()]
        .sort(([left], [right]) => right - left)
        .map(([requiredMinutes, entries]) => {
            const group = {
                requiredMinutes,
                entries: [...entries].sort((left, right) => right.minutes - left.minutes),
                left: nextLeft
            };
            nextLeft += slot * entries.length + SPREAD_GUTTER;
            return group;
        });

    const parts = [chartTitle(input.title, PAD)];
    const noted = labelled && groups.some((group) => group.requiredMinutes < input.requiredMinutes);

    for (const group of groups) {
        const line = y(group.requiredMinutes);
        const lowered = group.requiredMinutes < input.requiredMinutes;

        for (const [index, entry] of group.entries.entries()) {
            const centre = group.left + slot * index + slot / 2;
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
                if (entry.minutes > group.requiredMinutes) {
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

        // "Had" rather than "on": the leave may be long over, and "on leave"
        // beside a name reads as away now. Under each name while it fits there,
        // otherwise once beneath the group rather than over the neighbours'.
        if (labelled && lowered) {
            const width = slot * group.entries.length;
            const centres =
                slot >= NOTE_SLOT
                    ? group.entries.map((_, index) => group.left + slot * index + slot / 2)
                    : [group.left + width / 2];
            for (const centre of centres) {
                parts.push(
                    `<text class="spread-note" x="${round(centre)}" y="${base + 44}" text-anchor="middle" ` +
                        `font-family="${FONT_STACK}" font-size="9" fill="${SURFACE.textMuted}">had leave</text>`
                );
            }
        }

        const right = group.left + slot * group.entries.length;
        parts.push(
            `<line class="spread-line" x1="${round(group.left)}" y1="${round(line)}" x2="${round(right)}" y2="${round(line)}" ` +
                `stroke="${REQUIREMENT}" stroke-width="2" stroke-dasharray="5 4" />`,
            `<text class="spread-line-label" x="${round(right + LINE_LABEL_GAP)}" y="${round(line + 4)}" ` +
                `font-family="${FONT_STACK}" font-size="11" fill="${SURFACE.textMuted}">` +
                `${group.requiredMinutes} min</text>`
        );
    }

    const belowCount = input.entries.filter((entry) => entry.below).length;
    const captionY = base + (labelled ? 54 : 26) + (noted ? SPREAD_NOTE_ROW : 0);
    const legendY = captionY + 22;
    parts.push(
        `<text x="${PAD}" y="${captionY}" font-family="${FONT_STACK}" font-size="12.5" ` +
            `fill="${SURFACE.textMuted}">Minutes this fortnight. ${input.entries.length - belowCount} met the ` +
            `minimum and ${belowCount} did not.` +
            (input.entries.some((entry) => entry.minutes > ceiling) ? ` Bars stop at ${ceiling}.` : "") +
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
