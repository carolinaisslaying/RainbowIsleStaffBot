import { SlashCommandBuilder, MessageFlags } from "discord.js";
import type { Command } from "./types.js";
import { errorCard, noticeCard, scrubConfirmCard } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { previousWeekWindow } from "../domain/weekly.js";
import {
    currentFortnightIndex,
    isAssessableFortnight,
    windowForIndex
} from "../domain/assessments.js";
import { permittedScrub, scrubPreview } from "../domain/scrub.js";
import { env } from "../config/env.js";
import { loadConfig } from "../config/guildConfig.js";
import { configWarnings } from "../config/configGuards.js";
import { db } from "../db/client.js";
import { jobStatus, schedulerRunning } from "../jobs/scheduler.js";
import { devStatusCard, setupStatus } from "../render/configCards.js";
import { log } from "../log.js";
import { runFortnightAssessment, fortnightSummary } from "../services/assessmentService.js";
import { rehearseRecap } from "../services/notifications.js";
import { buildTeamRecap } from "../services/teamRecapService.js";
import { audit } from "../domain/audit.js";
import { labelWindow } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";

/**
 * The tools for trying things out, kept away from the tools for running things.
 *
 * Everything here either writes records that are not real, sends nothing to
 * anyone, or deletes. None of it is an Executive's job: an Executive decides
 * about people, and these change how the bot behaves and what it remembers.
 * `seededOnly` is what enforces that, because `resolveTier` promotes a seeded
 * admin to Executive and so the tier alone cannot say "Executive is not
 * enough".
 *
 * The real counterparts stay on `/admin`: `/admin assess` runs a fortnight for
 * real, `/admin recompute` rebuilds rollups. Nothing here has a real mode, so
 * there is no flag to leave in the wrong position.
 */
export const devCommand: Command = {
    tier: "executive",
    seededOnly: true,
    data: new SlashCommandBuilder()
        .setName("dev")
        .setDescription("Rehearsals and cleanup (deployment administrators)")
        .addSubcommand((sub) =>
            sub
                .setName("assess")
                .setDescription("Rehearse a fortnight review. Nobody is told.")
                .addIntegerOption((option) =>
                    option
                        .setName("fortnight")
                        .setDescription("Fortnight index. Defaults to the last closed one.")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("recap")
                .setDescription("Read a recap without anybody being sent one")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Whose recap. Defaults to your own.")
                        .setRequired(false)
                )
                .addBooleanOption((option) =>
                    option
                        .setName("team")
                        .setDescription("The team recap for the channel instead")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("purge")
                .setDescription("Delete a review: its records and its messages")
                .addIntegerOption((option) =>
                    option
                        .setName("fortnight")
                        .setDescription(
                            "One fortnight. Leave empty for every fortnight before the anchor."
                        )
                        .setRequired(false)
                )
                .addBooleanOption((option) =>
                    option
                        .setName("rerun")
                        .setDescription("Rehearse the fortnight again once it is cleared")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("status")
                .setDescription("What the bot is doing, and what is stopping it")
        ),

    async execute({ client, config, interaction, staff }) {
        const sub = interaction.options.getSubcommand();

        if (sub === "status") {
            await defer(interaction, true);

            // A real round trip rather than a cached flag: "the driver thinks it
            // is connected" is exactly the thing that is wrong when this card is
            // worth reading.
            let databaseOk = true;
            try {
                await db().command({ ping: 1 });
            } catch (error) {
                databaseOk = false;
                log.error("Database ping failed during /dev status", error);
            }

            const fresh = await loadConfig();
            await respond(
                interaction,
                devStatusCard({
                    uptimeMs: Math.round(process.uptime() * 1000),
                    // discord.js reports -1 until the first heartbeat lands.
                    gatewayMs: client.ws.ping,
                    databaseOk,
                    schedulerRunning: schedulerRunning(),
                    jobs: jobStatus(),
                    missingRequired: setupStatus(fresh).missingRequired,
                    warnings: configWarnings(fresh, new Date()).map((warning) => ({
                        key: String(warning.key),
                        text: warning.text
                    })),
                    dangerousCommands: env.devDangerousCommands
                })
            );
            return;
        }

        if (sub === "assess") {
            await defer(interaction, true);

            const requested = interaction.options.getInteger("fortnight");
            const index = requested ?? currentFortnightIndex(config) - 1;

            if (!isAssessableFortnight(index)) {
                await respond(
                    interaction,
                    errorCard(
                        `Fortnight ${index} is before the anchor this cycle counts from, so it ` +
                            "is not a fortnight of it. Nothing was assessed."
                    )
                );
                return;
            }

            const window = windowForIndex(index, config);
            // Always a rehearsal. There is no flag to leave in the wrong
            // position, which is how a dry run once wrote real warnings.
            await runFortnightAssessment(client, config, index, { dryRun: true });
            const summary = await fortnightSummary(index);

            await audit("dev.assess", {
                actorId: interaction.user.id,
                detail: { fortnightIndex: index, rehearsal: true }
            });

            await respond(
                interaction,
                noticeCard(
                    `Fortnight ${index} rehearsed`,
                    `${labelWindow(window.week1Start, window.end, config.accountingTimezone)}\n` +
                        `${summary.met} met, ${summary.below} below, ${summary.exempt} exempt, ` +
                        `${summary.total} assessed.\n\n` +
                        "The cards are up and marked as a rehearsal. Nobody outside the " +
                        "deployment administrators was messaged, nothing counts against " +
                        "anyone, and the fortnight can still be announced for real later.\n\n" +
                        `-# Clear it with ${cmd(`dev purge fortnight:${index}`, interaction.guildId)}.`,
                    { ephemeral: true, colour: COLOUR.pending }
                )
            );
            return;
        }

        if (sub === "recap") {
            await defer(interaction, true);

            if (interaction.options.getBoolean("team")) {
                const week = previousWeekWindow(new Date(), config);
                const card = await buildTeamRecap(client, config, week, true);
                if (!card) {
                    await respond(
                        interaction,
                        errorCard(
                            "There are no weekly rollups for the week that just closed, so " +
                                "there is nothing to summarise."
                        )
                    );
                    return;
                }
                await respond(interaction, {
                    ...card,
                    flags: card.flags | MessageFlags.Ephemeral
                });
                return;
            }

            const who = interaction.options.getUser("user");
            const subject = who ? await findStaffByDiscordId(who.id) : staff;
            if (!subject) {
                await respond(interaction, errorCard(`<@${who?.id}> has no staff record.`));
                return;
            }

            // Claims no delivery receipt: their real recap still arrives at
            // their own 09:00 afterwards.
            const card = await rehearseRecap(client, config, subject._id);
            if (!card) {
                await respond(
                    interaction,
                    errorCard(
                        "There is no weekly rollup for the week that just closed, so there is " +
                            `nothing to recap. Run ${cmd("admin recompute", interaction.guildId)} ` +
                            "first if the week should have one."
                    )
                );
                return;
            }

            await respond(interaction, {
                ...card,
                flags: card.flags | MessageFlags.Ephemeral
            });
            return;
        }

        // purge
        await defer(interaction, true);

        const requested = interaction.options.getInteger("fortnight");
        const rerun = interaction.options.getBoolean("rerun") ?? false;
        const found = await scrubPreview(requested);
        const { allowed: target, refused } = permittedScrub(found, env.devDangerousCommands);

        // Everything found is protected: there is nothing to confirm, so say
        // what was found and what would let it through rather than offering a
        // button that can only refuse.
        if (target.assessments.length === 0 && refused.assessments.length > 0) {
            await respond(
                interaction,
                errorCard(
                    `**${refused.assessments.length} real ` +
                        `${refused.assessments.length === 1 ? "record" : "records"}** ` +
                        (requested === null
                            ? "match that, and none of them came from a rehearsal."
                            : `match fortnight ${requested}, and none of them came from a ` +
                              "rehearsal.") +
                        "\n\nThis deployment will not delete real assessment history from a " +
                        "slash command. A rehearsal's own records can always be cleared; " +
                        "somebody's actual record takes a deliberate change to the " +
                        "deployment's settings and a restart, which is the point.\n\n" +
                        "-# Set `DEV_DANGEROUS_COMMANDS=true` in the deployment environment if " +
                        "this really is meant to go."
                )
            );
            return;
        }

        if (target.assessments.length === 0) {
            await respond(
                interaction,
                noticeCard(
                    "Nothing to purge",
                    requested === null
                        ? "No assessment exists for any fortnight before the anchor."
                        : `Fortnight ${requested} has no assessments on record.`,
                    { ephemeral: true, colour: COLOUR.settled }
                )
            );
            return;
        }

        await respond(
            interaction,
            scrubConfirmCard({
                fortnight: requested,
                rerun,
                assessments: target.assessments.length,
                warnings: target.warnings.length,
                rehearsals: target.assessments.filter((entry) => entry.rehearsal === true).length,
                protectedRecords: refused.assessments.length,
                members: new Set(
                    target.assessments.map((entry) => entry.staffId.toHexString())
                ).size
            })
        );
    }
};
