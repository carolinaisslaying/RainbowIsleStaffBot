import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags
} from "discord.js";
import { noticeCard, separator, text, V2_FLAGS, type RenderedMessage } from "./cards.js";
import { COLOUR } from "./theme.js";
import { EMOJI } from "./emoji.js";
import { PREVIEW_FILE } from "./sotwPreview.js";

/**
 * Every Staff of the Week card. Mint and the trophy, from the palette, so
 * nothing here picks a colour or a mark at the call site.
 */

export function sotwCard(title: string, body: string, options: { ephemeral?: boolean } = {}): RenderedMessage {
    return noticeCard(title, body, { colour: COLOUR.staffOfWeek, ephemeral: options.ephemeral });
}

export interface Leader {
    name: string;
    minutes: number;
    pendingLeave: boolean;
}

const leaderLine = (leader: Leader, index: number) =>
    `${index + 1}. **${leader.name}** ${leader.minutes} min` +
    (leader.pendingLeave ? ` (${EMOJI.warning} has a leave request for that week waiting for a decision)` : "");

export function reminderCard(input: {
    nextWeekLabel: string;
    decision: string;
    barred: string[];
    leaders: Leader[];
    target: number;
    setCommand: string;
}): RenderedMessage {
    const lines = [
        `### ${EMOJI.staffOfWeek} Staff of the Week: next week`,
        input.nextWeekLabel,
        input.decision,
        "### Cannot be picked next week",
        input.barred.length > 0 ? input.barred.map((name) => `- ${name}`).join("\n") : "Nobody.",
        "### Most active this week so far",
        input.leaders.length > 0
            ? input.leaders.map(leaderLine).join("\n")
            : "_Nobody who can be picked has any minutes yet._",
        `-# The weekly minimum is ${input.target} minutes. You can pick somebody who has not met it.`,
        `Pick somebody with ${input.setCommand}, or skip the week.`
    ];
    return {
        components: [new ContainerBuilder().setAccentColor(COLOUR.staffOfWeek).addTextDisplayComponents(text(lines.join("\n")))],
        files: [],
        flags: V2_FLAGS
    };
}

/**
 * `staffId` rides in the Rest/Next customIds so a second `/sotw set` for
 * somebody else, run while this card is still sitting there, cannot have its
 * pick honoured by a press on the stale card: `handleSotwButton` refuses
 * unless the id on the button matches what is actually staged. Cancel needs
 * no id — it clears whatever is staged, stale or not.
 */
export function weekChoiceCard(input: {
    staffId: string;
    name: string;
    currentLabel: string;
    nextLabel: string;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        .addTextDisplayComponents(
            text(
                `### ${EMOJI.staffOfWeek} Which week for ${input.name}?\n` +
                    "Nobody is Staff of the Week right now.\n" +
                    `**Rest of this week** (${input.currentLabel}) gives them the role now.\n` +
                    `**Next week** (${input.nextLabel}) gives them the role when that week starts.`
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sotw:rest:${input.staffId}`)
                    .setLabel("Rest of this week")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`sotw:next:${input.staffId}`)
                    .setLabel("Next week")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("sotw:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
            )
        );
    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

export type HandoffSummary =
    | { kind: "picked"; holder: string; by: string }
    | { kind: "random"; holder: string; pool: string[]; failedPick: string | null }
    | { kind: "skipped"; by: string }
    /** `midWeek`: finished after the week began, when there is never a draw. */
    | { kind: "empty"; failedPick: string | null; midWeek?: boolean };

export function handoffText(summary: HandoffSummary): string {
    const failed = (reason: string | null) =>
        reason ? `\n${EMOJI.warning} The person who was picked could not have it. ${reason}` : "";
    switch (summary.kind) {
        case "picked":
            return `**${summary.holder}** is Staff of the Week, picked by ${summary.by}.`;
        case "random":
            return (
                `**${summary.holder}** is Staff of the Week, drawn at random from ` +
                `${summary.pool.map((name) => `**${name}**`).join(", ")}.` +
                failed(summary.failedPick)
            );
        case "skipped":
            return `Nobody is Staff of the Week this week. ${summary.by} skipped it.`;
        case "empty":
            if (summary.midWeek) {
                return (
                    "Nobody is Staff of the Week this week. The bot did not hand it over before the " +
                    "week started, and it does not draw a name once a week has begun." +
                    failed(summary.failedPick)
                );
            }
            return (
                "Nobody is Staff of the Week this week. Nobody who could be picked met the weekly " +
                "minimum last week, so there was nobody to draw from." +
                failed(summary.failedPick)
            );
    }
}

export function viewCard(input: {
    current: string;
    next: string;
    history: string[];
    eligible: Leader[];
    target: number;
}): RenderedMessage {
    const lines = [
        `## ${EMOJI.staffOfWeek} Staff of the Week`,
        "### This week",
        input.current,
        "### Next week",
        input.next,
        "### Recent weeks",
        input.history.length > 0 ? input.history.join("\n") : "Nothing recorded yet.",
        "### Can be picked next week",
        input.eligible.length > 0 ? input.eligible.map(leaderLine).join("\n") : "Nobody.",
        `-# Minutes are this week's so far. The weekly minimum is ${input.target}.`
    ];
    return {
        components: [new ContainerBuilder().setAccentColor(COLOUR.staffOfWeek).addTextDisplayComponents(text(lines.join("\n")))],
        files: [],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}

export type ColourStatusLine = "holding" | "saved" | "executive";

export function colourStatusText(status: ColourStatusLine): string {
    switch (status) {
        case "holding":
            return "You are Staff of the Week, so saving changes the role's colour now.";
        case "saved":
            return "Your colour goes on the role the next time you are Staff of the Week.";
        case "executive":
            return "Executives cannot be Staff of the Week, so this colour is only used if that changes.";
    }
}

export function colourSettingsCard(input: {
    status: ColourStatusLine;
    savedLabel: string;
    staged: { label: string } | null;
    pickerUrl: string | null;
    preview: { png: Buffer; alt: string } | null;
    message: string | null;
    note: string | null;
}): RenderedMessage {
    const heading = input.staged
        ? `### ${EMOJI.staffOfWeek} Save this colour?\n**${input.staged.label}**`
        : `### ${EMOJI.staffOfWeek} Your Staff of the Week colour\n**${input.savedLabel}**`;

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        // After a save or a refused code, the message is the news; the status
        // line would only say the same thing again above the picture.
        .addTextDisplayComponents(text(input.message ? heading : `${heading}\n${colourStatusText(input.status)}`));

    const files: AttachmentBuilder[] = [];
    if (input.preview) {
        files.push(new AttachmentBuilder(input.preview.png, { name: PREVIEW_FILE, description: input.preview.alt }));
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${PREVIEW_FILE}`).setDescription(input.preview.alt)
            )
        );
    }

    const notes = [input.note ? `${EMOJI.warning} ${input.note}` : null, input.message].filter(Boolean);
    if (notes.length > 0) container.addTextDisplayComponents(text(notes.join("\n")));

    container.addSeparatorComponents(separator());
    const buttons = input.staged
        ? [
              new ButtonBuilder().setCustomId("sotwColour:save").setLabel("Save").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId("sotwColour:code").setLabel("Edit").setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId("sotwColour:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
          ]
        : [
              ...(input.pickerUrl
                  ? [new ButtonBuilder().setURL(input.pickerUrl).setLabel("Open colour picker ↗").setStyle(ButtonStyle.Link)]
                  : []),
              new ButtonBuilder().setCustomId("sotwColour:code").setLabel("Enter code").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("sotwColour:clear").setLabel("Clear colour").setStyle(ButtonStyle.Secondary)
          ];
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

    return { components: [container], files, flags: V2_FLAGS | MessageFlags.Ephemeral };
}

export function congratsCard(input: {
    message: string;
    colourLine: string;
    preview: { png: Buffer; alt: string } | null;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        .addTextDisplayComponents(text(`## ${EMOJI.staffOfWeek} Staff of the Week\n${input.message}`));
    const files: AttachmentBuilder[] = [];
    if (input.preview) {
        files.push(new AttachmentBuilder(input.preview.png, { name: PREVIEW_FILE, description: input.preview.alt }));
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${PREVIEW_FILE}`).setDescription(input.preview.alt)
            )
        );
    }
    container.addTextDisplayComponents(text(`-# ${input.colourLine}`));
    return { components: [container], files, flags: V2_FLAGS };
}
