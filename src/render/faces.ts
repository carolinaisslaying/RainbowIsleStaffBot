/**
 * Ring faces: the one thing about these images a member gets to choose.
 *
 * The outer ring is compliance. It is red, amber, green or grey and it is never
 * anything else, because that ring answers "am I meeting the requirement" and a
 * member who could recolour it could hide the answer from themselves. The two
 * inner rings are different: `rings.ts` calls them soft because they carry no
 * compliance meaning at all, and their blue and violet were only ever Apple's
 * choice. Those two are what a face changes, and nothing else does.
 *
 * **Faces are curated, not typed in.** A hex field looks like more freedom and
 * is worse: the track renders at 0.19 alpha on a near-black panel, and most
 * arbitrary colours read there as a fault rather than as a choice. A preset can
 * be looked at once, against sparse data, and then trusted. Four is enough to
 * feel like a choice and few enough that every one of them can be good.
 *
 * **No face may use a hue the outer ring uses.** Nothing green, nothing amber,
 * nothing red: those four states are what the outer ring means, and a shift
 * ring in green would make "on target" and "that is just their shift" the same
 * glance. The safe space is blues, violets, magentas and cyans, and the test
 * suite holds every face to it.
 */

export interface RingColours {
    core: string;
    light: string;
    /** The extra lap, once the ring has gone past its target. */
    overlay: string;
}

export interface RingFace {
    id: string;
    name: string;
    /** One line, shown under the name on the picker. */
    blurb: string;
    /** Middle ring: shift time. */
    shift: string;
    /** Inner ring: active days. */
    days: string;
}

/**
 * Mix a colour towards white.
 *
 * Each ring is one hex in a face definition, and its gradient's light end and
 * its overachievement lap are derived from it. That is not a shortcut: run the
 * original hand-picked blue through this and 0.35 gives #60afff against the
 * #5cb3ff that was chosen by eye, 0.62 gives #a2d0ff against #a5d6ff. Deriving
 * them reproduces what a designer picked to within a couple of values per
 * channel, and it means adding a face is one line that cannot be internally
 * inconsistent.
 */
export function lighten(hex: string, amount: number): string {
    const value = Number.parseInt(hex.slice(1), 16);
    const channel = (shift: number) => {
        const original = (value >> shift) & 0xff;
        return Math.round(original + (255 - original) * amount);
    };
    const mixed = (channel(16) << 16) | (channel(8) << 8) | channel(0);
    return `#${mixed.toString(16).padStart(6, "0")}`;
}

export function ringColours(core: string): RingColours {
    return { core, light: lighten(core, 0.35), overlay: lighten(core, 0.62) };
}

export const FACES: RingFace[] = [
    {
        id: "nightshift",
        name: "Nightshift",
        blurb: "Blue and violet. What the rings have always been.",
        shift: "#0a84ff",
        days: "#bf5af2"
    },
    {
        id: "orchid",
        name: "Orchid",
        blurb: "Violet into magenta. Warm without going anywhere near amber.",
        shift: "#a35bff",
        days: "#ff5fc8"
    },
    {
        id: "tidepool",
        name: "Tidepool",
        blurb: "Cyan and deep indigo. The coolest of the four.",
        shift: "#22c8e6",
        days: "#4f6bf0"
    },
    {
        id: "neon",
        name: "Neon",
        blurb: "Hot pink and electric cyan. Loud on purpose.",
        shift: "#ff2d95",
        days: "#00e0ff"
    }
];

export const DEFAULT_FACE = FACES[0];

/** A stored id, resolved. Unknown or unset falls back rather than failing. */
export function faceFor(id: string | null | undefined): RingFace {
    return FACES.find((face) => face.id === id) ?? DEFAULT_FACE;
}
