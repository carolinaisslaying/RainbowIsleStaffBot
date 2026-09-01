import { AttachmentBuilder, ContainerBuilder, SlashCommandBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder } from "discord.js";
import type { Command } from "./types.js";
import {
    buildCoverageGrid,
    weekdayLabels,
    worstCells,
    zonesInEveningDuring
} from "../services/coverageService.js";
import { renderHeatmap } from "../render/heatmap.js";
import { isExecutive } from "../domain/permissions.js";
import { V2_FLAGS, containersMessage, errorCard, separator, text } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { isValidTimezone, searchTimezones } from "../time/timezones.js";
import { labelWindow } from "../time/format.js";
import { COLOUR } from "../render/theme.js";

function hourLabel(hour: number): string {
    return `${String(hour).padStart(2, "0")}:00`;
}

export const coverageCommand: Command = {
    tier: "executive",
    data: new SlashCommandBuilder()
        .setName("coverage")
        .setDescription("Coverage against demand (Executive)")
        .addSubcommand((sub) =>
            sub
                .setName("heatmap")
                .setDescription("7 by 24 grid of demand per available moderator")
                .addStringOption((option) =>
                    option
                        .setName("tz")
                        .setDescription("Render in this timezone. Defaults to yours.")
                        .setAutocomplete(true)
                        .setRequired(false)
                )
                .addIntegerOption((option) =>
                    option
                        .setName("weeks")
                        .setDescription("Lookback in weeks")
                        .setMinValue(1)
                        .setMaxValue(52)
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("gaps")
                .setDescription("Worst demand to coverage hours, as a recruitment brief")
                .addStringOption((option) =>
                    option
                        .setName("tz")
                        .setDescription("Rank in this timezone. Defaults to yours.")
                        .setAutocomplete(true)
                        .setRequired(false)
                )
        ),

    async autocomplete(interaction) {
        const zones = searchTimezones(interaction.options.getFocused());
        await interaction.respond(zones.map((zone) => ({ name: zone, value: zone })));
    },

    async execute({ config, interaction, staff, tier }) {
        if (!isExecutive(tier)) {
            await respond(interaction, errorCard("Coverage reporting is Executive only."));
            return;
        }

        const requested = interaction.options.getString("tz");
        if (requested && !isValidTimezone(requested)) {
            await respond(interaction, errorCard(`**${requested}** is not an IANA timezone.`));
            return;
        }
        // Defaults to the requester's timezone, falling back to UTC.
        const zone = requested ?? staff.timezone ?? "UTC";
        const sub = interaction.options.getSubcommand();

        await defer(interaction, false);

        const weeks =
            interaction.options.getInteger("weeks") ?? config.heatmapLookbackWeeks;
        const grid = await buildCoverageGrid(config, zone, weeks);
        const worst = worstCells(grid, 5);
        const days = weekdayLabels(config.weekStartDay);

        if (sub === "gaps") {
            const container = new ContainerBuilder()
                .setAccentColor(COLOUR.pending)
                .addTextDisplayComponents(
                    text(
                        `## Coverage gaps\n${zone}, ${grid.weeks} week mean, ` +
                            `${labelWindow(grid.from, grid.to, config.accountingTimezone)}`
                    )
                )
                .addSeparatorComponents(separator());

            if (worst.length === 0) {
                container.addTextDisplayComponents(
                    text("_No demand recorded in this window. Check which channels are tracked._")
                );
            } else {
                const blocks = worst.map((cell, index) => {
                    const zones = zonesInEveningDuring(
                        grid.from,
                        cell.weekday,
                        cell.hour,
                        zone,
                        config.weekStartDay
                    );
                    return (
                        `**${index + 1}. ${days[cell.weekday]} ${hourLabel(cell.hour)}**\n` +
                        `${cell.demand.toFixed(1)} messages per hour against ` +
                        `${cell.coverage.toFixed(2)} moderators available ` +
                        `(**${cell.ratio.toFixed(1)}** per moderator)\n` +
                        `-# Evening, 18:00 to 23:00 local, in: ` +
                        (zones.length > 0 ? zones.join(", ") : "no zone at a sociable hour")
                    );
                });
                container.addTextDisplayComponents(text(blocks.join("\n\n")));
                container.addSeparatorComponents(separator());
                container.addTextDisplayComponents(
                    text(
                        "-# Someone recruited in one of those zones covers this hour during " +
                            "their own evening, not at 3am."
                    )
                );
            }

            await respond(interaction, containersMessage([container]));
            return;
        }

        const png = renderHeatmap(grid);
        const fileName = "coverage.png";
        const attachment = new AttachmentBuilder(png, {
            name: fileName,
            description: `Coverage heatmap for ${zone}, ${grid.weeks} week mean.`
        });

        const worstText =
            worst.length === 0
                ? "_No demand recorded in the window._"
                : worst
                      .map(
                          (cell, index) =>
                              `${index + 1}. **${days[cell.weekday]} ${hourLabel(cell.hour)}** ` +
                              `${cell.demand.toFixed(1)} msg/h against ${cell.coverage.toFixed(2)} ` +
                              `moderators = **${cell.ratio.toFixed(1)}** per moderator`
                      )
                      .join("\n");

        const container = new ContainerBuilder()
            .setAccentColor(COLOUR.report)
            .addTextDisplayComponents(
                text(
                    `## Coverage heatmap\n${zone}, ${grid.weeks} week mean, ` +
                        `${labelWindow(grid.from, grid.to, config.accountingTimezone)}`
                )
            )
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder()
                        .setURL(`attachment://${fileName}`)
                        .setDescription(
                            `A 7 by 24 grid of messages per available moderator, rendered in ${zone}.`
                        )
                )
            )
            .addSeparatorComponents(separator())
            .addTextDisplayComponents(
                text(
                    `**Five worst buckets**\n${worstText}\n\n` +
                        "-# Colour plots demand divided by coverage, never either alone. A quiet " +
                        "hour with one moderator is fine; a peak hour with one moderator is the gap."
                )
            );

        await respond(interaction, {
            components: [container],
            files: [attachment],
            flags: V2_FLAGS
        });
    }
};
