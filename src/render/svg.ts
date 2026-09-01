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
