import { MessageFlags, type ButtonInteraction, type Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { findAssessment, issueWarning, recordReview } from "../domain/assessments.js";
import { ensureStaff, findStaffById } from "../domain/staff.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { tryDm } from "../discord/roles.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond } from "../discord/respond.js";
import { audit } from "../domain/audit.js";
import { labelWindow } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";
import { log } from "../log.js";
import { staffDisplayName } from "../discord/displayName.js";

type JsonNode = { type?: number; components?: JsonNode[]; [key: string]: unknown };

/** Deep-disable every button in a component tree, leaving everything else. */
function disableButtons(node: JsonNode): JsonNode {
    const next: JsonNode = { ...node };
    if (Array.isArray(node.components)) {
        next.components = node.components.map(disableButtons);
    }
    if (node.type === 2) next.disabled = true; // ComponentType.Button
    return next;
}

const ACTIONS = {
    warn: "warned",
    excuse: "excused",
    dismiss: "dismissed"
} as const;

type Action = keyof typeof ACTIONS;

/**
 * Every decision writes to fortnightAssessments and auditLog, and issuing a
 * warning also writes a warnings document and DMs the member. Executive only.
 */
export async function handleReviewButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    assessmentId: ObjectId,
    rawAction: string
): Promise<void> {
    const action = rawAction as Action;
    if (!(action in ACTIONS)) {
        await respond(interaction, errorCard("Unknown review action."));
        return;
    }

    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Review decisions are Executive only."));
        return;
    }

    const assessment = await findAssessment(assessmentId);
    if (!assessment) {
        await respond(interaction, errorCard("That assessment no longer exists."));
        return;
    }
    if (assessment.reviewOutcome) {
        await respond(
            interaction,
            errorCard(`Already ${ACTIONS[assessment.reviewOutcome as Action] ?? assessment.reviewOutcome}.`)
        );
        return;
    }

    // Acknowledged before the writes and the DM, which together take longer
    // than the three seconds Discord allows an un-acknowledged interaction.
    // Without this the edit below fails, the card keeps its live buttons, and
    // the Executive is left unsure whether the decision landed. Same shape as
    // the leave decision buttons.
    await interaction.deferUpdate();

    const reviewer = await ensureStaff(interaction.user.id);
    const outcome = ACTIONS[action];
    // The member reads this note in their own /mydata export, so it names the
    // Executive the way the staff server does. `reviewedBy` on the record is
    // the stable link back to them; this line is the prose.
    const note = `${outcome} by ${await staffDisplayName(
        client,
        config,
        interaction.user.id,
        interaction.user.username
    )}`;

    await recordReview(assessmentId, reviewer._id, outcome, note);

    const subject = await findStaffById(assessment.staffId);
    const window = labelWindow(
        assessment.windowStart,
        assessment.windowEnd,
        config.accountingTimezone
    );

    if (action === "warn" && subject) {
        await issueWarning(subject._id, assessmentId, reviewer._id, note);
        await tryDm(client, subject.discordId, {
            ...noticeCard(
                `You have been issued a warning`,
                `Fortnight ${window}. You recorded ${assessment.totalMinutes} activity minutes ` +
                    `against a requirement of ${assessment.requiredMinutes}, a shortfall of ` +
                    `${assessment.requiredMinutes - assessment.totalMinutes}.\n\n` +
                    "An Executive reviewed your fortnight and issued this. If you think it is " +
                    "wrong, or something was going on we should know about, reply to the " +
                    "Executive team.\n\n" +
                    `-# You can see everything held about you with ${cmd("mydata export")}.`,
                { colour: COLOUR.adverse }
            )
        });
    } else if (subject && action === "excuse") {
        await tryDm(client, subject.discordId, {
            ...noticeCard(
                "Fortnight excused",
                `Fortnight ${window}. You were below the requirement. An Executive excused ` +
                    "it, and you have no warning on record.",
                { colour: COLOUR.approved }
            )
        });
    }

    await audit(`assessment.${action}`, {
        actorId: interaction.user.id,
        targetStaffId: assessment.staffId,
        detail: {
            assessmentId: assessmentId.toHexString(),
            outcome,
            totalMinutes: assessment.totalMinutes,
            requiredMinutes: assessment.requiredMinutes
        }
    });

    // Disable this row's buttons in place, so the card shows the decision has
    // been taken rather than inviting a second click.
    try {
        await interaction.editReply({
            components: interaction.message.components.map((component) =>
                disableButtons(component.toJSON() as unknown as JsonNode)
            ) as never,
            flags: MessageFlags.IsComponentsV2
        });
    } catch (error) {
        log.debug("Could not disable review buttons in place", error);
    }

    await interaction.followUp({
        components: noticeCard(
            "Decision recorded",
            `<@${subject?.discordId ?? "unknown"}>: **${outcome}** for fortnight ` +
                `${assessment.fortnightIndex}.` +
                (action === "warn" ? " I have messaged them." : "")
        ).components,
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    } as never);
}
