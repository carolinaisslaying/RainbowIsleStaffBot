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
    buildMemberActivityGrid,
    busiestCells,
    weekdayLabels,
    worstCells,
    regionsInEveningDuring,
    type CoverageGrid
} from "../services/coverageService.js";
import { busiestRun, dailyProfile, quietestHour } from "../domain/observation.js";
import {
    gapLine,
    leaveHoursNote,
    memberEmptyNote,
    reliabilityNote,
    renderHeatmap,
    chartTitle,
    type HeatmapKind
} from "../render/heatmap.js";
import { isExecutive } from "../domain/permissions.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import {
    V2_FLAGS,
    containersMessage,
    errorCard,
    noticeCard,
    separator,
    text
} from "../render/cards.js";
import { staffDisplayName } from "../discord/displayName.js";
import { defer, respond } from "../discord/respond.js";
import { isValidTimezone, searchTimezones } from "../time/timezones.js";
import { COLOUR } from "../render/theme.js";
import { HOUR_MS } from "../time/calendar.js";

function hourLabel(hour: number): string {
    return `${String(hour).padStart(2, "0")}:00`;
}

function perHour(value: number): string {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}


/**
 * Zone, how much data, and the dates the window spans, whenever it spans any.
 * Keyed on the window rather than on hours heard: a member on leave for all of
 * it has none heard, and "the whole of this window" needs its dates beside it.
 */
/**
 * The card's heading. The zone, how much data and the dates are the chart's
 * own title (`chartTitle`), and printing them here as well put the same line
 * twice at the top of every coverage card. A card with no chart to show passes
 * its grid, and gets that line beneath the heading instead: a member on leave
 * for the whole window still needs to be told which window.
 */
function headline(title: string, withoutChart?: CoverageGrid): string {
    return withoutChart ? `## ${title}\n${chartTitle(withoutChart)}` : `## ${title}`;
}

/** The reliability note as a footnote, or nothing once there is enough data. */
function footnote(grid: CoverageGrid, kind: HeatmapKind = "coverage"): string {
    const note = reliabilityNote(grid.observedHours, kind);
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
        .setDescription("When the server is busy, and whether staff cover it (Executive)")
        .addSubcommand((sub) =>
            sub
                .setName("server")
                .setDescription("How active the server is, hour by hour")
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
        )
        .addSubcommand((sub) =>
            sub
                .setName("staff")
                .setDescription(
                    "Server activity against moderators on shift, and where to recruit"
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
        )
        .addSubcommand((sub) =>
            sub
                .setName("member")
                .setDescription("When one staff member is active, hour by hour")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("The staff member")
                        .setRequired(true)
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

    async execute({ client, config, interaction, staff, tier }) {
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

        if (sub === "server") {
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
                    text(
                        `${headline("Server activity", grid.maxDemand <= 0 ? grid : undefined)}\n` +
                            scope
                    )
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

        if (sub === "member") {
            const target = interaction.options.getUser("user", true);
            await defer(interaction, false);

            const member = await findStaffByDiscordId(target.id);
            if (!member) {
                await respond(
                    interaction,
                    noticeCard("No staff record", `<@${target.id}> is not tracked as Moderation staff.`)
                );
                return;
            }

            const name = await staffDisplayName(client, config, target.id, target.username);
            const grid = await buildMemberActivityGrid(config, member, zone, weeks);

            const container = new ContainerBuilder()
                .setAccentColor(COLOUR.report)
                .addTextDisplayComponents(
                    text(headline(`Activity: ${name}`, grid.maxDemand <= 0 ? grid : undefined))
                );

            if (grid.maxDemand <= 0) {
                container
                    .addSeparatorComponents(separator())
                    .addTextDisplayComponents(
                        text(
                            memberEmptyNote(
                                name,
                                grid.observedHours,
                                grid.leaveHours,
                                (grid.to.getTime() - grid.from.getTime()) / HOUR_MS
                            )
                        )
                    );
                await respond(interaction, containersMessage([container]));
                return;
            }

            const { gallery, attachment } = heatmapGallery(
                grid,
                "member",
                `A 7 by 24 grid of one staff member's average activity minutes per hour, ` +
                    `rendered in ${zone}.`
            );

            const busiest = busiestCells(grid, 5)
                .map(
                    (cell, index) =>
                        `${index + 1}. **${days[cell.weekday]} ${hourLabel(cell.hour)}** ` +
                        `${perHour(cell.demand)} minutes an hour`
                )
                .join("\n");

            container
                .addMediaGalleryComponents(gallery)
                .addSeparatorComponents(separator())
                .addTextDisplayComponents(
                    text(
                        `**Five most active hours**\n${busiest}` +
                            leaveHoursNote(grid.leaveHours) +
                            footnote(grid, "member")
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

        const { gallery, attachment } = heatmapGallery(
            grid,
            "coverage",
            `A 7 by 24 grid of messages per moderator on shift, with hours nobody was on ` +
                `ringed, rendered in ${zone}.`
        );

        // Each hour carries the regions where it falls in the evening: somebody
        // recruited there covers it at a sociable hour, not at 3am. This used to
        // be a subcommand of its own printing these same five hours.
        const worstText =
            grid.maxDemand === 0
                ? "_No demand recorded in the window. Check which channels are tracked._"
                : worst
                      .map((cell, index) => {
                          const regions = regionsInEveningDuring(
                              grid.from,
                              cell.weekday,
                              cell.hour,
                              zone,
                              config.weekStartDay
                          );
                          return (
                              `${index + 1}. **${days[cell.weekday]} ${hourLabel(cell.hour)}** ` +
                              gapLine(cell) +
                              "\n" +
                              (regions.length > 0
                                  ? "-# Evening in: " +
                                    regions
                                        .map((region) => `${region.label} (${region.localTime})`)
                                        .join(", ")
                                  : "-# No listed region is in its evening, 18:00 to 23:00.")
                          );
                      })
                      .join("\n");

        const container = new ContainerBuilder()
            .setAccentColor(COLOUR.report)
            .addTextDisplayComponents(
                text(headline("Server activity against staff"))
            )
            .addMediaGalleryComponents(gallery)
            .addSeparatorComponents(separator())
            .addTextDisplayComponents(
                text(
                    `**Five heaviest hours for moderators**\n${worstText}` +
                        (grid.typicalHour > 0
                            ? `\n\n-# Colour reads each moderator's load against a typical hour ` +
                              `here, ${perHour(grid.typicalHour)} messages: one moderator through ` +
                              "one reads gold, and burgundy is more than twice that. Time with " +
                              "nobody on shift lifts an hour up to three steps, in proportion, so " +
                              "an empty hour is never drawn as fine however quiet it was. Ringed " +
                              "hours had nobody on for most of the hour."
                            : "") +
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
