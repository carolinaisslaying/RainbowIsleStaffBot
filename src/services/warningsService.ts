import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { assessmentHistory, warningsFor } from "../domain/assessments.js";
import {
    lifetimeDaysFor,
    priorOutcomesLine,
    warningIsSpent,
    warningTally
} from "../domain/review.js";
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
        const withdrawnBy = warning.withdrawnBy
            ? await findStaffById(warning.withdrawnBy)
            : null;
        rows.push({
            kind: warning.kind === "conduct" ? ("conduct" as const) : ("activity" as const),
            tier: warning.tier ?? null,
            issuedAt: warning.issuedAt,
            issuedBy: issuer ? `<@${issuer.discordId}>` : "an Executive who has since left",
            note: warning.note,
            acknowledged: warning.acknowledgedAt !== null,
            // Withdrawal beats the clock: a warning taken back counts nowhere,
            // so it is never also reported as merely spent.
            withdrawn: warning.withdrawnAt
                ? {
                      at: warning.withdrawnAt,
                      by: withdrawnBy
                          ? `<@${withdrawnBy.discordId}>`
                          : "an Executive who has since left",
                      reason: warning.withdrawalReason ?? ""
                  }
                : null,
            permanent: lifetimeDaysFor(warning, config) <= 0,
            spent: !warning.withdrawnAt && warningIsSpent(warning, now, config)
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
        tally: warningTally(warnings, now, config),
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
