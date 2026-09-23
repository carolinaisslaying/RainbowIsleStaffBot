import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import type { LeaveDoc } from "../src/db/types.js";
import { leaveHistory } from "../src/render/leaveHistory.js";
import { leaveRequestCard } from "../src/render/cards.js";

/**
 * Every action on a leave gets a line in its card's history. An extension
 * approval used to be recorded by appending "Extended to 2026-11-29: …" to the
 * member's reason, and a decline, or a request dropped when the leave ended,
 * left no trace at all.
 */

const at = (iso: string) => new Date(iso);
const t = (date: Date) => `<t:${Math.floor(date.getTime() / 1000)}:f>`;
const member = new ObjectId();
const exec = new ObjectId();
const names = new Map([
    [member.toHexString(), "<@1>"],
    [exec.toHexString(), "<@9>"]
]);
const mention = (id: ObjectId | null | undefined) =>
    id ? names.get(id.toHexString()) ?? "an Executive" : "an Executive";

const base: LeaveDoc = {
    _id: new ObjectId(),
    staffId: member,
    requestedAt: at("2026-09-20T00:00:00Z"),
    startDate: at("2026-09-24T09:00:00Z"),
    endDate: at("2026-09-30T09:00:00Z"),
    plannedEndDate: null,
    pendingExtension: null,
    reason: "Exams.",
    status: "active",
    decidedBy: exec,
    decidedAt: at("2026-09-21T00:00:00Z"),
    removedRoles: [],
    rolesRestoredAt: null,
    restoreErrors: []
};
const texts = (leave: LeaveDoc) => leaveHistory(leave, mention).history.map((e) => e.text);

describe("a leave's history", () => {
    it("records the request, the decision and the start, in order", () => {
        expect(texts(base)).toEqual(["Requested", "Approved by <@9>", "Started"]);
    });

    it("shows an extension waiting, with the reason the member gave", () => {
        const { history } = leaveHistory(
            {
                ...base,
                pendingExtension: {
                    endDate: at("2026-11-29T09:00:00Z"),
                    reason: "I'm going on a bigger holiday",
                    requestedAt: at("2026-09-25T00:00:00Z")
                }
            },
            mention
        );
        const line = history.at(-1)!;
        expect(line.text).toBe(
            `Asked to extend to ${t(at("2026-11-29T09:00:00Z"))}, waiting on an Executive`
        );
        expect(line.note).toBe("I'm going on a bigger holiday");
    });

    it("records an approved extension as the request and the decision, with both dates", () => {
        const leave: LeaveDoc = {
            ...base,
            endDate: at("2026-11-29T09:00:00Z"),
            extensions: [
                {
                    requestedAt: at("2026-09-25T00:00:00Z"),
                    fromEndDate: at("2026-09-30T09:00:00Z"),
                    toEndDate: at("2026-11-29T09:00:00Z"),
                    reason: "I'm going on a bigger holiday",
                    outcome: "approved",
                    decidedAt: at("2026-09-26T00:00:00Z"),
                    decidedBy: exec
                }
            ]
        };
        expect(texts(leave).slice(-2)).toEqual([
            `Asked to extend to ${t(at("2026-11-29T09:00:00Z"))}`,
            `Extension approved by <@9>: back ${t(at("2026-11-29T09:00:00Z"))} instead of ` +
                t(at("2026-09-30T09:00:00Z"))
        ]);
        // The member's own reason for the leave is left as they wrote it.
        expect(leave.reason).toBe("Exams.");
    });

    it("records a declined extension, and says the return date stands", () => {
        const leave: LeaveDoc = {
            ...base,
            extensions: [
                {
                    requestedAt: at("2026-09-25T00:00:00Z"),
                    fromEndDate: at("2026-09-30T09:00:00Z"),
                    toEndDate: at("2026-11-29T09:00:00Z"),
                    reason: "Longer holiday",
                    outcome: "declined",
                    decidedAt: at("2026-09-26T00:00:00Z"),
                    decidedBy: exec
                }
            ]
        };
        expect(texts(leave).at(-1)).toBe(
            `Extension declined by <@9>: still back ${t(at("2026-09-30T09:00:00Z"))}`
        );
    });

    it("records an extension the leave closed on before anybody decided it", () => {
        const leave: LeaveDoc = {
            ...base,
            status: "ended",
            rolesRestoredAt: at("2026-09-30T09:00:00Z"),
            extensions: [
                {
                    requestedAt: at("2026-09-29T00:00:00Z"),
                    fromEndDate: at("2026-09-30T09:00:00Z"),
                    toEndDate: at("2026-10-05T09:00:00Z"),
                    reason: "One more week",
                    outcome: "lapsed",
                    decidedAt: at("2026-09-30T09:00:00Z"),
                    decidedBy: null
                }
            ]
        };
        const lines = texts(leave);
        expect(lines).toContain("Ended on schedule");
        expect(lines.at(-1)).toBe("Extension dropped: the leave closed before anyone decided it");
        // Same instant: the end, then the extension it dropped.
        expect(lines.indexOf("Ended on schedule")).toBeLessThan(lines.length - 1);
    });

    it("names who ended it early and why", () => {
        const { history, ending } = leaveHistory(
            {
                ...base,
                status: "ended",
                rolesRestoredAt: at("2026-09-26T00:00:00Z"),
                endDate: at("2026-09-26T00:00:00Z"),
                plannedEndDate: at("2026-09-30T09:00:00Z"),
                endedEarlyBy: exec,
                endedEarlyReason: "Back early from exams"
            },
            mention
        );
        expect(ending).toBe("executive");
        expect(history.at(-1)).toMatchObject({
            text: "Ended early by <@9>",
            note: "Back early from exams"
        });
    });

    it("tells a withdrawal apart from a cancellation", () => {
        const withdrawn = leaveHistory(
            {
                ...base,
                status: "cancelled",
                decidedAt: null,
                decidedBy: null,
                cancelledBy: member,
                cancelledAt: at("2026-09-21T00:00:00Z"),
                cancellationReason: "Plans changed"
            },
            mention
        );
        expect(withdrawn.withdrawn).toBe(true);
        expect(withdrawn.history.at(-1)).toMatchObject({
            text: "Withdrawn by them before a decision",
            note: "Plans changed"
        });

        const cancelled = leaveHistory(
            {
                ...base,
                status: "cancelled",
                cancelledBy: exec,
                cancelledAt: at("2026-09-22T00:00:00Z"),
                cancellationReason: "Short-staffed"
            },
            mention
        );
        expect(cancelled.withdrawn).toBe(false);
        expect(cancelled.history.at(-1)?.text).toBe("Cancelled by <@9>");
    });
});

describe("the card shows what extensions changed", () => {
    const card = (extra: Record<string, unknown>) =>
        leaveRequestCard({
            leaveId: "a".repeat(24),
            displayName: "Carolina",
            startDate: at("2026-09-24T09:00:00Z"),
            endDate: at("2026-11-29T09:00:00Z"),
            reason: "Exams.",
            status: "active",
            ...extra
        });

    it("says under the dates when the return date was first booked", () => {
        const json = JSON.stringify(
            card({ originalEndDate: at("2026-09-30T09:00:00Z"), extensionCount: 1 }).components[0]
        );
        expect(json).toContain(`First booked to ${t(at("2026-09-30T09:00:00Z"))}, extended once.`);
    });

    it("states a waiting extension as the new date against the old, and how much longer", () => {
        const json = JSON.stringify(
            card({
                endDate: at("2026-09-30T09:00:00Z"),
                pendingExtension: {
                    endDate: at("2026-11-29T09:00:00Z"),
                    reason: "I'm going on a bigger holiday",
                    effectLines: []
                }
            }).components[1]
        );
        expect(json).toContain(
            `Back **${t(at("2026-11-29T09:00:00Z"))}** instead of ${t(at("2026-09-30T09:00:00Z"))}, 60 days longer.`
        );
        expect(json).toContain("> I'm going on a bigger holiday");
    });
});
