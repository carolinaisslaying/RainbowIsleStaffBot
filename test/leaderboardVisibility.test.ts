import { describe, expect, it } from "vitest";
import { leaderboardVisibility } from "../src/domain/leaderboard.js";

/**
 * The rule that decides whether a leaderboard is posted in the channel or sent
 * where only the person who asked can read it. Pure, so the leak cases can be
 * enumerated without a Discord fixture.
 */
describe("where a leaderboard may be posted", () => {
    it("posts in the channel when nobody is hidden", () => {
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: false,
            hiddenCount: 0
        });
        expect(seen.ephemeral).toBe(false);
        expect(seen.note).toContain("Everyone in this channel");
    });

    it("still posts in the channel for a Lead when nobody is hidden", () => {
        // A privileged copy is only privileged if it actually contains
        // something extra. With an empty hidden list it is the same card
        // everyone else gets, and standings belong in the channel.
        expect(
            leaderboardVisibility({ privileged: true, viewerHidden: false, hiddenCount: 0 })
                .ephemeral
        ).toBe(false);
    });

    it("goes private for a Lead as soon as anyone is hidden", () => {
        const seen = leaderboardVisibility({
            privileged: true,
            viewerHidden: false,
            hiddenCount: 2
        });
        expect(seen.ephemeral).toBe(true);
        expect(seen.note).toContain("Only you can see this");
        expect(seen.note).toContain("2 member(s)");
    });

    it("goes private for a member who hid themselves", () => {
        // Their own row is on their own copy. Posting it publicly is exactly
        // what the setting exists to prevent.
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: true,
            hiddenCount: 1
        });
        expect(seen.ephemeral).toBe(true);
        expect(seen.note).toContain("you have hidden yourself");
    });

    it("names both reasons for a hidden Executive", () => {
        const seen = leaderboardVisibility({
            privileged: true,
            viewerHidden: true,
            hiddenCount: 3
        });
        expect(seen.ephemeral).toBe(true);
        expect(seen.note).toContain("3 member(s)");
        expect(seen.note).toContain("your own row");
    });

    it("always says which way it went, so nobody has to remember the rule", () => {
        // The rule changes with the roster, so the card carries it rather than
        // the reader. Every branch says who can see the card.
        for (const privileged of [true, false]) {
            for (const viewerHidden of [true, false]) {
                for (const hiddenCount of [0, 1, 5]) {
                    const seen = leaderboardVisibility({
                        privileged,
                        viewerHidden,
                        hiddenCount
                    });
                    expect(seen.note).toMatch(/Only you can see this|Everyone in this channel/);
                }
            }
        }
    });

    it("warns against screenshotting only the copies that carry other people's rows", () => {
        // A member's own hidden row is theirs to share if they want to. Someone
        // else's is not.
        expect(
            leaderboardVisibility({ privileged: true, viewerHidden: false, hiddenCount: 1 }).note
        ).toContain("screenshot");
        expect(
            leaderboardVisibility({ privileged: false, viewerHidden: true, hiddenCount: 1 }).note
        ).not.toContain("screenshot");
    });
});
