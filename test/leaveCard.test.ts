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
        expect(accent("ended", { purged: { by: "<@9>", at: new Date("2026-09-22T00:00:00Z") } })).toBe(COLOUR.settled);
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
        expect(buttons("ended", { purged: { by: "<@9>", at: new Date("2026-09-22T00:00:00Z") } })).toEqual([]);
        expect(buttons("active", { purged: { by: "<@9>", at: new Date("2026-09-22T00:00:00Z") } })).toEqual([]);
    });
});

describe("the card says its state in words as well", () => {
    const words = (status: LeaveStatus) =>
        JSON.stringify(leaveRequestCard({ ...base, status }).components[0]);

    it("puts the state in the title, so colour never carries the meaning alone", () => {
        // It used to be subtext under the name, with every card titled
        // "Leave request" whatever had become of it.
        expect(words("pending")).toContain("## 📆 Leave requested");
        expect(words("approved")).toContain("## ✅ Leave approved");
        expect(words("declined")).toContain("## ❌ Leave declined");
        expect(words("active")).toContain("## 🌙 On leave");
        expect(words("ended")).toContain("## 👋 Back from leave");
        expect(words("cancelled")).toContain("## 📁 Leave cancelled");
    });

    it("counts down only while there is something to count down to", () => {
        // A declined card used to say "ending in 2 months".
        expect(words("pending")).toContain("Starts <t:");
        expect(words("approved")).toContain("Starts <t:");
        expect(words("active")).toContain("Back <t:");
        for (const status of ["declined", "ended", "cancelled"] as LeaveStatus[]) {
            expect(words(status)).not.toMatch(/(Starts|Back) <t:\d+:R>/);
        }
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
        expect(card("active", { purged: { by: "<@9>", at: new Date("2026-09-22T00:00:00Z") } }).components).toHaveLength(1);
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

describe("the confirmation card's headings climb above the fortnights", () => {
    // "What it changes" was bold, the same weight as the bold fortnight
    // headings inside it, so the section read as one more fortnight.
    it("puts the question above the sections, and the sections above the fortnights", async () => {
        const { leaveInterpretationCard } = await import("../src/render/cards.js");
        const json = JSON.stringify(
            leaveInterpretationCard({
                token: "t",
                startDate: base.startDate,
                endDate: base.endDate,
                reason: "Exams.",
                reasonLabel: "Reason",
                timeZone: "Pacific/Auckland",
                typed: ["monday", "the 21st"],
                effectLines: ["**Fortnight of 7 Sep** · nothing required", "- 📅 Week of 7 Sep"]
            }).components[0]
        );
        expect(json).toContain("## Is this right?");
        expect(json).toContain("### What it changes\\n**Fortnight of 7 Sep**");
        expect(json).toContain("### Leave starts");
        expect(json).toContain("### Reason");
        expect(json).not.toContain("**What it changes**");
    });

    it("heads the pending card's effect as a section under its title", () => {
        const json = JSON.stringify(
            leaveRequestCard({
                ...base,
                status: "pending",
                effectLines: ["**Fortnight of 7 Sep** · nothing required"]
            }).components[0]
        );
        expect(json).toContain("### If approved\\n**Fortnight of 7 Sep**");
    });
});

describe("ending or cancelling somebody's leave asks why", () => {
    it("carries which of the two it is, so a leave that started meanwhile is caught", async () => {
        const { leaveEndModal } = await import("../src/render/modals.js");
        const cancel = leaveEndModal(base.leaveId, "Robin", "cancel").toJSON();
        const back = leaveEndModal(base.leaveId, "Robin", "return").toJSON();
        expect(cancel.custom_id).toBe(`leaveEnd:${base.leaveId}:cancel`);
        expect(back.custom_id).toBe(`leaveEnd:${base.leaveId}:return`);
        expect(back.title).toBe("Bring them back now");
        expect(JSON.stringify(back)).toContain("Why is it being ended early?");
    });

    it("requires the reason from an Executive", async () => {
        const { leaveEndModal } = await import("../src/render/modals.js");
        const json = JSON.stringify(leaveEndModal(base.leaveId, "Robin", "return").toJSON());
        expect(json).toContain('"required":true');
    });

    it("says on the confirmation that a reason comes next", () => {
        const json = JSON.stringify(
            leaveEndConfirmCard({
                leaveId: base.leaveId,
                displayName: "Robin",
                endDate: base.endDate,
                active: true
            }).components[0]
        );
        expect(json).toContain("You are asked why next");
    });
});

describe("a member cancelling their own leave", () => {
    it("is a form that is its own confirmation, with the reason optional", async () => {
        const { leaveWithdrawModal } = await import("../src/render/modals.js");
        const modal = leaveWithdrawModal(base.leaveId, "Your approved leave: **x** to **y**.").toJSON();
        const json = JSON.stringify(modal);
        expect(modal.custom_id).toBe(`leaveWithdraw:${base.leaveId}`);
        expect(json).toContain("Submitting cancels it. Close this to keep it.");
        expect(json).toContain('"required":false');
        expect(json).toContain("Optional.");
    });
});

describe("every state draws the same sections, in the same order", () => {
    const at = (iso: string) => new Date(iso);
    const card = (extra: Record<string, unknown>) =>
        JSON.stringify(leaveRequestCard({ ...base, status: "ended", ...extra }).components[0]);

    it("titles an early end as one, and shows the dates booked and the dates taken", () => {
        // An early end used to read as leave running from 09:00 to 09:00.
        const json = card({
            ending: "executive",
            endDate: at("2026-09-08T09:00:00Z"),
            plannedEndDate: base.endDate
        });
        expect(json).toContain("## 👋 Leave ended early");
        expect(json).toContain("Booked · ");
        expect(json).toContain("Taken · ");
        expect(json).toContain("(14 days)");
        expect(json).toContain("(1 day)");
    });

    it("heads Dates, Reason and History in that order", () => {
        const json = card({
            history: [{ mark: "📨", text: "Requested", at: at("2026-09-01T00:00:00Z") }]
        });
        const order = ["### Dates", "### Reason", "### History"].map((heading) =>
            json.indexOf(heading)
        );
        expect(order.every((index) => index >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("writes each event as one line with who and when, and its reason beneath", () => {
        const json = card({
            history: [
                {
                    mark: "👋",
                    text: "Ended early by <@9>",
                    at: at("2026-09-08T09:00:00Z"),
                    note: "Back early from exams"
                }
            ]
        });
        expect(json).toContain("- 👋 Ended early by <@9> · <t:");
        expect(json).toContain("\\n> Back early from exams");
    });

    it("says a withdrawn request was withdrawn, and a cancelled one never started", () => {
        const withdrawn = JSON.stringify(
            leaveRequestCard({ ...base, status: "cancelled", withdrawn: true }).components[0]
        );
        expect(withdrawn).toContain("Request withdrawn");
        expect(withdrawn).toContain("It never started.");
    });

    it("adds the purge to the history and says where the record went", () => {
        const json = JSON.stringify(
            leaveRequestCard({
                ...base,
                status: "approved",
                purged: { by: "<@9>", at: at("2026-09-22T00:00:00Z") }
            }).components[0]
        );
        expect(json).toContain("Leave record purged");
        expect(json).toContain("Purged by <@9>");
        expect(json).toContain("The audit log keeps what it held.");
    });
});

describe("no blank line above a heading", () => {
    // Discord already spaces a heading from what is above it. A blank line as
    // well doubled the gap, and the leave card opened into holes between Dates,
    // Reason and History.
    it("is dropped from any text block, and subtext keeps its spacing", async () => {
        const { tightenHeadings } = await import("../src/render/cards.js");
        expect(tightenHeadings("**Name**\n\n### Dates\nx\n\n\n## Big")).toBe(
            "**Name**\n### Dates\nx\n## Big"
        );
        expect(tightenHeadings("line\n\n-# small print")).toBe("line\n\n-# small print");
        expect(tightenHeadings("para one\n\npara two")).toBe("para one\n\npara two");
    });

    it("never appears on a leave card, in any state", () => {
        for (const status of ["pending", "approved", "declined", "active", "ended", "cancelled"] as LeaveStatus[]) {
            const json = JSON.stringify(
                leaveRequestCard({
                    ...base,
                    status,
                    effectLines: ["**Fortnight of 7 Sep** · nothing required"],
                    history: [{ mark: "📨", text: "Requested", at: new Date("2026-09-01T00:00:00Z") }]
                }).components
            );
            expect(json, status).not.toMatch(/\\n\\n#{1,3} /);
        }
    });
});
