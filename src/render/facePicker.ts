import { Resvg } from "@resvg/resvg-js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK, SURFACE } from "./theme.js";
import { panelDefs, panelGround, panelRim } from "./panel.js";
import { FACES, ringColours, type RingFace } from "./faces.js";
import { RING_CANVAS, RING_EDGE_INSET, outerColoursFor, sampleRings } from "./rings.js";

/**
 * The four faces, side by side, so the choice is made by looking rather than by
 * reading four colour names.
 *
 * Every swatch is drawn by the ring renderer itself, at the same sample
 * progress, so what a member picks is what they get. Naming the face inside the
 * image rather than only on its button is what makes the picker survive being
 * scrolled past on a phone: the label cannot come adrift from the rings it
 * belongs to.
 *
 * The outer ring is green in all four, and says so underneath. It is the one
 * ring a face does not touch, and showing it in each swatch would otherwise
 * imply it were part of the choice.
 */

const CELL = 160;
const PAD = 22;
const RING_BOX = 106;
const LABEL_BLOCK = 40;
const HEIGHT = PAD + RING_BOX + LABEL_BLOCK + PAD;

/** A good week, so the swatch shows what a full set of rings looks like. */
const SAMPLE = [1, 0.72, 0.66];

interface Swatch {
    defs: string;
    body: string;
}

function swatch(face: RingFace, index: number): Swatch {
    const scale = round(RING_BOX / (RING_CANVAS - RING_EDGE_INSET * 2));
    const cellX = PAD + index * CELL;
    const { defs, body } = sampleRings(
        face.id,
        [outerColoursFor("green"), ringColours(face.shift), ringColours(face.days)],
        SAMPLE
    );

    // Centre the 200 canvas in the cell, allowing for the inset the rings
    // already carry inside it.
    const offset = round(cellX + (CELL - RING_BOX) / 2 - RING_EDGE_INSET * scale);
    const top = round(PAD - RING_EDGE_INSET * scale);

    return {
        defs,
        body:
            `<g transform="translate(${offset}, ${top}) scale(${scale})">${body}</g>` +
            `<text x="${round(cellX + CELL / 2)}" y="${PAD + RING_BOX + 22}" ` +
            `fill="${SURFACE.text}" font-size="15" font-family="${FONT_STACK}" ` +
            `font-weight="bold" letter-spacing="-0.2" text-anchor="middle">` +
            `${escapeXml(face.name)}</text>`
    };
}

export function facePickerSvg(faces: RingFace[] = FACES): string {
    const width = PAD * 2 + faces.length * CELL;
    const parts = faces.map((face, index) => swatch(face, index));

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">
    <defs>${parts.map((part) => part.defs).join("")}${panelDefs(width, HEIGHT)}
    </defs>
    ${panelGround(width, HEIGHT)}
    ${panelRim(width, HEIGHT)}
    ${parts.map((part) => part.body).join("\n    ")}
    <text x="${width / 2}" y="${HEIGHT - PAD + 4}" fill="${SURFACE.textMuted}" font-size="11.5" font-family="${FONT_STACK}" text-anchor="middle">The outer ring is your activity target and never changes colour with the face.</text>
    <title>${escapeXml(describeFaces(faces))}</title>
</svg>`;
}

/** Text equivalent, and the attachment's alt text. */
export function describeFaces(faces: RingFace[] = FACES): string {
    return `Ring face options: ${faces.map((face) => face.name).join(", ")}.`;
}

let cached: Buffer | null = null;

/**
 * Rasterised once for the life of the process. The picker is the same image for
 * every member who has never chosen, and it is shown on somebody's very first
 * command, which is the worst possible moment to spend 15ms drawing it.
 */
export function renderFacePicker(): Buffer {
    if (cached) return cached;
    const resvg = new Resvg(facePickerSvg(), {
        fitTo: { mode: "width", value: (PAD * 2 + FACES.length * CELL) * 2 },
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    cached = Buffer.from(resvg.render().asPng());
    return cached;
}
