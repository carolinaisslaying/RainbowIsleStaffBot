import { existsSync } from "node:fs";
import { log } from "../log.js";

/**
 * Font loading for the rasteriser.
 *
 * resvg builds a font database every time a `Resvg` is constructed, and by
 * default that means scanning every font the operating system has. Measured on
 * the runtime image that is around 125ms per image, against roughly 2ms for all
 * the drawing put together: rendering a forty row leaderboard spent seven
 * seconds reading font files and a tenth of a second drawing rings.
 *
 * Pointing it at the two directories that actually hold the two fonts these
 * images name takes the same render to under 3ms. The fallback matters as much
 * as the speed: if none of the candidate directories exist, system scanning is
 * restored rather than leaving a deployment rendering text as nothing.
 */

/**
 * Candidates in tiers, most specific first. The first tier with anything on
 * disk wins, so the container uses the directories it installed and a
 * developer's machine falls back to somewhere its own fonts actually live.
 *
 * Debian ships Inter as OTF, under `opentype/inter`, and only DejaVu under
 * `truetype`. Naming just the truetype pair here was a silent failure and not
 * an obvious one: `truetype/dejavu` exists, so the tier matched on that alone,
 * Inter was never in the font database, and every card rendered in the fallback
 * face while `defaultFontFamily` still said "Inter". The Dockerfile asserts
 * these paths at build time so the next packaging change fails the build rather
 * than quietly changing how every image looks.
 */
const TIERS: string[][] = [
    [
        "/usr/share/fonts/opentype/inter",
        "/usr/share/fonts/truetype/inter",
        "/usr/share/fonts/truetype/dejavu"
    ],
    ["/usr/share/fonts/opentype", "/usr/share/fonts/truetype"],
    ["/usr/share/fonts"],
    ["/System/Library/Fonts/Supplemental", "/System/Library/Fonts"],
    ["/Library/Fonts"]
];

export interface FontOptions {
    loadSystemFonts: boolean;
    fontDirs?: string[];
    defaultFontFamily?: string;
}

function resolve(): FontOptions {
    for (const tier of TIERS) {
        const present = tier.filter((directory) => existsSync(directory));
        if (present.length === 0) continue;

        // Said out loud at startup, because the way this breaks is that it
        // keeps working: a missing directory costs a typeface, not an error,
        // and the images stay perfectly legible in the wrong face.
        log.info(`Fonts loaded from ${present.join(", ")}`);
        return {
            loadSystemFonts: false,
            fontDirs: present,
            defaultFontFamily: "Inter"
        };
    }

    log.warn(
        "No known font directory found; falling back to a full system font scan. " +
            "Images will render correctly but each one costs about 125ms more."
    );
    return { loadSystemFonts: true };
}

/** Resolved once. The directories do not appear or vanish while the bot runs. */
export const FONT_OPTIONS: FontOptions = resolve();
