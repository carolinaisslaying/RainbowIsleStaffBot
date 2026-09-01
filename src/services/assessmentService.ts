import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { FortnightAssessmentDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    assessFortnight,
    assessmentHistory,
    assessmentsForFortnight,
    belowThresholdFor,
    windowForIndex
} from "../domain/assessments.js";
import { findStaffById } from "../domain/staff.js";
import { staffChannel } from "./leaveService.js";
import {
    containersMessage,
    noticeCard,
    reviewRowCard,
    text,
    type TopLevelComponent
} from "../render/cards.js";
import { sendFortnightOutcome } from "./notifications.js";
import { ContainerBuilder } from "discord.js";
import { labelWindow, formatMinutes } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";
import { staffDisplayName } from "../discord/displayName.js";

/**
 * The bot never issues a warning by itself. It assesses, posts one review card
 * listing everyone below threshold, and waits for an Executive to decide.
 */

const OUTCOME_LABEL: Record<string, string> = {
    warned: "warned",
    excused: "excused",
    dismissed: "dismissed"
};

async function priorOutcomesLine(staffId: ObjectId, excludeIndex: number): Promise<string> {
    const history = await assessmentHistory(staffId, 6);
    const relevant = history.filter((entry) => entry.fortnightIndex !== excludeIndex);
    if (relevant.length === 0) return "none on record";
    return relevant
        .map((entry) => {
            const outcome = entry.reviewOutcome
                ? OUTCOME_LABEL[entry.reviewOutcome]
                : entry.status;
            return `F${entry.fortnightIndex} ${entry.totalMinutes}m ${outcome}`;
        })
        .join(", ");
}

/** Run the assessment for a closed fortnight and post the review card. */
export async function runFortnightAssessment(
    client: Client,
    config: StaffBotConfig,
    index: number
): Promise<void> {
    const assessments = await assessFortnight(index, config);
    const window = windowForIndex(index, config);
    const label = labelWindow(window.week1Start, window.end, config.accountingTimezone);

    // Every member gets their own outcome, met or not.
    for (const assessment of assessments) {
        const staff = await findStaffById(assessment.staffId);
        if (!staff) continue;

        const body =
            assessment.status === "exempt"
                ? `Fortnight ${label}. You were on approved leave, so this assessment does ` +
                  "not apply to you."
                : assessment.status === "met"
                  ? `Fortnight ${label}. You recorded ${formatMinutes(assessment.totalMinutes)} ` +
                    `against a requirement of ${assessment.requiredMinutes}. Target met.`
                  : `Fortnight ${label}. You recorded ${formatMinutes(assessment.totalMinutes)} ` +
                    `against a requirement of ${assessment.requiredMinutes}, a shortfall of ` +
                    `${assessment.requiredMinutes - assessment.totalMinutes}. An Executive ` +
                    "will review it and decide what happens.";

        await sendFortnightOutcome(
            client,
            staff.discordId,
            body,
            assessment.status === "met"
                ? COLOUR.approved
                : assessment.status === "exempt"
                  ? COLOUR.settled
                  : COLOUR.pending
        );
    }

    await postReviewCard(client, config, index);
}

/** One review card for the fortnight, listing every member below threshold. */
export async function postReviewCard(
    client: Client,
    config: StaffBotConfig,
    index: number
): Promise<void> {
    // Rows already decided are dropped rather than reprinted. That is what makes
    // re-running the assessment a way to page through a backlog larger than one
    // card can hold: decide the first batch, run it again, see the next.
    const all = await belowThresholdFor(index);
    const below = all.filter((assessment) => !assessment.reviewOutcome);
    const alreadyDecided = all.length - below.length;
    const channel = await staffChannel(client, config, config.reportChannelId);
    if (!channel) {
        log.warn("No reportChannelId configured; skipping the fortnight report card.");
        return;
    }

    const window = windowForIndex(index, config);
    const label = labelWindow(window.week1Start, window.end, config.accountingTimezone);

    if (below.length === 0) {
        await channel.send({
            ...noticeCard(
                `Fortnight ${index} assessed`,
                alreadyDecided > 0
                    ? `${label}. All ${alreadyDecided} member(s) below the requirement have been ` +
                      "reviewed. Nothing left to decide."
                    : `${label}. Every active member met the ` +
                      `${config.fortnightRequiredMinutes} minute requirement. Nothing to review.`
            )
        });
        return;
    }

    const header = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(
                `## Fortnight ${index} review\n${label}\n` +
                    `${below.length} ${below.length === 1 ? "member is" : "members are"} below ` +
                    `the ${config.fortnightRequiredMinutes} minute requirement` +
                    (alreadyDecided > 0 ? `, ${alreadyDecided} already reviewed` : "") +
                    ".\n" +
                    "-# The bot issues no warnings. Each outcome below is an Executive decision."
            )
        );

    const containers: TopLevelComponent[] = [header];

    // The 40 component ceiling is real: cap rows and say so rather than
    // silently truncating.
    const MAX_ROWS = 12;
    for (const assessment of below.slice(0, MAX_ROWS)) {
        const staff = await findStaffById(assessment.staffId);
        containers.push(
            reviewRowCard({
                assessmentId: assessment._id.toHexString(),
                // The mention is appended rather than used as the fallback,
                // so someone who has left both servers reads as a named row an
                // Executive can still click through, not as the same mention
                // printed twice.
                displayName: staff
                    ? `${await staffDisplayName(
                          client,
                          config,
                          staff.discordId,
                          "Departed member"
                      )} (<@${staff.discordId}>)`
                    : "unknown member",
                week1Minutes: assessment.week1Minutes,
                week2Minutes: assessment.week2Minutes,
                totalMinutes: assessment.totalMinutes,
                requiredMinutes: assessment.requiredMinutes,
                priorOutcomes: await priorOutcomesLine(assessment.staffId, index),
                decided: assessment.reviewOutcome
                    ? OUTCOME_LABEL[assessment.reviewOutcome]
                    : null
            })
        );
    }

    if (below.length > MAX_ROWS) {
        containers.push(
            new ContainerBuilder().addTextDisplayComponents(
                text(
                    `-# ${below.length - MAX_ROWS} further members fall below the threshold. ` +
                        "One card holds 40 components, so decide the rows above, then run " +
                        `${cmd(`admin assess fortnight:${index}`, config.staffGuildId)} for the next batch.`
                )
            )
        );
    }

    await channel.send({ ...containersMessage(containers as ContainerBuilder[]) });
}

export async function fortnightSummary(index: number): Promise<{
    total: number;
    met: number;
    below: number;
    exempt: number;
    assessments: FortnightAssessmentDoc[];
}> {
    const assessments = await assessmentsForFortnight(index);
    return {
        total: assessments.length,
        met: assessments.filter((entry) => entry.status === "met").length,
        below: assessments.filter((entry) => entry.status === "below").length,
        exempt: assessments.filter((entry) => entry.status === "exempt").length,
        assessments
    };
}
