import { beforeEach, describe, expect, it } from "vitest";
import {
    GLOBAL_SCOPE,
    cmd,
    isMentionablePath,
    recordCommandIds,
    resetCommandMentions,
    setDefaultMentionGuild
} from "../src/discord/commandMentions.js";

/**
 * A mention that Discord cannot parse does not fail: it renders as raw text on
 * a card somebody was meant to click. `</dev purge fortnight:1:1544…>` reached a
 * live card that way, because the option value was pasted into the path and the
 * second colon broke the syntax.
 */

const STAFF = "111111111111111111";
const OTHER = "222222222222222222";

beforeEach(() => {
    resetCommandMentions();
});

describe("which paths can be mentioned at all", () => {
    it("accepts a bare command", () => {
        expect(isMentionablePath("rings")).toBe(true);
    });

    it("accepts a subcommand, and a group with one", () => {
        expect(isMentionablePath("timezone set")).toBe(true);
        expect(isMentionablePath("config set key")).toBe(true);
    });

    it("refuses a path carrying an option value", () => {
        // The one that shipped. The colon before the id is the syntax, so a
        // second colon leaves Discord parsing neither.
        expect(isMentionablePath("dev purge fortnight:1")).toBe(false);
    });

    it("refuses anything deeper than Discord's three levels", () => {
        expect(isMentionablePath("a b c d")).toBe(false);
    });

    it("refuses an empty path", () => {
        expect(isMentionablePath("")).toBe(false);
        expect(isMentionablePath("   ")).toBe(false);
    });

    it("refuses characters a command name cannot hold", () => {
        expect(isMentionablePath("dev purge!")).toBe(false);
        expect(isMentionablePath("dev/purge")).toBe(false);
        expect(isMentionablePath("dev <purge>")).toBe(false);
    });

    it("accepts the hyphens and underscores Discord allows", () => {
        expect(isMentionablePath("count-recompute")).toBe(true);
        expect(isMentionablePath("some_command")).toBe(true);
    });

    it("refuses a segment longer than a command name may be", () => {
        expect(isMentionablePath("a".repeat(32))).toBe(true);
        expect(isMentionablePath("a".repeat(33))).toBe(false);
    });
});

describe("rendering a mention", () => {
    it("builds a chip against the guild the card will be read in", () => {
        recordCommandIds(STAFF, [{ id: "999", name: "dev" }]);
        expect(cmd("dev purge", STAFF)).toBe("</dev purge:999>");
    });

    it("uses the ROOT command's id, not the subcommand's", () => {
        recordCommandIds(STAFF, [{ id: "999", name: "config" }]);
        expect(cmd("config set key", STAFF)).toBe("</config set key:999>");
    });

    it("falls back to bold when the id is unknown for that guild", () => {
        recordCommandIds(STAFF, [{ id: "999", name: "dev" }]);
        // Guild commands get a different id per guild, and a mention carrying
        // the wrong one renders as raw text — worse than plain bold.
        expect(cmd("dev purge", OTHER)).toBe("**/dev purge**");
    });

    it("never builds a chip from a path carrying an argument", () => {
        recordCommandIds(STAFF, [{ id: "999", name: "dev" }]);
        const rendered = cmd("dev purge fortnight:1", STAFF);
        expect(rendered).not.toContain("</");
        expect(rendered).toBe("**/dev purge fortnight:1**");
    });

    it("resolves against the global registration in a DM", () => {
        recordCommandIds(GLOBAL_SCOPE, [{ id: "777", name: "rings" }]);
        expect(cmd("rings")).toBe("</rings:777>");
        expect(cmd("rings", null)).toBe("</rings:777>");
    });

    it("falls back to the staff guild when nothing else resolves", () => {
        recordCommandIds(STAFF, [{ id: "555", name: "leave" }]);
        setDefaultMentionGuild(STAFF);
        expect(cmd("leave end")).toBe("</leave end:555>");
    });

    it("tolerates surrounding whitespace", () => {
        recordCommandIds(STAFF, [{ id: "999", name: "dev" }]);
        expect(cmd("  dev purge  ", STAFF)).toBe("</dev purge:999>");
    });
});
