import { TextDisplayBuilder } from "discord.js";
import type { StaffDoc } from "../db/types.js";
import { ts } from "../time/format.js";
import type { RenderedMessage } from "./cards.js";

const CAUSE = { role_removed: "role removed", left_server: "left the server" } as const;

/** The line a lookup carries for somebody off the team. */
export function noLongerOnTeamLine(
    staff: Pick<StaffDoc, "retiredAt" | "retiredCause">
): string {
    if (!staff.retiredAt) return "**No longer on the team.**";
    const cause = staff.retiredCause ? `, ${CAUSE[staff.retiredCause]}` : "";
    return `**No longer on the team** since ${ts(staff.retiredAt, "D")}${cause}.`;
}

/** The same card, opening with that line when the subject has retired. */
export function withRetiredLine(
    message: RenderedMessage,
    staff: Pick<StaffDoc, "active" | "retiredAt" | "retiredCause">
): RenderedMessage {
    if (staff.active) return message;
    return {
        ...message,
        components: [
            new TextDisplayBuilder().setContent(noLongerOnTeamLine(staff)),
            ...message.components
        ]
    };
}
