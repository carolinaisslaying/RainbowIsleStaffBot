import { Resvg } from "@resvg/resvg-js";
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder
} from "discord.js";
import type { RingState } from "../db/types.js";
import { RING_STATE_COLOUR } from "../domain/rings.js";
import { ts } from "../time/format.js";
import { text, V2_FLAGS, type RenderedMessage } from "./cards.js";
import { FONT_OPTIONS } from "./fonts.js";
import { panelDefs, panelGround, panelRim } from "./panel.js";
import { OUTER_COLOURS } from "./rings.js";
import { SHIFT_START_BUTTON } from "./shiftReminder.js";
import { cappedArcPath, escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";

export interface FortnightRingInput {
    minutes: number;
    requiredMinutes: number;
    /** What a fortnight asks for without leave, to say when this one asks for less. */
    fullMinutes: number;
    week1Minutes: number;
    week2Minutes: number;
    week1Exempt: boolean;
    week2Exempt: boolean;
    state: RingState;
}

const WIDTH = 460;
const HEIGHT = 200;
const PAD = 24;
const RING_RADIUS = 66;
const RING_STROKE = 20;
const RING_CENTRE = HEIGHT / 2;
const TEXT_X = 196;
const RIGHT = WIDTH - PAD;
const RAIL_HEIGHT = 4;

function label(x: number, y: number, content: string, extra: string, fill: string = SURFACE.textMuted): string {
    return (
        `<text x="${x}" y="${y}" font-family="${FONT_STACK}" fill="${fill}" ${extra}>` +
        `${escapeXml(content)}</text>`
    );
}

function weekFigure(minutes: number, exempt: boolean, current: boolean): string {
    if (exempt) return minutes > 0 ? `${minutes} min, exempt` : "Exempt, on leave";
    return `${minutes} min${current ? " so far" : ""}`;
}

/**
 * One ring, for the one number the fortnight asks for, with the two weeks beside
 * it. Deliberately not the three-ring card: that is a week's card and is read as
 * one, shift time and active days do not count towards the minimum, and its
 * targets here would be double the ones the member knows.
 *
 * The arc is `cappedArcPath`, as on the real rings, so it stops on the true angle
 * and a near-full ring keeps a visible gap instead of looking closed.
 */
export function fortnightRingSvg(input: FortnightRingInput): string {
    const colours = OUTER_COLOURS[input.state];
    const share = input.requiredMinutes > 0 ? Math.min(1, input.minutes / input.requiredMinutes) : 0;
    const railWidth = RIGHT - TEXT_X;
    const lowered = input.requiredMinutes < input.fullMinutes;
    // Rounded as everywhere else, but somebody a minute short never reads 100%.
    const percent = `${Math.min(input.minutes < input.requiredMinutes ? 99 : 100, Math.round(share * 100))}%`;

    const parts = [
        `<circle class="ring-track" cx="${RING_CENTRE}" cy="${RING_CENTRE}" r="${RING_RADIUS}" fill="none" ` +
            `stroke="${colours.core}" stroke-opacity="${SURFACE.trackAlpha}" stroke-width="${RING_STROKE}" />`,
        label(RING_CENTRE, RING_CENTRE + 2, String(Math.max(0, input.requiredMinutes - input.minutes)),
            `font-size="30" font-weight="bold" letter-spacing="-0.8" text-anchor="middle"`, SURFACE.text),
        label(RING_CENTRE, RING_CENTRE + 20, "min to go", `font-size="11" text-anchor="middle"`),
        label(TEXT_X, 52, "This fortnight", `font-size="15" font-weight="bold" letter-spacing="-0.2"`, SURFACE.text),
        label(TEXT_X, 70, `${input.minutes} of ${input.requiredMinutes} minutes${lowered ? " (lowered for leave)" : ""}`,
            `font-size="12.5"`),
        `<rect x="${TEXT_X}" y="78" width="${railWidth}" height="${RAIL_HEIGHT}" rx="2" fill="${SURFACE.rail}" />`,
        label(TEXT_X, 116, "Week 1", `font-size="13" font-weight="bold"`, SURFACE.text),
        label(RIGHT, 116, weekFigure(input.week1Minutes, input.week1Exempt, false), `font-size="13" text-anchor="end"`),
        label(TEXT_X, 142, "Week 2", `font-size="13" font-weight="bold"`, SURFACE.text),
        label(RIGHT, 142, weekFigure(input.week2Minutes, input.week2Exempt, true), `font-size="13" text-anchor="end"`)
    ];

    // Nothing lit and no "0%" at zero: "240 to go" says it, kindly enough.
    if (input.minutes > 0) {
        parts.push(
            `<path class="ring-progress" d="${cappedArcPath(RING_CENTRE, RING_CENTRE, RING_RADIUS, 0, share * 360, RING_STROKE)}" ` +
                `fill="none" stroke="url(#arc)" stroke-width="${RING_STROKE}" stroke-linecap="round" />`,
            label(RIGHT, 52, percent, `font-size="15" font-weight="bold" text-anchor="end"`, colours.light),
            `<rect class="rail-fill" x="${TEXT_X}" y="78" width="${round(Math.max(RAIL_HEIGHT, share * railWidth))}" ` +
                `height="${RAIL_HEIGHT}" rx="2" fill="url(#rail)" />`
        );
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${panelDefs(WIDTH, HEIGHT)}
    <linearGradient id="arc" x1="0.15" y1="0" x2="0.9" y2="0.95"><stop offset="0" stop-color="${colours.light}" /><stop offset="1" stop-color="${colours.core}" /></linearGradient>
    <linearGradient id="rail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${colours.core}" /><stop offset="1" stop-color="${colours.light}" /></linearGradient>
    </defs>
    ${panelGround(WIDTH, HEIGHT)}
    ${parts.join("\n    ")}
    ${panelRim(WIDTH, HEIGHT)}
</svg>`;
}

export function fortnightReminderCard(input: FortnightRingInput & {
    title: string;
    closesAt: Date;
}): RenderedMessage {
    const png = new Resvg(fortnightRingSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        font: FONT_OPTIONS
    })
        .render()
        .asPng();
    const description =
        `${input.minutes} of ${input.requiredMinutes} minutes this fortnight, ` +
        `${Math.max(0, input.requiredMinutes - input.minutes)} to go.`;
    const fileName = "fortnight.png";

    const container = new ContainerBuilder()
        .setAccentColor(RING_STATE_COLOUR[input.state])
        .addTextDisplayComponents(
            text(`## ${input.title}\nThe fortnight closes ${ts(input.closesAt, "F")} (${ts(input.closesAt, "R")})`)
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`).setDescription(description)
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(SHIFT_START_BUTTON)
                    .setLabel("Start shift")
                    .setStyle(ButtonStyle.Success)
            )
        );

    return {
        components: [container],
        files: [new AttachmentBuilder(png, { name: fileName, description })],
        flags: V2_FLAGS
    };
}
