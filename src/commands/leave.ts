import { SlashCommandBuilder } from "discord.js";
import { ContainerBuilder } from "discord.js";
import type { Command } from "./types.js";
import {
    currentAndUpcomingLeave,
    activeLeaveFor,
    pendingOrApprovedLeaveFor
} from "../domain/leave.js";
import { findStaffById } from "../domain/staff.js";
import { isLeadOrAbove } from "../domain/permissions.js";
import { endLeave } from "../services/leaveService.js";
import { containersMessage, errorCard, noticeCard, text } from "../render/cards.js";
import { leaveExtendModal, leaveRequestModal } from "../render/modals.js";
import { defer, respond } from "../discord/respond.js";
import { ts } from "../time/format.js";
import { formatForInput, inputExample } from "../time/input.js";
import { cmd } from "../discord/commandMentions.js";
import { COLOUR } from "../render/theme.js";

/**
 * Leave, as four verbs.
 *
 * Requesting and extending both open a modal rather than taking slash command
 * options. Dates and times belong together in one form with room to explain the
 * format, and the reason needs more than the single line a string option gives
 * it. The modal submission is handled in events/leaveModals.ts, which is also
 * where every validity rule lives, so the two entry points cannot disagree.
 */
export const leaveCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Request, extend, end or list leave")
        .addSubcommand((sub) =>
            sub.setName("request").setDescription("Request leave. Opens a form.")
        )
        .addSubcommand((sub) =>
            sub.setName("extend").setDescription("Push out your return date. Opens a form.")
        )
        .addSubcommand((sub) => sub.setName("end").setDescription("End your leave and come back"))
        .addSubcommand((sub) =>
            sub.setName("list").setDescription("Current and upcoming leave (Lead and Executive)")
        ),

    async execute({ client, config, interaction, staff, tier }) {
        const sub = interaction.options.getSubcommand();
        const zone = staff.timezone ?? config.accountingTimezone;
        const now = new Date();

        if (sub === "request") {
            const existing = await pendingOrApprovedLeaveFor(staff._id);
            if (existing.length > 0) {
                const held = existing[0];
                await respond(
                    interaction,
                    errorCard(
                        `You already have leave **${held.status}**, ` +
                            `${ts(held.startDate, "D")} to ` +
                            `${held.endDate ? ts(held.endDate, "D") : "open ended"}. Use ` +
                            `${cmd("leave extend", interaction.guildId)} to move the return ` +
                            "date, or wait for a decision on it."
                    )
                );
                return;
            }
            // A modal is the reply. It cannot follow a defer, so nothing above
            // this line may touch the interaction.
            await interaction.showModal(leaveRequestModal(zone, inputExample(now, zone)));
            return;
        }

        if (sub === "extend") {
            const candidates = await pendingOrApprovedLeaveFor(staff._id);
            const extendable = candidates.find(
                (record) => record.status === "approved" || record.status === "active"
            );
            if (!extendable) {
                await respond(
                    interaction,
                    errorCard(
                        "You have no approved or active leave to extend. A request still " +
                            "waiting on an Executive cannot be extended: wait for the decision, " +
                            "and extend it after."
                    )
                );
                return;
            }
            await interaction.showModal(
                leaveExtendModal(
                    extendable._id.toHexString(),
                    zone,
                    extendable.endDate
                        ? formatForInput(extendable.endDate, zone)
                        : formatForInput(now, zone),
                    inputExample(now, zone)
                )
            );
            return;
        }

        if (sub === "end") {
            const active = await activeLeaveFor(staff._id);
            if (!active) {
                await respond(interaction, errorCard("You have no active leave to end."));
                return;
            }
            await defer(interaction, true);
            // The same card they are DMed, shown here as well. Composing a
            // second, shorter version of it is how the two drift apart.
            const welcome = await endLeave(
                client,
                config,
                active,
                { kind: "member" },
                interaction.guildId
            );
            await respond(
                interaction,
                welcome ?? noticeCard(
                    "Welcome back",
                    "Your leave is closed and your ranks have been restored.",
                    { ephemeral: true, colour: COLOUR.approved }
                )
            );
            return;
        }

        // list
        if (!isLeadOrAbove(tier)) {
            await respond(interaction, errorCard("Listing leave requires Lead or Executive."));
            return;
        }

        await defer(interaction, true);
        const records = await currentAndUpcomingLeave();
        const isExecutive = tier === "executive";

        const container = new ContainerBuilder()
            .setAccentColor(COLOUR.report)
            .addTextDisplayComponents(text(`## Current and upcoming leave`));

        if (records.length === 0) {
            container.addTextDisplayComponents(text("_Nobody is on or scheduled for leave._"));
        } else {
            const lines: string[] = [];
            for (const record of records) {
                const subject = await findStaffById(record.staffId);
                // Leave reasons are Executive only, per the permission tiers.
                const reason = isExecutive ? `, ${record.reason.split("\n")[0]}` : "";
                lines.push(
                    `<@${subject?.discordId ?? "unknown"}>, **${record.status}**, ` +
                        `${ts(record.startDate, "f")} to ` +
                        `${record.endDate ? ts(record.endDate, "f") : "open ended"}${reason}`
                );
            }
            container.addTextDisplayComponents(text(lines.join("\n")));
            if (!isExecutive) {
                container.addTextDisplayComponents(
                    text("-# Reasons are visible to Executives only.")
                );
            }
        }

        await respond(interaction, containersMessage([container]));
    }
};
