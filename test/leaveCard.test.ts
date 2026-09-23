import { describe, expect, it } from "vitest";
import { leaveCancelledCard, leaveEndConfirmCard, leaveRequestCard } from "../src/render/cards.js";
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
    it("is the leave colour while it waits on a human, not the review's amber", () => {
        expect(accent("pending")).toBe(COLOUR.leave);
        expect(accent("pending")).not.toBe(COLOUR.pending);
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
        expect(accent("cancelled")).toBe(COLOUR.settled);
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
        expect(buttons("cancelled")).not.toContain(`leave:${base.leaveId}:end`);
    });

    it("never offers to approve something already decided", () => {
        for (const status of ["approved", "declined", "active", "ended"] as LeaveStatus[]) {
            expect(buttons(status)).not.toContain(`leave:${base.leaveId}:approve`);
            expect(buttons(status)).not.toContain(`leave:${base.leaveId}:decline`);
        }
    });

    it("offers the purge on every decided state and none of the pending one", () => {
        expect(buttons("pending")).not.toContain(`leavePurge:${base.leaveId}:ask`);
        for (const status of [
            "approved",
            "declined",
            "active",
            "ended",
            "cancelled"
        ] as LeaveStatus[]) {
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
        expect(words("cancelled")).toContain("Cancelled before it started");
    });

    it("stops counting down to a return date once they are back", () => {
        // "ending in 3 days" on a finished leave reads as a live booking.
        expect(words("active")).toContain("ending");
        expect(words("ended")).not.toContain("ending <t:");
        expect(words("cancelled")).not.toContain("ending <t:");
    });
});

describe("leave cancelled before it started", () => {
    // It used to be drawn by the welcome-back card, which reported an away
    // period running backwards (24 September to 23 September) and a role
    // "restored" that had never been taken.
    const card = leaveCancelledCard({
        startDate: base.startDate,
        endDate: base.endDate,
        cancelledBy: "999",
        reason: "Short-staffed that week."
    });
    const json = JSON.stringify(card.components[0]);

    it("says it was cancelled, and by whom", () => {
        expect(json).toContain("Leave cancelled");
        expect(json).toContain("<@999>");
        expect(json).not.toContain("Welcome back");
    });

    it("tells them why", () => {
        expect(json).toContain("**Why:** Short-staffed that week.");
    });

    it("quotes the booked dates, start before end", () => {
        const start = `<t:${Math.floor(base.startDate.getTime() / 1000)}:D>`;
        const end = `<t:${Math.floor(base.endDate.getTime() / 1000)}:D>`;
        expect(json).toContain(`from ${start} to ${end}`);
    });

    it("claims no absence and no restored roles", () => {
        expect(json).not.toContain("You were away");
        expect(json).not.toContain("restored");
        expect(json).not.toContain("What starts again");
    });

    it("is grey, like every other leave with nothing left to do", () => {
        expect((card.components[0] as unknown as { data: { accent_color?: number } }).data
            .accent_color).toBe(COLOUR.settled);
    });
});

describe("an extension waiting on an Executive", () => {
    const extension = {
        endDate: new Date("2026-09-28T09:00:00Z"),
        reason: "Exams ran over.",
        effectLines: []
    };
    const card = (status: LeaveStatus, extra: Record<string, unknown> = {}) =>
        leaveRequestCard({ ...base, status, pendingExtension: extension, ...extra });
    const accentOf = (component: unknown) =>
        (component as { data: { accent_color?: number } }).data.accent_color;

    it("stands apart in the leave colour, beneath a card that keeps its own", () => {
        // One container has one accent, so the request is drawn in its own
        // block: inside the card it wore the leave's green or blue and read as
        // settled.
        const rendered = card("active");
        expect(rendered.components).toHaveLength(2);
        expect(accentOf(rendered.components[0])).toBe(COLOUR.inProgress);
        expect(accentOf(rendered.components[1])).toBe(COLOUR.leave);
    });

    it("carries its own decision buttons in that block", () => {
        const json = JSON.stringify(card("approved").components[1]);
        expect(json).toContain(`leave:${base.leaveId}:extApprove`);
        expect(json).toContain(`leave:${base.leaveId}:extDecline`);
        expect(JSON.stringify(card("approved").components[0])).not.toContain("extApprove");
    });

    it("disappears once the leave is purged or no longer running", () => {
        expect(card("active", { purged: "Purged by <@9> now." }).components).toHaveLength(1);
        expect(card("ended").components).toHaveLength(1);
    });
});

describe("the confirmation is coloured by where the click leads", () => {
    // Every confirmation used to be the review queue's amber, so bringing
    // somebody back and calling their leave off looked identical.
    const confirm = (active: boolean) =>
        leaveEndConfirmCard({
            leaveId: base.leaveId,
            displayName: "Robin",
            endDate: base.endDate,
            active
        }).components[0] as unknown as { data: { accent_color?: number } };

    it("is green with a wave for bringing somebody back", () => {
        expect(confirm(true).data.accent_color).toBe(COLOUR.approved);
        expect(JSON.stringify(confirm(true))).toContain("👋 Bring them back now?");
    });

    it("is the leave colour for cancelling a booking", () => {
        expect(confirm(false).data.accent_color).toBe(COLOUR.leave);
        expect(JSON.stringify(confirm(false))).toContain("📆 Cancel this leave?");
    });

    it("is never the review's amber", () => {
        expect(confirm(true).data.accent_color).not.toBe(COLOUR.pending);
        expect(confirm(false).data.accent_color).not.toBe(COLOUR.pending);
    });
});
