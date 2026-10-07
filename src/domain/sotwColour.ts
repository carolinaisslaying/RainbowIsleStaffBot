import type { SotwColour } from "../db/types.js";
import { HOLOGRAPHIC, hexOf } from "../render/sotwPalette.js";

/**
 * A member's Staff of the Week colour, as a code they can paste and as what the
 * role is given.
 *
 * The code is versioned so the picker page can change its format without
 * every code already pasted into a notes app turning into nonsense. A test
 * runs the page's own generator against this parser, so the two cannot drift.
 */

export const SOTW_CODE_VERSION = "SOTW1";

export type ParsedCode = { ok: true; colour: SotwColour } | { ok: false; error: string };

const NOT_A_COLOUR =
    "That is not a colour code. Paste the code the colour picker gave you, or a hex colour " +
    "such as #FF66AA.";

function readHex(raw: string, allowShort: boolean): number | null {
    const bare = raw.replace(/^#/, "");
    if (/^[0-9a-f]{6}$/.test(bare)) return Number.parseInt(bare, 16);
    if (allowShort && /^[0-9a-f]{3}$/.test(bare)) {
        return Number.parseInt(
            bare
                .split("")
                .map((digit) => digit + digit)
                .join(""),
            16
        );
    }
    return null;
}

export function parseColourCode(raw: string): ParsedCode {
    const value = raw.trim().toLowerCase();
    if (!value) return { ok: false, error: NOT_A_COLOUR };

    const prefix = `${SOTW_CODE_VERSION.toLowerCase()}-`;
    if (value.startsWith(prefix)) {
        const [style, ...stops] = value.slice(prefix.length).split("-");
        if (style === "s" && stops.length === 1) {
            const primary = readHex(stops[0], false);
            if (primary !== null) return { ok: true, colour: { style: "solid", primary } };
        }
        if (style === "g" && stops.length === 2) {
            const primary = readHex(stops[0], false);
            const secondary = readHex(stops[1], false);
            if (primary !== null && secondary !== null) {
                return { ok: true, colour: { style: "gradient", primary, secondary } };
            }
        }
        if (style === "h" && stops.length === 0) {
            return { ok: true, colour: { style: "holographic" } };
        }
        return { ok: false, error: NOT_A_COLOUR };
    }

    if (/^sotw\d+-/.test(value)) {
        return {
            ok: false,
            error:
                "That code came from a newer colour picker than this bot understands yet. " +
                "Paste the hex colour instead, such as #FF66AA."
        };
    }

    const primary = readHex(value, true);
    if (primary === null) return { ok: false, error: NOT_A_COLOUR };
    return { ok: true, colour: { style: "solid", primary } };
}

const bare = (value: number) => hexOf(value).slice(1);

export function formatColourCode(colour: SotwColour): string {
    switch (colour.style) {
        case "solid":
            return `${SOTW_CODE_VERSION}-S-${bare(colour.primary)}`;
        case "gradient":
            return `${SOTW_CODE_VERSION}-G-${bare(colour.primary)}-${bare(colour.secondary)}`;
        case "holographic":
            return `${SOTW_CODE_VERSION}-H`;
    }
}

export interface RoleColourWrite {
    primaryColor: number;
    secondaryColor: number | null;
    tertiaryColor: number | null;
}

/** Discord reads a primary colour of zero as "no colour", so black is nudged to one. */
const visible = (value: number) => (value === 0 ? 1 : value);

/**
 * The one function every role write goes through: the handoff, a rest-of-week
 * grant, a Save while holding, and the boot re-assert. The preference is never
 * rewritten; a server without enhanced role colours gets the nearest thing it
 * can show, and `downgraded` lets the card say so.
 */
export function roleColoursFor(
    pref: SotwColour | null | undefined,
    guildHasEnhanced: boolean
): { colours: RoleColourWrite; downgraded: boolean } {
    if (!pref) {
        return {
            colours: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
            downgraded: false
        };
    }
    switch (pref.style) {
        case "solid":
            return {
                colours: { primaryColor: visible(pref.primary), secondaryColor: null, tertiaryColor: null },
                downgraded: false
            };
        case "gradient":
            return guildHasEnhanced
                ? {
                      colours: {
                          primaryColor: visible(pref.primary),
                          secondaryColor: visible(pref.secondary),
                          tertiaryColor: null
                      },
                      downgraded: false
                  }
                : {
                      colours: { primaryColor: visible(pref.primary), secondaryColor: null, tertiaryColor: null },
                      downgraded: true
                  };
        case "holographic":
            return guildHasEnhanced
                ? {
                      colours: {
                          primaryColor: HOLOGRAPHIC.primary,
                          secondaryColor: HOLOGRAPHIC.secondary,
                          tertiaryColor: HOLOGRAPHIC.tertiary
                      },
                      downgraded: false
                  }
                : {
                      colours: { primaryColor: HOLOGRAPHIC.primary, secondaryColor: null, tertiaryColor: null },
                      downgraded: true
                  };
    }
}

/** What a member is told when the server cannot show their choice in full. */
export function downgradeNote(pref: SotwColour): string | null {
    if (pref.style === "gradient") {
        return (
            "This server cannot show gradient roles yet, so the role uses your first colour."
        );
    }
    if (pref.style === "holographic") {
        return (
            "This server cannot show holographic roles yet, so the role uses a single colour."
        );
    }
    return null;
}

export function describeColour(pref: SotwColour | null | undefined): string {
    if (!pref) return "No colour";
    switch (pref.style) {
        case "solid":
            return `Solid ${hexOf(pref.primary)}`;
        case "gradient":
            return `Gradient ${hexOf(pref.primary)} to ${hexOf(pref.secondary)}`;
        case "holographic":
            return "Holographic";
    }
}

export interface IconRole {
    id: string;
    position: number;
    icon: string | null;
    unicodeEmoji: string | null;
}

/** Discord's own rule: a name shows the icon of the highest role that has one. */
export function highestIconRole<T extends IconRole>(roles: T[]): T | null {
    return (
        roles
            .filter((role) => role.icon || role.unicodeEmoji)
            .sort((left, right) => right.position - left.position)[0] ?? null
    );
}

/** Twemoji's file name: code points in hex, a lone U+FE0F dropped unless joined by ZWJ. */
export function twemojiCodepoints(emoji: string): string {
    const points = [...emoji].map((char) => char.codePointAt(0) as number);
    const joined = points.includes(0x200d);
    return points
        .filter((point) => joined || point !== 0xfe0f)
        .map((point) => point.toString(16))
        .join("-");
}

/**
 * Always the latest release, never a pinned one, so a newly added emoji
 * renders as soon as Twemoji draws it. jsDelivr resolves `@latest` itself.
 */
export function twemojiUrl(emoji: string): string {
    return (
        "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/" +
        `${twemojiCodepoints(emoji)}.png`
    );
}
