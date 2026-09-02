import { SlashCommandBuilder, ContainerBuilder } from "discord.js";
import type { Command } from "./types.js";
import {
    fetchPublicMember,
    isExecutive,
    isLeadOrAbove,
    resolveTier
} from "../domain/permissions.js";
import { conductWarningPermitted } from "../domain/conduct.js";
import { lifetimeDaysFor } from "../domain/review.js";
import { CONDUCT_TIERS, type ConductTier } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { conductWarnModal } from "../render/modals.js";
import { TIER_STYLE } from "../render/tiers.js";
import { staffDisplayName } from "../discord/displayName.js";
import { EMOJI } from "../render/emoji.js";
import {
    containersMessage,
    errorCard,
    noticeCard,
    text
} from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { ensureStaff, listActiveStaff, findStaffByDiscordId } from "../domain/staff.js";
import { rebuildWeek, weekWindowFor, currentWeekStats } from "../domain/weekly.js";
import { recomputeCounts } from "../domain/activity.js";
import {
    currentFortnightIndex,
    isAssessableFortnight,
    fortnightIndexForWeek,
    windowForIndex
} from "../domain/assessments.js";
import { runFortnightAssessment, fortnightSummary } from "../services/assessmentService.js";
import { shiftHistory } from "../domain/shifts.js";
import { audit } from "../domain/audit.js";
import { cmd } from "../discord/commandMentions.js";
import { weekStartFor, nextWeekStart, DAY_MS } from "../time/calendar.js";
import { formatDuration, labelWindow, ts } from "../time/format.js";
import { COLOUR } from "../render/theme.js";

export const adminCommand: Command = {
    tier: "executive",
    data: new SlashCommandBuilder()
        .setName("admin")
        .setDescription("Administrative operations (Executive)")
        .addSubcommand((sub) =>
            sub
                .setName("recompute")
                .setDescription("Rebuild weekly rollups from raw data")
                .addIntegerOption((option) =>
                    option
                        .setName("weeks")
                        .setDescription("How many completed weeks back to rebuild")
                        .setMinValue(1)
                        .setMaxValue(104)
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("assess")
                .setDescription("Re-run a fortnight assessment and repost the review card")
                .addIntegerOption((option) =>
                    option
                        .setName("fortnight")
                        .setDescription("Fortnight index. Defaults to the last closed one.")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("warn")
                .setDescription("Issue a formal warning for conduct (Executive)")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Who is being warned")
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("shifts")
                .setDescription("Shift history for a member (Lead and Executive)")
                .addUserOption((option) =>
                    option.setName("user").setDescription("Whose history").setRequired(true)
                )
        ),

    async execute({ client, config, interaction, staff, tier }) {
        const sub = interaction.options.getSubcommand();

        // A conduct warning goes on somebody's permanent record on one person's
        // say-so, so every rule about who may issue and who may receive one is
        // checked before the modal opens. `showModal` cannot follow a defer, so
        // this branch must not respond or defer on the way to it.
        if (sub === "warn") {
            if (!isExecutive(tier)) {
                await respond(
                    interaction,
                    errorCard(
                        "Issuing a warning is Executive only. Leads can read the record and " +
                            "the warning history, and that is the whole of it."
                    )
                );
                return;
            }

            const target = interaction.options.getUser("user", true);
            const subjectMember = await fetchPublicMember(client, config, target.id);
            const subjectTier = resolveTier(target.id, subjectMember, config);
            const subject = await ensureStaff(target.id);

            const permitted = conductWarningPermitted({
                issuerTier: tier,
                subjectTier,
                issuerStaffId: staff._id,
                subjectStaffId: subject._id,
                subjectDeparted: subject.active === false || subjectMember === null
            });
            if (!permitted.ok) {
                await respond(interaction, errorCard(permitted.reason));
                return;
            }

            // The rung descriptions say what each does to the record rather than
            // trying to define the conduct: the Executive knows what happened,
            // and what they are choosing is how long it should count for.
            await interaction.showModal(
                conductWarnModal({
                    subjectDiscordId: target.id,
                    displayName: await staffDisplayName(
                        client,
                        config,
                        target.id,
                        target.username
                    ),
                    tiers: CONDUCT_TIERS.map((value) => ({
                        value,
                        label: TIER_STYLE[value].label,
                        description: describeTierLifetime(config, value)
                    }))
                })
            );
            return;
        }

        // Shift history is Lead and above; everything else is Executive only.
        if (sub === "shifts") {
            if (!isLeadOrAbove(tier)) {
                await respond(interaction, errorCard("Shift history requires Lead or Executive."));
                return;
            }
        } else if (!isExecutive(tier)) {
            await respond(interaction, errorCard("That operation is Executive only."));
            return;
        }

        if (sub === "recompute") {
            const weeks = interaction.options.getInteger("weeks", true);
            await defer(interaction, true);

            const members = await listActiveStaff();
            const now = new Date();
            let rebuilt = 0;

            // Walk back from the current week, rebuilding completed weeks only.
            let cursor = weekWindowFor(now, config).start;
            for (let step = 0; step < weeks; step += 1) {
                const start = weekStartFor(
                    new Date(cursor.getTime() - DAY_MS),
                    config.accountingTimezone,
                    config.weekStartDay
                );
                const window = {
                    start,
                    end: nextWeekStart(start, config.accountingTimezone, config.weekStartDay)
                };
                for (const member of members) {
                    await rebuildWeek(member._id, window, config, now);
                    rebuilt += 1;
                }
                cursor = start;
            }

            const counts = await recomputeCounts();

            await audit("admin.recompute", {
                actorId: interaction.user.id,
                targetStaffId: staff._id,
                detail: { weeks, rebuilt, counts }
            });

            await respond(
                interaction,
                noticeCard(
                    "Recompute finished",
                    `Rebuilt ${rebuilt} weekly rollups across ${weeks} week(s) for ` +
                        `${members.length} staff, from raw activity and shift data.\n` +
                        `Checked ${counts.scanned} day bitmaps and corrected ${counts.corrected} ` +
                        "popcount caches.\n\n" +
                        "-# Rollups rebuild from raw activity and shifts, which this leaves untouched.",
                    { ephemeral: true, emoji: EMOJI.recompute }
                )
            );
            return;
        }

        if (sub === "assess") {
            await defer(interaction, true);

            const requested = interaction.options.getInteger("fortnight");
            // The last fortnight that has actually closed.
            const index = requested ?? currentFortnightIndex(config) - 1;
            const window = windowForIndex(index, config);

            if (window.end > new Date() && requested === null) {
                await respond(
                    interaction,
                    errorCard("That fortnight has not closed yet. Pass an index to force it.")
                );
                return;
            }

            // Always the real thing. Rehearsing lives on /dev, so there is no
            // flag here to leave in the wrong position.
            const plan = await runFortnightAssessment(client, config, index);

            if (plan === "silent") {
                await respond(
                    interaction,
                    errorCard(
                        !isAssessableFortnight(index)
                            ? `Fortnight ${index} is before the anchor this cycle counts ` +
                              "from, so it is not a fortnight of it. Nothing was assessed."
                            : `Fortnight ${index} has already been announced. The figures ` +
                              "have been refreshed and nobody was notified again."
                    )
                );
                return;
            }

            const summary = await fortnightSummary(index);

            await audit("admin.assess", {
                actorId: interaction.user.id,
                detail: { fortnightIndex: index }
            });

            await respond(
                interaction,
                noticeCard(
                    plan === "rehearse"
                        ? `Fortnight ${index} rehearsed`
                        : `Fortnight ${index} assessed`,
                    `${labelWindow(window.week1Start, window.end, config.accountingTimezone)}\n` +
                        `${summary.met} met, ${summary.below} below, ${summary.exempt} exempt, ` +
                        `${summary.total} assessed.\n\n` +
                        (plan === "rehearse"
                            ? "The card is up and marked as a rehearsal. Nobody was DMed and " +
                              "the fortnight can still be announced for real later."
                            : "The review card is up. An Executive decides each outcome."),
                    { ephemeral: true }
                )
            );
            return;
        }

        // shifts
        const target = interaction.options.getUser("user", true);
        await defer(interaction, true);

        const subject = await findStaffByDiscordId(target.id);
        if (!subject) {
            await respond(interaction, errorCard(`<@${target.id}> has no staff record.`));
            return;
        }

        const shifts = await shiftHistory(subject._id, 15);
        const stats = await currentWeekStats(subject._id, config);

        const lines =
            shifts.length === 0
                ? ["_No shifts on record._"]
                : shifts.map((shift) => {
                      const duration = shift.endedAt
                          ? formatDuration(
                                shift.endedAt.getTime() - shift.startedAt.getTime()
                            )
                          : "open";
                      return (
                          `${ts(shift.startedAt, "f")}, ${duration}, ` +
                          `${formatDuration(shift.availableMs)} available, ` +
                          `${shift.activityMinutes} min earned` +
                          (shift.endReason ? `, ${shift.endReason}` : "")
                      );
                  });

        const container = new ContainerBuilder()
            .setAccentColor(COLOUR.report)
            .addTextDisplayComponents(
                text(
                    `## Shift history\n<@${subject.discordId}>\n\n` +
                        `This week: **${stats.activityMinutes}** activity minutes across ` +
                        `${formatDuration(stats.shiftMs)} of availability on ${stats.activeDays} ` +
                        `day(s).\n\n${lines.join("\n")}\n\n` +
                        "-# Availability and activity minutes measure different things. Only " +
                        "activity minutes count toward compliance."
                )
            );

        await respond(interaction, containersMessage([container]));
    }
};

export { fortnightIndexForWeek };


/** "Counts for 90 days" / "Never stops counting", from the configured ladder. */
function describeTierLifetime(config: StaffBotConfig, tier: ConductTier): string {
    const days = lifetimeDaysFor({ kind: "conduct", tier, issuedAt: new Date() }, config);
    return days <= 0 ? "Never stops counting" : `Counts for ${days} days`;
}
