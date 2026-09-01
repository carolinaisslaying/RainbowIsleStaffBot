import { round } from "./svg.js";
import { SURFACE } from "./theme.js";

/**
 * The glass panel every rendered image sits on.
 *
 * Apple's material is a property of the container, not of the contents: the
 * rings on a Watch face are flat and vivid, and what is made of glass is the
 * surface underneath them. So all of the glass in this codebase lives here,
 * once, and both the ring card and the heatmap draw the same panel.
 *
 * Three layers and no more. A near black ground with a barely there lift
 * towards the top; a specular sheet over the upper third, which is the single
 * thing that makes a flat rectangle read as a lit pane; and a rim that is
 * brighter along the top edge than the bottom, because a pane of glass catches
 * the light where it turns away from you. `feGaussianBlur` is not used, here or
 * anywhere: it cost 20ms of a 27ms render, and flat fills and gradients get to
 * the same place.
 */

export const PANEL_RADIUS = 18;

/** Gradient and clip definitions. Goes inside the document's own `<defs>`. */
export function panelDefs(width: number, height: number): string {
    return `
    <linearGradient id="panelGround" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${SURFACE.panelTop}" />
        <stop offset="1" stop-color="${SURFACE.panelBottom}" />
    </linearGradient>
    <linearGradient id="panelSheen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="${SURFACE.sheen}" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="panelRim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="${SURFACE.rimTop}" />
        <stop offset="0.55" stop-color="#ffffff" stop-opacity="${SURFACE.rimBottom}" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="${SURFACE.rimBottom}" />
    </linearGradient>
    <clipPath id="panelClip">
        <rect width="${width}" height="${height}" rx="${PANEL_RADIUS}" />
    </clipPath>`;
}

/**
 * The ground, whatever light the caller wants thrown onto it, and the sheen.
 *
 * `lighting` is drawn between the ground and the sheen so a coloured wash reads
 * as something behind the glass rather than painted on top of it. Everything is
 * clipped to the panel's own corners.
 */
export function panelGround(width: number, height: number, lighting = ""): string {
    return `<g clip-path="url(#panelClip)">
        <rect width="${width}" height="${height}" fill="url(#panelGround)" />
        ${lighting}
        <rect width="${width}" height="${round(height * 0.46)}" fill="url(#panelSheen)" />
    </g>`;
}

/** The rim. Drawn last, over everything, inset half a pixel so it stays crisp. */
export function panelRim(width: number, height: number): string {
    return (
        `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" ` +
        `rx="${PANEL_RADIUS - 0.5}" fill="none" stroke="url(#panelRim)" stroke-width="1" />`
    );
}
