import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { EMOJI } from "../render/emoji.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { fetchMember } from "../discord/roles.js";
import { listActiveStaff, relinkStaff } from "../domain/staff.js";
import { rebuildWeek, weekWindowFor } from "../domain/weekly.js";
import { recomputeCounts } from "../domain/activity.js";
import {
    currentFortnightIndex,
    isAssessableFortnight,
    fortnightIndexForWeek,
    windowForIndex
} from "../domain/assessments.js";
import { runFortnightAssessment, fortnightSummary } from "../services/assessmentService.js";
import { audit } from "../domain/audit.js";
import { weekStartFor, nextWeekStart, DAY_MS } from "../time/calendar.js";
import { labelWindow } from "../time/format.js";

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
                .setName("relink")
                .setDescription("Move a staff record to a new Discord account")
                .addUserOption((option) =>
                    option.setName("old").setDescription("The old account").setRequired(true)
                )
                .addUserOption((option) =>
                    option.setName("new").setDescription("The new account").setRequired(true)
                )
        ),

    async execute({ client, config, interaction, staff }) {
        const sub = interaction.options.getSubcommand();

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
                        `Checked ${counts.scanned} days of activity and fixed ${counts.corrected} ` +
                        "stored totals.",
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
                            ? `Fortnight ${index} is before the cycle's start date, so there ` +
                              "is nothing to assess."
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

        // relink
        const oldUser = interaction.options.getUser("old", true);
        const newUser = interaction.options.getUser("new", true);

        if (oldUser.id === newUser.id) {
            await respond(interaction, errorCard("Those are the same account."));
            return;
        }

        await defer(interaction, true);

        const result = await relinkStaff(oldUser.id, newUser.id, interaction.user.id);
        if (!result.ok || !result.staff) {
            await respond(interaction, errorCard(result.error ?? "Relink failed."));
            return;
        }

        // Re-apply the current roles to the new account.
        const oldMember = await fetchMember(client, config.publicGuildId, oldUser.id);
        const newMember = await fetchMember(client, config.publicGuildId, newUser.id);
        const reapplied: string[] = [];

        if (oldMember && newMember) {
            const managed = [
                config.moderationDepartmentRole,
                ...config.staffRankRoles,
                ...config.leadRoles,
                ...config.executiveRoles
            ].filter(Boolean);
            for (const roleId of managed) {
                if (oldMember.roles.cache.has(roleId) && !newMember.roles.cache.has(roleId)) {
                    try {
                        await newMember.roles.add(roleId, "Staff record relinked");
                        reapplied.push(roleId);
                    } catch {
                        // Hierarchy or a deleted role. Reported below rather than thrown.
                    }
                }
            }
        }

        await respond(
            interaction,
            noticeCard(
                "Staff record relinked",
                `<@${oldUser.id}> to <@${newUser.id}>\n\n` +
                    "Their history moves with them.\n" +
                    (reapplied.length > 0
                        ? `Re-applied ${reapplied.length} role(s) to the new account.`
                        : "No roles needed re-applying.") +
                    (newMember ? "" : "\n\n**The new account is not in the public guild.**"),
                { ephemeral: true }
            )
        );
    }
};

export { fortnightIndexForWeek };

