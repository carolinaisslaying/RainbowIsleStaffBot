/** Small SVG geometry helpers shared by the ring and heatmap renderers. */

export interface Point {
    x: number;
    y: number;
}

/** Angle 0 is 12 o'clock, sweeping clockwise, matching the Watch. */
export function polarToCartesian(
    centreX: number,
    centreY: number,
    radius: number,
    angleDegrees: number
): Point {
    const radians = ((angleDegrees - 90) * Math.PI) / 180;
    return {
        x: centreX + radius * Math.cos(radians),
        y: centreY + radius * Math.sin(radians)
    };
}

/**
 * Arc path from `startAngle` sweeping `sweepDegrees` clockwise.
 * Sweeps of 360 degrees or more must be drawn as a circle, not an arc: an SVG
 * arc whose start and end coincide renders as nothing.
 */
export function arcPath(
    centreX: number,
    centreY: number,
    radius: number,
    startAngle: number,
    sweepDegrees: number
): string {
    const sweep = Math.min(sweepDegrees, 359.999);
    const start = polarToCartesian(centreX, centreY, radius, startAngle);
    const end = polarToCartesian(centreX, centreY, radius, startAngle + sweep);
    const largeArc = sweep > 180 ? 1 : 0;
    return [
        `M ${round(start.x)} ${round(start.y)}`,
        `A ${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)}`
    ].join(" ");
}

/**
 * Half a round cap, measured as an angle at this radius.
 *
 * A round cap is a semicircle of radius `strokeWidth / 2` stuck on each end of
 * the path, so a path drawn from 0 to the true angle overhangs it by that much.
 * Everything about compensating for the caps is this one number.
 */
export function capAngle(radius: number, strokeWidth: number): number {
    if (radius <= 0) return 0;
    return ((strokeWidth / 2) / radius) * (180 / Math.PI);
}

/**
 * An arc that *ends* on the angle it is given, drawn with round caps.
 *
 * The Watch's rings have round ends, and this codebase has always insisted the
 * drawing agree with the figure printed beside it. Those two are only in
 * conflict if the path is drawn naively: pull each end in by half a cap and the
 * cap's centre lands on the true angle, so the ring both looks right and stops
 * where it says it stops.
 *
 * Below two caps' width there is no arc left to draw, only the caps themselves.
 * A dot is drawn at the midpoint instead, which is what a Watch ring does at
 * one percent, rather than nothing or a blob overhanging its own figure.
 */
export function cappedArcPath(
    centreX: number,
    centreY: number,
    radius: number,
    startAngle: number,
    sweepDegrees: number,
    strokeWidth: number
): string {
    const half = capAngle(radius, strokeWidth);
    const sweep = Math.min(sweepDegrees, 359.999);

    if (sweep <= half * 2) {
        const midpoint = polarToCartesian(centreX, centreY, radius, startAngle + sweep / 2);
        return `M ${round(midpoint.x)} ${round(midpoint.y)} L ${round(midpoint.x)} ${round(midpoint.y)}`;
    }

    return arcPath(centreX, centreY, radius, startAngle + half, sweep - half * 2);
}

export function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Escape text destined for an SVG text node. */
export function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
