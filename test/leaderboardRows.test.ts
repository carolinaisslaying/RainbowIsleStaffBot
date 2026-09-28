import { describe, expect, it } from "vitest";
import { leaderboardRowVisible, logStandings } from "../src/domain/leaderboard.js";

/**
 * Which rows reach which copy of the leaderboard.
 *
 * The case that matters is the last one: a member who has hidden themselves,
 * pressing Next on a leaderboard sitting in a channel. Paging edits the message
 * the buttons are on, so their own row — admitted by identity rather than by
 * rank, and therefore untouched by forcing the reader's tier down to Staff —
 * was rewritten into the public card in front of the room they had hidden from.
 */
const hidden = { optedOut: true, isViewer: false, privileged: false, publicView: false };

describe("whether a leaderboard row is drawn", () => {
    it("draws a member who has not hidden themselves, on every copy", () => {
        for (const privileged of [true, false]) {
            for (const publicView of [true, false]) {
                expect(
                    leaderboardRowVisible({
                        optedOut: false,
                        isViewer: false,
                        privileged,
                        publicView
                    })
                ).toBe(true);
            }
        }
    });

    it("hides an opted-out member from an ordinary reader", () => {
        expect(leaderboardRowVisible(hidden)).toBe(false);
    });

    it("shows an opted-out member to a Lead, whose ranks must be the real ranks", () => {
        expect(leaderboardRowVisible({ ...hidden, privileged: true })).toBe(true);
    });

    it("shows a hidden member their own row on their own copy", () => {
        expect(leaderboardRowVisible({ ...hidden, isViewer: true })).toBe(true);
    });

    it("keeps a hidden member's own row off a card going into a channel", () => {
        // The whole bug: pressing Next published the row the setting exists to
        // withhold, to exactly the people it was withheld from.
        expect(leaderboardRowVisible({ ...hidden, isViewer: true, publicView: true })).toBe(
            false
        );
    });

    it("keeps a hidden row off a public card even when a Lead pressed the button", () => {
        expect(
            leaderboardRowVisible({ ...hidden, privileged: true, publicView: true })
        ).toBe(false);
        expect(
            leaderboardRowVisible({
                ...hidden,
                isViewer: true,
                privileged: true,
                publicView: true
            })
        ).toBe(false);
    });
});

describe("a closed week's standings, as the log posts them", () => {
    const input = (name: string, minutes: number, optedOut = false, onLeave = false) => ({
        member: name,
        minutes,
        onLeave,
        optedOut
    });

    it("lists hidden members in their real place, flagged, and counts them", () => {
        // The log is an Executive record in an Executive-only channel. Leaving
        // hidden members out made its ranks wrong and its roster incomplete.
        const { rows, hiddenCount } = logStandings([
            input("low", 30),
            input("hidden top", 900, true),
            input("high", 300),
            input("hidden low", 5, true),
            input("mid", 120)
        ]);
        expect(hiddenCount).toBe(2);
        expect(rows.map((row) => [row.rank, row.member, row.hidden])).toEqual([
            [1, "hidden top", true],
            [2, "high", false],
            [3, "mid", false],
            [4, "low", false],
            [5, "hidden low", true]
        ]);
    });

    it("keeps members on leave, flagged, in their place by minutes", () => {
        const { rows } = logStandings([input("away", 0, false, true), input("here", 40)]);
        expect(rows.map((row) => [row.member, row.onLeave])).toEqual([
            ["here", false],
            ["away", true]
        ]);
    });
});
