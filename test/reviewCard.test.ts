import { describe, expect, it } from "vitest";
import { reviewRowCard, reviewHeaderCard, reviewRowMessage } from "../src/render/cards.js";
import { COLOUR } from "../src/render/theme.js";
import type { ReviewAction } from "../src/domain/review.js";

/**
 * The row card is the queue and the log at two points in one life, so what it
 * draws in each state is the whole mechanic. It also has to be its own message:
 * batching every row into one is what made deciding one member disable the
 * buttons on all of them.
 */

const base = {
    assessmentId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Robin (<@123>)",
    week1Minutes: 0,
    week2Minutes: 0,
    totalMinutes: 0,
    requiredMinutes: 240,
    priorOutcomes: "No earlier fortnight has been reviewed.",
    warningWeight: "No warnings currently count against them.",
    buttons: ["warn", "excuse", "dismiss"] as ReviewAction[],
    outcome: null,
    decidedLine: null,
    reason: null,
    acknowledgedLine: null,
    departed: false,
    rehearsal: false,
    contradiction: null
};

const json = (extra: Record<string, unknown> = {}) =>
    JSON.stringify(reviewRowCard({ ...base, ...extra }));

const ids = (extra: Record<string, unknown> = {}) =>
    [...json(extra).matchAll(/"custom_id":"([^"]+)"/g)].map((match) => match[1]);

const accent = (extra: Record<string, unknown> = {}) =>
    (reviewRowCard({ ...base, ...extra }) as unknown as {
        data: { accent_color?: number };
    }).data.accent_color;

describe("one row, one message", () => {
    it("is a message of exactly one container", () => {
        // Deciding a row edits its own message. That is only true while a
        // message holds one row: the old batched card could only show a
        // decision by disabling every button in it.
        expect(reviewRowMessage(base).components).toHaveLength(1);
    });

    it("carries only its own assessment's buttons", () => {
        for (const id of ids()) {
            expect(id.startsWith(`review:${base.assessmentId}:`)).toBe(true);
        }
    });
});

describe("what each state draws", () => {
    it("offers the three outcomes while undecided", () => {
        expect(ids()).toEqual([
            `review:${base.assessmentId}:warn`,
            `review:${base.assessmentId}:excuse`,
            `review:${base.assessmentId}:dismiss`
        ]);
        expect(accent()).toBe(COLOUR.adverse);
    });

    it("offers only reopen once decided, and keeps the reason on the card", () => {
        const decided = {
            buttons: ["reopen"] as ReviewAction[],
            outcome: "warned" as const,
            decidedLine: "Warned by <@9>, just now",
            reason: "Third fortnight running."
        };
        expect(ids(decided)).toEqual([`review:${base.assessmentId}:reopen`]);
        expect(json(decided)).toContain("Third fortnight running.");
        expect(accent(decided)).toBe(COLOUR.pending);
    });

    it("colours an excusal green and a dismissal grey", () => {
        expect(accent({ outcome: "excused", decidedLine: "x", buttons: ["reopen"] })).toBe(
            COLOUR.approved
        );
        expect(accent({ outcome: "dismissed", decidedLine: "x", buttons: ["reopen"] })).toBe(
            COLOUR.settled
        );
    });

    it("says somebody has left, and does not offer to warn them", () => {
        const gone = { departed: true, buttons: ["excuse", "dismiss"] as ReviewAction[] };
        expect(json(gone)).toContain("No longer in the server");
        expect(ids(gone)).not.toContain(`review:${base.assessmentId}:warn`);
    });

    it("shows what the next warning would be, before it is issued", () => {
        expect(json({ warningWeight: "2 warnings currently count. This would be their 3rd." }))
            .toContain("their 3rd");
    });

    it("hides the weight once decided, when it is no longer a question", () => {
        expect(
            json({ outcome: "warned", decidedLine: "x", buttons: ["reopen"] })
        ).not.toContain("currently count");
    });

    it("says a rehearsal recorded nothing", () => {
        expect(
            json({ rehearsal: true, outcome: "warned", decidedLine: "x", buttons: ["reopen"] })
        ).toContain("Rehearsal");
    });

    it("flags a decision the figures no longer support", () => {
        expect(json({ contradiction: "⚠️ A recompute has since put them above." })).toContain(
            "recompute"
        );
    });

    it("never prints a raw fortnight index at the reader", () => {
        // "F-3 0m below" was the old line. It asks the reader to know what a
        // fortnight index is and that a negative one is possible.
        expect(json({ priorOutcomes: "3 Aug: warned · 20 Jul: met" })).not.toMatch(/F-?\d+ \d+m/);
    });
});

describe("the header", () => {
    const header = (remaining: number, rehearsal = false) =>
        JSON.stringify(
            reviewHeaderCard({
                fortnightIndex: 4,
                windowLabel: "12 Oct to 25 Oct",
                headline: `2 members are below. ${remaining} still to decide.`,
                remaining,
                rehearsal
            }).components[0]
        );

    it("offers the bulk action only while something is left", () => {
        expect(header(2)).toContain("reviewBulk:4:ask");
        expect(header(0)).not.toContain("reviewBulk");
    });

    it("names the count on the bulk button, so it is never a blind click", () => {
        expect(header(3)).toContain("Decide all 3 remaining");
    });

    it("says a rehearsal only messages Executives", () => {
        expect(header(2, true)).toContain("only Executives are messaged");
    });
});
