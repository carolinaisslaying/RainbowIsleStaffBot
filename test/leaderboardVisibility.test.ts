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
        expect(seen.note).toContain("Every Moderator is listed");
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
        expect(seen.note).toContain("2 Moderators");
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
        expect(seen.note).toContain("3 Moderators");
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

    /**
     * The card used to contradict itself in the space of two sentences: the
     * public branch claimed nobody was hidden while the caller stapled on a
     * count of the people it had just left out. The claim and the count are one
     * decision, so they are made in one place.
     */
    it("does not claim nobody is hidden when somebody is", () => {
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: false,
            hiddenCount: 1
        });
        expect(seen.ephemeral).toBe(false);
        expect(seen.note).toContain("Everyone in this channel");
        expect(seen.note).not.toContain("Every Moderator is listed");
        expect(seen.note).toContain("One Moderator");
        expect(seen.note).toContain("minutes still count");
    });

    it("counts the omitted in plain words rather than in a parenthesis", () => {
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: false,
            hiddenCount: 4
        });
        expect(seen.note).toContain("4 Moderators");
        expect(seen.note).toContain("are not listed");
    });

    it("tells a hidden member that others are missing from their copy too", () => {
        // Their own row is why the card went private. It is not the only row
        // the roster is short of, and the earlier wording never said so.
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: true,
            hiddenCount: 3
        });
        expect(seen.note).toContain("you have hidden yourself");
        expect(seen.note).toContain("2 Moderators");
    });

    it("says nothing about others when the hidden member is the only one", () => {
        const seen = leaderboardVisibility({
            privileged: false,
            viewerHidden: true,
            hiddenCount: 1
        });
        expect(seen.note).toContain("you have hidden yourself");
        expect(seen.note).not.toMatch(/Moderators/);
    });

    it("never writes member(s), which reads as a placeholder", () => {
        for (const privileged of [true, false]) {
            for (const viewerHidden of [true, false]) {
                for (const hiddenCount of [0, 1, 2, 5]) {
                    const seen = leaderboardVisibility({
                        privileged,
                        viewerHidden,
                        hiddenCount
                    });
                    expect(seen.note).not.toContain("(s)");
                }
            }
        }
    });

    it("never both denies and reports a hidden roster on the same card", () => {
        // The two sentences that used to be concatenated.
        for (const privileged of [true, false]) {
            for (const viewerHidden of [true, false]) {
                for (const hiddenCount of [0, 1, 2, 5]) {
                    const seen = leaderboardVisibility({
                        privileged,
                        viewerHidden,
                        hiddenCount
                    });
                    const denies = seen.note.includes("Every Moderator is listed");
                    const reports = /not listed|hidden themselves|hidden yourself/.test(
                        seen.note
                    );
                    expect(denies && reports).toBe(false);
                }
            }
        }
    });
});
