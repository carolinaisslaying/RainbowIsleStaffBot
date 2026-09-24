import { ContainerBuilder, SlashCommandBuilder } from "discord.js";
import type { Command, CommandContext } from "./types.js";
import {
    computeAvailableMs,
    computeShiftActivityMinutes,
    getOpenShift,
    openPauseOf,
    shiftHistory,
    stateOf
} from "../domain/shifts.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { currentWeekStats } from "../domain/weekly.js";
import { isLeadOrAbove } from "../domain/permissions.js";
import { autoFinishShift, beginShift, finishShift } from "../services/shiftService.js";
import { EMOJI } from "../render/emoji.js";
import { shiftHistoryLine } from "../render/shiftHistory.js";
import { containersMessage, errorCard, noticeCard, text } from "../render/cards.js";
import { COLOUR } from "../render/theme.js";
import { defer, respond } from "../discord/respond.js";
import { formatDuration, ts } from "../time/format.js";
import { publicGuildName } from "../discord/guildNames.js";
import { cmd } from "../discord/commandMentions.js";
import { staffDisplayName } from "../discord/displayName.js";

/** When an away shift closes itself, from the moment the pause opened. */
function autoEndAt(pausedFrom: Date, config: { autoEndAfterAwayMinutes: number }): Date {
    return new Date(pausedFrom.getTime() + config.autoEndAfterAwayMinutes * 60_000);
}

export const shiftCommand: Command = {
    tier: "staff",
    subcommands: {
        terminate: { tier: "executive" }
    },
    data: new SlashCommandBuilder()
        .setName("shift")
        .setDescription("Start, end or check your moderation shift")
        .addSubcommand((sub) => sub.setName("start").setDescription("Go on shift"))
        .addSubcommand((sub) => sub.setName("end").setDescription("End your shift"))
        .addSubcommand((sub) =>
            sub.setName("status").setDescription("Check your current shift")
        )
        .addSubcommand((sub) =>
            sub
                .setName("history")
                .setDescription("Recent shifts. Yours, or a member's (Lead and Executive)")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Whose history. Defaults to you.")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("terminate")
                .setDescription("End a member's shift for them (Executive)")
                .addUserOption((option) =>
                    option.setName("user").setDescription("Whose shift to end").setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName("reason")
                        .setDescription("Why, for their DM and the audit log")
                        .setMaxLength(500)
                        .setRequired(false)
                )
        ),

    async execute(context) {
        const { client, config, interaction, staff } = context;
        const sub = interaction.options.getSubcommand();

        if (sub === "history") {
            await showHistory(context);
            return;
        }

        if (sub === "terminate") {
            await terminateShift(context);
            return;
        }

        const displayName = await staffDisplayName(
            client,
            config,
            interaction.user.id,
            interaction.user.username
        );

        if (sub === "start") {
            await defer(interaction, true);
            const result = await beginShift(
                client,
                config,
                staff,
                displayName,
                interaction.guildId
            );
            await respond(interaction, result.card);
            return;
        }

        if (sub === "end") {
            await defer(interaction, true);
            const card = await finishShift(client, config, staff, displayName, "manual");
            await respond(
                interaction,
                card ?? noticeCard("No open shift", "You are not on shift right now.")
            );
            return;
        }

        const open = await getOpenShift(staff._id);
        const state = stateOf(open);

        if (!open) {
            await respond(
                interaction,
                noticeCard(
                    "Not on shift",
                    `Run ${cmd("shift start", interaction.guildId)} when you are ready.`,
                    { ephemeral: true }
                )
            );
            return;
        }

        const pause = openPauseOf(open);
        const elapsed = Date.now() - open.startedAt.getTime();

        await respond(
            interaction,
            noticeCard(
                state === "away" ? "On shift, marked away" : "On shift, available",
                `Started ${ts(open.startedAt, "t")}, ${ts(open.startedAt, "R")}.\n` +
                    `Open for ${formatDuration(elapsed)} across ${open.pauses.length} ` +
                    `${open.pauses.length === 1 ? "pause" : "pauses"}.\n` +
                    (pause
                        ? `\nAway since ${ts(pause.from, "t")}, ${ts(pause.from, "R")}. Send a ` +
                          "message in any public channel, or come back online, and you will be " +
                          "available again.\n\n" +
                          `**Your shift ends itself ${ts(autoEndAt(pause.from, config), "R")}** ` +
                          `if you are still away then, ${config.autoEndAfterAwayMinutes} ` +
                          "minutes after you went away. You do not need to do anything for that."
                        : `\nYou have ${config.autoEndAfterAwayMinutes} minutes of being away ` +
                          "before a shift ends itself, so stepping out briefly costs you " +
                          "nothing."),
                { ephemeral: true, emoji: state === "away" ? EMOJI.away : EMOJI.onShift }
            )
        );
    }
};

/**
 * An Executive ending somebody else's shift. Executive only through
 * `subcommands.terminate`, so the dispatcher has already refused everyone else.
 * It closes the shift through the same path as the automatic ends, so the
 * member gets their usual summary by DM, and the minutes count as normal.
 */
async function terminateShift({ client, config, interaction }: CommandContext): Promise<void> {
    const target = interaction.options.getUser("user", true);
    if (target.id === interaction.user.id) {
        await respond(
            interaction,
            errorCard(`To end your own shift, use ${cmd("shift end", interaction.guildId)}.`)
        );
        return;
    }

    await defer(interaction, true);
    const subject = await findStaffByDiscordId(target.id);
    const delivered = subject
        ? await autoFinishShift(client, config, subject._id, "terminated", new Date(), {
              discordId: interaction.user.id,
              name: await staffDisplayName(
                  client,
                  config,
                  interaction.user.id,
                  interaction.user.username
              ),
              reason: interaction.options.getString("reason")?.trim() || undefined
          })
        : null;

    if (delivered === null) {
        await respond(
            interaction,
            noticeCard("No open shift", `<@${target.id}> is not on shift right now.`, {
                ephemeral: true
            })
        );
        return;
    }

    await respond(
        interaction,
        noticeCard(
            "Shift ended",
            `Ended <@${target.id}>'s shift. ` +
                (delivered
                    ? "They have been sent their shift summary."
                    : "Their DMs are closed, so they have not been told."),
            { ephemeral: true, colour: COLOUR.settled }
        )
    );
}

async function showHistory({ config, interaction, staff, tier }: CommandContext): Promise<void> {
    const target = interaction.options.getUser("user");
    const isSelf = !target || target.id === interaction.user.id;

    // Your own is always yours to read. Anyone else's is Lead and above.
    if (!isSelf && !isLeadOrAbove(tier)) {
        await respond(
            interaction,
            errorCard("Viewing another member's shift history requires Lead or Executive.")
        );
        return;
    }

    await defer(interaction, true);

    const subject = isSelf ? staff : await findStaffByDiscordId(target.id);
    if (!subject) {
        await respond(interaction, errorCard(`<@${target?.id}> has no staff record.`));
        return;
    }

    const shifts = await shiftHistory(subject._id, 15);
    const stats = await currentWeekStats(subject._id, config);

    // An open shift's figures are only written when it closes, so they are
    // measured up to now for the card. Reads alone: nothing is stored.
    const now = new Date();
    const lines =
        shifts.length === 0
            ? ["_No shifts on record._"]
            : await Promise.all(
                  shifts.map(async (shift) =>
                      shiftHistoryLine({
                          startedAt: shift.startedAt,
                          endedAt: shift.endedAt,
                          endReason: shift.endReason,
                          availableMs: shift.endedAt
                              ? shift.availableMs
                              : computeAvailableMs(shift, now),
                          activityMinutes: shift.endedAt
                              ? shift.activityMinutes
                              : await computeShiftActivityMinutes(shift, now),
                          awaySince: shift.endedAt ? null : (openPauseOf(shift)?.from ?? null),
                          now
                      })
                  )
              );

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.report)
        .addTextDisplayComponents(
            text(
                `## Shift history\n<@${subject.discordId}>\n\n` +
                    `This week: **${stats.activityMinutes}** activity minutes across ` +
                    `${formatDuration(stats.shiftMs)} of availability on ${stats.activeDays} ` +
                    `day(s).\n\n${lines.join("\n")}\n\n` +
                    "-# Availability and activity minutes measure different things. Only " +
                    "activity minutes count toward the fortnight minimum."
            )
        );

    await respond(interaction, containersMessage([container]));
}
