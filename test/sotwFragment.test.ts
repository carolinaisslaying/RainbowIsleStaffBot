import { describe, expect, it } from "vitest";
import {
    URL_LIMIT,
    pickerFragment,
    pickerUrl,
    readFragment,
    type PickerFragmentInput
} from "../src/domain/sotwFragment.js";

const input = (overrides: Partial<PickerFragmentInput> = {}): PickerFragmentInput => ({
    nickname: "Robin",
    userId: "123456789012345678",
    guildId: "223456789012345678",
    avatarHash: "a_0123456789abcdef0123456789abcdef",
    guildAvatar: true,
    roleId: "323456789012345678",
    iconHash: "0123456789abcdef0123456789abcdef",
    emoji: null,
    colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff },
    enhanced: true,
    ...overrides
});

describe("the picker link", () => {
    it("round-trips everything the page needs", () => {
        expect(readFragment(pickerFragment(input()))).toEqual(input());
    });

    it("round-trips a nickname with emoji and symbols", () => {
        const odd = input({ nickname: `Ro<b>&"bin 🌈🏳️‍🌈`, roleId: null, iconHash: null, emoji: "🌈" });
        expect(readFragment(pickerFragment(odd))).toEqual(odd);
    });

    it("carries no colour and no avatar when there are none", () => {
        const bare = input({ avatarHash: null, guildAvatar: false, roleId: null, iconHash: null, colour: null });
        expect(readFragment(pickerFragment(bare))).toEqual(bare);
    });

    it("replaces any fragment already on the configured address", () => {
        const url = pickerUrl("https://colour.example.nz/pick#stale", input());
        expect(url.startsWith("https://colour.example.nz/pick#v=1&")).toBe(true);
        expect(url).not.toContain("stale");
    });

    it("keeps the link within Discord's limit by shortening the nickname, never the ids", () => {
        const long = input({ nickname: "🌈".repeat(32) + "ǅ".repeat(32) });
        const url = pickerUrl("https://colour.example.nz/a/rather/long/path/to/the/picker/page", long);
        expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
        const read = readFragment(url.split("#")[1]);
        expect(read?.userId).toBe(long.userId);
        expect(read?.iconHash).toBe(long.iconHash);
        expect(long.nickname.startsWith(read?.nickname ?? "x")).toBe(true);
    });

    it("refuses a fragment of an unknown version", () => {
        expect(readFragment("v=9&n=x")).toBeNull();
    });
});
