import type { SotwColour } from "../db/types.js";
import { formatColourCode, parseColourCode } from "./sotwColour.js";

/**
 * The link to the colour picker page.
 *
 * Everything personal rides in the fragment, which a browser never sends to
 * the host: the page reads it locally and draws the member's own name, badge
 * and avatar. Ids and hashes rather than URLs, so it fits Discord's
 * 512-character limit on a link button. The page reads the same keys; a test
 * holds the two together.
 */

export const URL_LIMIT = 512;
const VERSION = "1";

export interface PickerFragmentInput {
    /** Public-guild nickname: the name the colour will actually be seen on. */
    nickname: string;
    userId: string;
    guildId: string;
    avatarHash: string | null;
    /** The avatar hash is the member's server avatar rather than their global one. */
    guildAvatar: boolean;
    /** The highest role with an uploaded icon, if that is the badge. */
    roleId: string | null;
    iconHash: string | null;
    /** A unicode emoji badge, if that is the badge instead. */
    emoji: string | null;
    colour: SotwColour | null;
    /** The server supports gradient and holographic roles. */
    enhanced: boolean;
}

export function pickerFragment(input: PickerFragmentInput): string {
    const params = new URLSearchParams();
    params.set("v", VERSION);
    params.set("n", input.nickname);
    params.set("u", input.userId);
    params.set("g", input.guildId);
    if (input.avatarHash) {
        params.set("a", input.avatarHash);
        if (input.guildAvatar) params.set("ga", "1");
    }
    if (input.roleId && input.iconHash) {
        params.set("r", input.roleId);
        params.set("i", input.iconHash);
    } else if (input.emoji) {
        params.set("e", input.emoji);
    }
    if (input.colour) params.set("c", formatColourCode(input.colour));
    params.set("x", input.enhanced ? "1" : "0");
    return params.toString();
}

/** The configured page with a fresh fragment, shortened to fit by trimming the nickname. */
export function pickerUrl(base: string, input: PickerFragmentInput): string {
    const page = base.split("#")[0];
    let nickname = [...input.nickname];
    for (;;) {
        const url = `${page}#${pickerFragment({ ...input, nickname: nickname.join("") })}`;
        if (url.length <= URL_LIMIT || nickname.length === 0) return url;
        nickname = nickname.slice(0, -1);
    }
}

export function readFragment(fragment: string): PickerFragmentInput | null {
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    if (params.get("v") !== VERSION) return null;
    const code = params.get("c");
    const parsed = code ? parseColourCode(code) : null;
    return {
        nickname: params.get("n") ?? "",
        userId: params.get("u") ?? "",
        guildId: params.get("g") ?? "",
        avatarHash: params.get("a"),
        guildAvatar: params.get("ga") === "1",
        roleId: params.get("r"),
        iconHash: params.get("i"),
        emoji: params.get("e"),
        colour: parsed?.ok ? parsed.colour : null,
        enhanced: params.get("x") === "1"
    };
}
