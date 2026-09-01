import { describe, expect, it } from "vitest";
import { EMOJI, EMOJI_FOR_COLOUR, emojiForColour } from "../src/render/emoji.js";
import { noticeCard, leaveRequestCard } from "../src/render/cards.js";
import { COLOUR } from "../src/render/theme.js";
import type { LeaveStatus } from "../src/db/types.js";

/**
 * The emoji on a card is derived from its accent colour rather than typed at
 * each call site, so the mark and the colour cannot come to disagree. These
 * tests hold that derivation: they are the reason a new colour cannot be added
 * to the palette without somebody deciding what it looks like.
 */

const body = (card: ReturnType<typeof noticeCard>) => JSON.stringify(card.components[0]);

describe("the mark a card leads with", () => {
    it("gives every colour in the palette one", () => {
        // A colour with no emoji renders the neutral bullet, which is a card
        // that silently stops matching the others. Nothing in the palette may
        // fall through to it.
        for (const [role, value] of Object.entries(COLOUR)) {
            expect(emojiForColour(value), `${role} has no emoji`).not.toBe("•");
        }
    });

    it("falls back rather than rendering an undefined", () => {
        expect(emojiForColour(0x123456)).toBe("•");
    });

    it("leads the title, not the body", () => {
        const card = noticeCard("Leave approved", "Nothing else.", { colour: COLOUR.approved });
        expect(body(card)).toContain("### ✅ Leave approved");
    });

    it("marks an approval with a checkmark and a refusal with a cross", () => {
        expect(body(noticeCard("Leave approved", ".", { colour: COLOUR.approved }))).toContain(
            "✅"
        );
        expect(body(noticeCard("Leave declined", ".", { colour: COLOUR.adverse }))).toContain(
            "❌"
        );
    });

    it("waits in amber", () => {
        expect(body(noticeCard("Leave requested", ".", { colour: COLOUR.pending }))).toContain(
            "⏳"
        );
    });

    it("defaults to the admin mark when no colour is given", () => {
        // noticeCard already defaults its colour to admin. The emoji has to
        // follow the same default or an unstyled card leads with the wrong one.
        expect(body(noticeCard("Configuration updated", "."))).toContain(
            emojiForColour(COLOUR.admin)
        );
    });

    it("lets a caller override the colour's mark", () => {
        // Green is both "approved" and "on shift"; amber both "pending" and
        // "away". The palette cannot tell those apart, so the two shift cards
        // say which they are.
        const card = noticeCard("On shift, available", ".", {
            colour: COLOUR.onShift,
            emoji: EMOJI.onShift
        });
        expect(body(card)).toContain("### ▶️ On shift, available");
        expect(body(card)).not.toContain("✅");
    });
});

describe("the leave card's mark", () => {
    const heading = (status: LeaveStatus, extra: Record<string, unknown> = {}) =>
        JSON.stringify(
            leaveRequestCard({
                leaveId: "aaaaaaaaaaaaaaaaaaaaaaaa",
                displayName: "Robin (<@123>)",
                startDate: new Date("2026-09-07T09:00:00Z"),
                endDate: new Date("2026-09-21T09:00:00Z"),
                reason: "Exams.",
                decided: null,
                status,
                ...extra
            }).components[0]
        );

    it("matches the colour the card is drawn in, for every state", () => {
        expect(heading("pending")).toContain("⏳ Leave request");
        expect(heading("approved")).toContain("✅ Leave request");
        expect(heading("declined")).toContain("❌ Leave request");
        expect(heading("active")).toContain("🌙 Leave request");
        expect(heading("ended")).toContain("📁 Leave request");
    });

    it("follows the grey of a purged record rather than the status it reports", () => {
        // A purged card is drawn grey whatever state it was decided in, so the
        // mark has to come from the colour and not from the status.
        expect(heading("approved", { purged: "Purged by <@9> now." })).toContain(
            `${emojiForColour(COLOUR.settled)} Leave request`
        );
    });

    it("keeps the state in words as well, so the mark never carries it alone", () => {
        expect(heading("declined")).toContain("Declined");
    });
});

describe("the vocabulary itself", () => {
    it("is a single mark per entry, never a string of them", () => {
        for (const [name, mark] of Object.entries({ ...EMOJI, ...EMOJI_FOR_COLOUR })) {
            expect([...mark].filter((c) => c !== "️").length, name).toBeLessThanOrEqual(2);
        }
    });
});
