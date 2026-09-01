import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { assessmentHistory, warningsFor } from "../domain/assessments.js";
import { activeWarningCount, priorOutcomesLine, warningIsSpent } from "../domain/review.js";
import { findStaffById } from "../domain/staff.js";
import { warningsCard } from "../render/cards.js";
import { labelDate, labelWindow } from "../time/format.js";
import { staffDisplayName } from "../discord/displayName.js";
import type { RenderedMessage } from "../render/cards.js";

/**
 * A member's warning record, as a card.
 *
 * Always ephemeral, whoever is reading. Rehearsals and pre-anchor fortnights are
 * already excluded by the queries, so what is left is what actually happened.
 */
export async function warningsViewFor(
    client: Client,
    config: StaffBotConfig,
    subject: StaffDoc,
    isSelf: boolean
): Promise<RenderedMessage> {
    const now = new Date();
    const warnings = await warningsFor(subject._id);
    const history = await assessmentHistory(subject._id, 6);

    const rows = [];
    for (const warning of warnings) {
        const issuer = await findStaffById(warning.issuedBy);
        rows.push({
            issuedAt: warning.issuedAt,
            issuedBy: issuer ? `<@${issuer.discordId}>` : "an Executive who has since left",
            note: warning.note,
            acknowledged: warning.acknowledgedAt !== null,
            spent: warningIsSpent(warning.issuedAt, now, config.warningExpiryDays)
        });
    }

    return warningsCard({
        displayName: await staffDisplayName(
            client,
            config,
            subject.discordId,
            "This member"
        ),
        isSelf,
        activeCount: activeWarningCount(warnings, now, config.warningExpiryDays),
        expiryDays: config.warningExpiryDays,
        rows,
        historyLine: priorOutcomesLine(
            history.map((entry) => ({
                windowStart: entry.windowStart,
                totalMinutes: entry.totalMinutes,
                requiredMinutes: entry.requiredMinutes,
                outcome: entry.reviewOutcome,
                status: entry.status
            })),
            (date) => labelDate(date, config.accountingTimezone)
        ),
        windowLabel: (start: Date, end: Date) =>
            labelWindow(start, end, config.accountingTimezone)
    });
}
