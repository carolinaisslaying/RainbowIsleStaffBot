import {
    AttachmentBuilder,
    ChannelType,
    ContainerBuilder,
    SlashCommandBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder
} from "discord.js";
import type { Command } from "./types.js";
import {
    buildActivityGrid,
    buildCoverageGrid,
    busiestCells,
    weekdayLabels,
    worstCells,
    zonesInEveningDuring,
    type CoverageGrid
} from "../services/coverageService.js";
import { busiestRun, dailyProfile, quietestHour } from "../domain/observation.js";
import {
    reliabilityNote,
    renderHeatmap,
    sampleLabel,
    type HeatmapKind
} from "../render/heatmap.js";
import { isExecutive } from "../domain/permissions.js";
import { V2_FLAGS, containersMessage, errorCard, separator, text } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { isValidTimezone, searchTimezones } from "../time/timezones.js";
import { labelWindow } from "../time/format.js";
import { COLOUR } from "../render/theme.js";

function hourLabel(hour: number): string {
    return `${String(hour).padStart(2, "0")}:00`;
}

function perHour(value: number): string {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** Zone, how much data, and the dates it spans, once there is any. */
function headline(title: string, grid: CoverageGrid, accountingTimezone: string): string {
    const span =
        grid.observedHours > 0 ? `, ${labelWindow(grid.from, grid.to, accountingTimezone)}` : "";
    return `## ${title}\n${grid.timeZone}, ${sampleLabel(grid.observedHours)}${span}`;
}

/** The reliability note as a footnote, or nothing once there is enough data. */
function footnote(grid: CoverageGrid): string {
    const note = reliabilityNote(grid.observedHours);
    return note === null ? "" : `\n-# ${note}`;
}

/**
 * The day's shape with every weekday pooled, for the first week only: the
 * weekly grid is still mostly dashed then, and this already has a full day.
 */
function dailySummary(grid: CoverageGrid): string | null {
    if (grid.observedHours >= 7 * 24) return null;
    const profile = dailyProfile(grid);
    const busiest = busiestRun(profile);
    const quietest = quietestHour(profile);
    if (!busiest || !quietest) return null;

    const end = (busiest.start + busiest.length) % 24;
    return (
        `Busiest so far: **${hourLabel(busiest.start)}–${hourLabel(end)}**, averaging ` +
        `${perHour(busiest.mean)} messages an hour. Quietest: **${hourLabel(quietest.hour)}**, ` +
        `${perHour(quietest.mean)} an hour.`
    );
}

function heatmapGallery(
    grid: CoverageGrid,
    kind: HeatmapKind,
    description: string
): { gallery: MediaGalleryBuilder; attachment: AttachmentBuilder } {
    const fileName = `${kind}.png`;
    const attachment = new AttachmentBuilder(renderHeatmap(grid, kind), {
        name: fileName,
        description
    });
    const gallery = new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`).setDescription(description)
    );
    return { gallery, attachment };
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
                .setDescription("The hours most short of moderators, to guide recruiting")
                .addStringOption((option) =>
                    option
                        .setName("tz")
                        .setDescription("Rank in this timezone. Defaults to yours.")
                        .setAutocomplete(true)
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("activity")
                .setDescription("7 by 24 grid of server activity, messages per hour")
                .addChannelOption((option) =>
                    option
                        .setName("channel")
                        .setDescription("One tracked channel. Defaults to all of them.")
                        .addChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement,
                            ChannelType.GuildForum
                        )
                        .setRequired(false)
                )
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
        const weeks =
            interaction.options.getInteger("weeks") ?? config.heatmapLookbackWeeks;
        const days = weekdayLabels(config.weekStartDay);

        if (sub === "activity") {
            const channel = interaction.options.getChannel("channel");
            // Refused before the defer, so the refusal is the only reply.
            if (channel && !config.trackedChannels.includes(channel.id)) {
                await respond(
                    interaction,
                    errorCard(
                        `<#${channel.id}> is not a tracked channel, so its messages are not ` +
                            "counted. Pick a tracked one, or leave the channel out to see all of them."
                    )
                );
                return;
            }

            await defer(interaction, false);
            const grid = await buildActivityGrid(
                config,
                zone,
                weeks,
                channel ? [channel.id] : config.trackedChannels
            );
            const scope = channel ? `<#${channel.id}>` : "every tracked channel";

            const container = new ContainerBuilder()
                .setAccentColor(COLOUR.report)
                .addTextDisplayComponents(
                    text(`${headline("Server activity", grid, config.accountingTimezone)}\n${scope}`)
                );

            if (grid.maxDemand <= 0) {
                container
                    .addSeparatorComponents(separator())
                    .addTextDisplayComponents(
                        text(
                            "_No messages recorded yet. The first hour shows once it has " +
                                "finished; if it has been longer than that, check which channels " +
                                "are tracked._"
                        )
                    );
                await respond(interaction, containersMessage([container]));
                return;
            }

            const { gallery, attachment } = heatmapGallery(
                grid,
                "activity",
                `A 7 by 24 grid of average messages per hour in ` +
                    `${channel ? "one channel" : "every tracked channel"}, rendered in ${zone}.`
            );

            const busiest = busiestCells(grid, 5)
                .map(
                    (cell, index) =>
                        `${index + 1}. **${days[cell.weekday]} ${hourLabel(cell.hour)}** ` +
                        `${perHour(cell.demand)} messages an hour`
                )
                .join("\n");
            const summary = dailySummary(grid);

            container
                .addMediaGalleryComponents(gallery)
                .addSeparatorComponents(separator())
                .addTextDisplayComponents(
                    text(
                        (summary ? `${summary}\n\n` : "") +
                            `**Five busiest hours**\n${busiest}` +
                            footnote(grid)
                    )
                );

            await respond(interaction, {
                components: [container],
                files: [attachment],
                flags: V2_FLAGS
            });
            return;
        }

        await defer(interaction, false);

        const grid = await buildCoverageGrid(config, zone, weeks);
        const worst = worstCells(grid, 5);

        if (sub === "gaps") {
            const container = new ContainerBuilder()
                .setAccentColor(COLOUR.pending)
                .addTextDisplayComponents(
                    text(headline("Coverage gaps", grid, config.accountingTimezone))
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
                            "their own evening, not at 3am." +
                            footnote(grid)
                    )
                );
            }

            await respond(interaction, containersMessage([container]));
            return;
        }

        const { gallery, attachment } = heatmapGallery(
            grid,
            "coverage",
            `A 7 by 24 grid of messages per available moderator, rendered in ${zone}.`
        );

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
                text(headline("Coverage heatmap", grid, config.accountingTimezone))
            )
            .addMediaGalleryComponents(gallery)
            .addSeparatorComponents(separator())
            .addTextDisplayComponents(
                text(
                    `**Five worst buckets**\n${worstText}\n\n` +
                        "-# Colour plots demand divided by coverage, never either alone. A quiet " +
                        "hour with one moderator is fine; a peak hour with one moderator is the gap." +
                        footnote(grid)
                )
            );

        await respond(interaction, {
            components: [container],
            files: [attachment],
            flags: V2_FLAGS
        });
    }
};
