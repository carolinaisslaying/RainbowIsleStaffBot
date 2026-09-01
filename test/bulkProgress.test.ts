import { describe, expect, it } from "vitest";
import { reviewBulkProgressCard } from "../src/render/cards.js";

const json = (input: Parameters<typeof reviewBulkProgressCard>[0]) =>
    JSON.stringify(reviewBulkProgressCard(input).components[0]);

/**
 * The card a bulk run edits while it works.
 *
 * A queue of twelve is twelve records, twelve messages and twelve card edits.
 * A reply that says nothing for that long reads as one that has died, which is
 * what this exists to stop.
 */
describe("the bulk progress card", () => {
    const running = {
        outcome: "warned",
        done: 3,
        skipped: 1,
        total: 10,
        finished: false
    };

    it("shows how far through it is while running", () => {
        const card = json(running);
        expect(card).toContain("Working through 10");
        expect(card).toContain("**4** done");
    });

    it("draws a bar that reflects the progress", () => {
        expect(json({ ...running, done: 0, skipped: 0 })).toContain("▱▱▱▱▱▱▱▱▱▱▱▱");
        expect(json({ ...running, done: 10, skipped: 0 })).toContain("▰▰▰▰▰▰▰▰▰▰▰▰");
    });

    it("does not list names while running, since the list only churns", () => {
        expect(json({ ...running, doneNames: ["<@1>", "<@2>"] })).not.toContain("<@1>");
    });

    it("names everyone once it is finished", () => {
        const card = json({
            ...running,
            finished: true,
            doneNames: ["<@1>", "<@2>"],
            reason: "Quiet fortnight."
        });
        expect(card).toContain("<@1>");
        expect(card).toContain("Quiet fortnight.");
    });

    it("explains a skip rather than silently dropping it", () => {
        expect(
            json({ ...running, finished: true, skippedNames: ["<@9>"] })
        ).toContain("cannot warn yourself");
    });

    it("says when somebody else decided rows mid-run", () => {
        // The confirmation named a set and a modal can sit open. Acting on the
        // current set is right; letting the reader think otherwise is not.
        expect(json({ ...running, finished: true, movedOn: 2 })).toContain(
            "decided by somebody else"
        );
    });

    it("says nothing about drift when there was none", () => {
        expect(json({ ...running, finished: true, movedOn: 0 })).not.toContain(
            "somebody else"
        );
    });

    it("uses singular grammar for one row", () => {
        const card = json({ ...running, done: 1, skipped: 0, total: 1, finished: true });
        expect(card).toContain("1 row warned");
        expect(card).not.toContain("1 rows");
    });
});
