import { describe, expect, it } from "vitest";
import { leaveRequestCard } from "../src/render/cards.js";
import { COLOUR } from "../src/render/theme.js";
import type { LeaveStatus } from "../src/db/types.js";

/**
 * The leave card walks one record from "pending" to "back" without posting a
 * second message, so its colour and its buttons are the only thing telling a
 * channel full of scrolling Executives what state a request is in. Both are
 * derived from the record's status, and this is where that derivation is held.
 */

const base = {
    leaveId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Robin (<@123>)",
    startDate: new Date("2026-09-07T09:00:00Z"),
    endDate: new Date("2026-09-21T09:00:00Z"),
    reason: "Exams.",
    decided: null
};

/** The accent colour discord.js recorded on the container. */
function accent(status: LeaveStatus, extra: Record<string, unknown> = {}): number | undefined {
    const card = leaveRequestCard({ ...base, status, ...extra });
    return (card.components[0] as unknown as { data: { accent_color?: number } }).data
        .accent_color;
}

/** The custom IDs of every button on the card, in order. */
function buttons(status: LeaveStatus, extra: Record<string, unknown> = {}): string[] {
    const card = leaveRequestCard({ ...base, status, ...extra });
    const json = JSON.stringify(card.components[0]);
    return [...json.matchAll(/"custom_id":"([^"]+)"/g)].map((match) => match[1]);
}

describe("colour says the state before the words do", () => {
    it("is amber while it waits on a human", () => {
        expect(accent("pending")).toBe(COLOUR.pending);
    });

    it("is green for a yes and red for a no", () => {
        expect(accent("approved")).toBe(COLOUR.approved);
        expect(accent("declined")).toBe(COLOUR.adverse);
    });

    it("is blue while the leave is actually running", () => {
        // Not amber: a leave in progress is not a decision anybody owes.
        expect(accent("active")).toBe(COLOUR.inProgress);
        expect(accent("active")).not.toBe(COLOUR.pending);
    });

    it("is grey once there is nothing left to do", () => {
        expect(accent("ended")).toBe(COLOUR.settled);
        expect(accent("ended", { purged: "Purged by <@9> now." })).toBe(COLOUR.settled);
    });

    it("gives every state its own colour except the two that are both finished", () => {
        const colours = (["pending", "approved", "declined", "active"] as LeaveStatus[]).map(
            (status) => accent(status)
        );
        expect(new Set(colours).size).toBe(4);
    });
});

describe("the buttons are the actions that state actually has", () => {
    it("offers a decision, and only a decision, while pending", () => {
        expect(buttons("pending")).toEqual([
            `leave:${base.leaveId}:approve`,
            `leave:${base.leaveId}:decline`
        ]);
    });

    it("offers to end leave that is running or about to", () => {
        expect(buttons("active")).toContain(`leave:${base.leaveId}:end`);
        expect(buttons("approved")).toContain(`leave:${base.leaveId}:end`);
    });

    it("does not offer to end a leave that never started or already finished", () => {
        // Ending a declined or ended record is not a cautious no-op, it is a
        // button whose only possible answer is a refusal.
        expect(buttons("declined")).not.toContain(`leave:${base.leaveId}:end`);
        expect(buttons("ended")).not.toContain(`leave:${base.leaveId}:end`);
    });

    it("never offers to approve something already decided", () => {
        for (const status of ["approved", "declined", "active", "ended"] as LeaveStatus[]) {
            expect(buttons(status)).not.toContain(`leave:${base.leaveId}:approve`);
            expect(buttons(status)).not.toContain(`leave:${base.leaveId}:decline`);
        }
    });

    it("offers the purge on every decided state and none of the pending one", () => {
        expect(buttons("pending")).not.toContain(`leavePurge:${base.leaveId}:ask`);
        for (const status of ["approved", "declined", "active", "ended"] as LeaveStatus[]) {
            expect(buttons(status)).toContain(`leavePurge:${base.leaveId}:ask`);
        }
    });

    it("leaves no buttons at all on a purged record", () => {
        // There is nothing left to act on, and a button that can only answer
        // "already gone" is worse than no button.
        expect(buttons("ended", { purged: "Purged by <@9> now." })).toEqual([]);
        expect(buttons("active", { purged: "Purged by <@9> now." })).toEqual([]);
    });
});

describe("the card says its state in words as well", () => {
    const words = (status: LeaveStatus) =>
        JSON.stringify(leaveRequestCard({ ...base, status }).components[0]);

    it("labels each state, so colour never carries the meaning alone", () => {
        expect(words("pending")).toContain("Waiting on an Executive");
        expect(words("approved")).toContain("Approved, not started yet");
        expect(words("declined")).toContain("Declined");
        expect(words("active")).toContain("On leave now");
        expect(words("ended")).toContain("Back");
    });

    it("stops counting down to a return date once they are back", () => {
        // "ending in 3 days" on a finished leave reads as a live booking.
        expect(words("active")).toContain("ending");
        expect(words("ended")).not.toContain("ending <t:");
    });
});
