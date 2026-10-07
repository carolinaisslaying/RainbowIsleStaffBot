import { describe, expect, it } from "vitest";
import { quote } from "../src/render/cards.js";

/**
 * Discord ends a blockquote at the first line without `> `, so a reason typed
 * in paragraphs used to have only its first line quoted and the rest read as
 * the card's own words.
 */
describe("quote", () => {
    it("quotes every line of a reason typed in paragraphs", () => {
        expect(quote("First.\n\nSecond.\nThird.")).toBe("> First.\n> \n> Second.\n> Third.");
    });

    it("handles CRLF and trims surrounding blank lines", () => {
        expect(quote("\r\nOne\r\nTwo\r\n\n")).toBe("> One\n> Two");
    });

    it("leaves a one-line reason as it was", () => {
        expect(quote("Late again")).toBe("> Late again");
    });
});
