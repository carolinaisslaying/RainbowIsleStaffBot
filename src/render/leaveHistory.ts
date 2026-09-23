import type { ObjectId } from "mongodb";
import type { LeaveDoc } from "../db/types.js";
import { ts } from "../time/format.js";
import type { LeaveEnding, LeaveEvent } from "./cards.js";

/**
 * Everything that has happened to a leave record, one line each, oldest first:
 * requested, decided, started, every extension asked for and what became of
 * it, ended or cancelled. The card's History section draws exactly this.
 *
 * Pure, with names passed in, so every state can be tested without a
 * database. Every action on a leave has a line here; one that did not would be
 * an action the leave channel never shows anybody.
 */
export function leaveHistory(
    leave: LeaveDoc,
    mention: (staffId: ObjectId | null | undefined) => string
): { history: LeaveEvent[]; ending: LeaveEnding | null; withdrawn: boolean } {
    // Oldest first, one line per thing that happened. Every state is the
    // same list at a different length.
    const history: LeaveEvent[] = [{ mark: "📨", text: "Requested", at: leave.requestedAt }];
    if (leave.decidedAt) {
        const declined = leave.status === "declined";
        history.push({
            mark: declined ? "❌" : "✅",
            text: `${declined ? "Declined" : "Approved"} by ${mention(leave.decidedBy)}`,
            at: leave.decidedAt
        });
    }
    if (leave.status === "active" || leave.status === "ended") {
        history.push({ mark: "🌙", text: "Started", at: leave.startDate });
    }

    let ending: LeaveEnding | null = null;
    if (leave.status === "ended" && leave.rolesRestoredAt) {
        ending = leave.endedEarlyBy ? "executive" : leave.plannedEndDate ? "member" : "schedule";
        history.push({
            mark: "👋",
            text:
                ending === "executive"
                    ? `Ended early by ${mention(leave.endedEarlyBy)}`
                    : ending === "member"
                      ? "Ended early by them"
                      : "Ended on schedule",
            at: leave.rolesRestoredAt,
            note: ending === "executive" ? leave.endedEarlyReason ?? null : null
        });
        if (leave.restoreErrors.length > 0) {
            history.push({
                mark: "❗",
                text:
                    `${leave.restoreErrors.length} staff role` +
                    `${leave.restoreErrors.length === 1 ? "" : "s"} could not be restored`,
                at: leave.rolesRestoredAt
            });
        }
    }

    const withdrawn =
        leave.status === "cancelled" &&
        !leave.decidedAt &&
        (leave.cancelledBy?.equals(leave.staffId) ?? false);
    if (leave.status === "cancelled" && leave.cancelledAt) {
        const themselves = leave.cancelledBy?.equals(leave.staffId) ?? false;
        history.push({
            mark: "📁",
            text: withdrawn
                ? "Withdrawn by them before a decision"
                : themselves
                  ? "Cancelled by them"
                  : `Cancelled by ${mention(leave.cancelledBy)}`,
            at: leave.cancelledAt,
            note: leave.cancellationReason ?? null
        });
    }

    // Each extension is two lines: the request with its reason, then what
    // became of it. One still waiting is the request alone; its decision is
    // the pink block beneath the card.
    for (const record of leave.extensions ?? []) {
        history.push({
            mark: "⏩",
            text: `Asked to extend to ${ts(record.toEndDate, "f")}`,
            at: record.requestedAt,
            note: record.reason
        });
        history.push(
            record.outcome === "approved"
                ? {
                      mark: "✅",
                      text:
                          `Extension approved by ${mention(record.decidedBy)}: back ` +
                          `${ts(record.toEndDate, "f")} instead of ${ts(record.fromEndDate, "f")}`,
                      at: record.decidedAt
                  }
                : record.outcome === "declined"
                  ? {
                        mark: "❌",
                        text:
                            `Extension declined by ${mention(record.decidedBy)}: still ` +
                            `back ${ts(record.fromEndDate, "f")}`,
                        at: record.decidedAt
                    }
                  : {
                        mark: "⏹️",
                        text: "Extension dropped: the leave closed before anyone decided it",
                        at: record.decidedAt
                    }
        );
    }
    if (leave.pendingExtension) {
        history.push({
            mark: "⏩",
            text:
                `Asked to extend to ${ts(leave.pendingExtension.endDate, "f")}, waiting on an ` +
                "Executive",
            at: leave.pendingExtension.requestedAt,
            note: leave.pendingExtension.reason
        });
    }
    // Oldest first. Stable, so events at the same instant keep the order they
    // were added in: an end before the extension it dropped.
    history.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { history, ending, withdrawn };

}
