/**
 * Colour primitives shared by the colour rules and the preview renderer.
 *
 * Here rather than in `domain/` because `render/` is a leaf and must not import
 * from it, while the domain may import a leaf.
 */

/** Discord's fixed holographic stops (discord.js `Constants.HolographicStyle`). */
export const HOLOGRAPHIC = {
    primary: 0xa9c9ff,
    secondary: 0xffbbec,
    tertiary: 0xffc3a0
} as const;

/** `#RRGGBB`, upper case, as Discord's own colour menu writes it. */
export function hexOf(value: number): string {
    return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
}
