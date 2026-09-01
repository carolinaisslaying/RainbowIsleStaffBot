import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder
} from "discord.js";
import type { APIMessageTopLevelComponent, JSONEncodable } from "discord.js";
import type { LeaveStatus, ReviewOutcome, RingState } from "../db/types.js";
import { cmd } from "../discord/commandMentions.js";
import { RING_STATE_COLOUR, RING_STATE_LABEL } from "../domain/rings.js";
import {
    describeRings,
    renderRingCard,
    ringsCacheKey,
    type RingsInput
} from "./rings.js";
import { describeFaces, renderFacePicker } from "./facePicker.js";
import { formatDuration, formatMinutes, percent, ts } from "../time/format.js";
import type { ReviewAction } from "../domain/review.js";
import { emojiForColour } from "./emoji.js";
import { COLOUR } from "./theme.js";

/**
 * The one place builders are constructed. Command handlers call these and never
 * build components inline, so the 40 component ceiling and the IsComponentsV2
 * constraints are enforced in a single file.
 *
 * With IsComponentsV2 set, content, embeds, poll and stickers are unavailable.
 * Nothing in this module may reach for them.
 */

export const V2_FLAGS = MessageFlags.IsComponentsV2;
export const MAX_COMPONENTS = 40;

/** Anything a Components V2 message may carry at the top level. */
export type TopLevelComponent = JSONEncodable<APIMessageTopLevelComponent>;

export interface RenderedMessage {
    components: TopLevelComponent[];
    files: AttachmentBuilder[];
    flags: number;
}

export function ephemeral(message: RenderedMessage): RenderedMessage & { flags: number } {
    return { ...message, flags: message.flags | MessageFlags.Ephemeral };
}

export function text(value: string): TextDisplayBuilder {
    return new TextDisplayBuilder().setContent(value);
}

export function separator(large = false): SeparatorBuilder {
    return new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

/**
 * A plain notice. Used for refusals, confirmations and errors.
 *
 * The leading emoji comes from the colour rather than from the caller, so the
 * forty-odd cards that already say what state they are in by their accent get
 * the matching mark for free and cannot drift from it. `emoji` overrides that
 * for the handful of cards whose state the palette does not distinguish: a
 * shift starting and leave being approved are both green.
 */
export function noticeCard(
    title: string,
    body: string,
    options: { colour?: number; ephemeral?: boolean; emoji?: string } = {}
): RenderedMessage {
    const colour = options.colour ?? COLOUR.admin;
    const mark = options.emoji ?? emojiForColour(colour);
    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(text(`### ${mark} ${title}\n${body}`));

    return {
        components: [container],
        files: [],
        flags: V2_FLAGS | (options.ephemeral ? MessageFlags.Ephemeral : 0)
    };
}

export function errorCard(body: string): RenderedMessage {
    return noticeCard("That did not work", body, {
        colour: COLOUR.adverse,
        ephemeral: true
    });
}

export interface RingCardInput {
    staffId: string;
    displayName: string;
    /** The subject's chosen ring face. Theirs, not the viewer's. */
    face?: string | null;
    weekStart: Date;
    weekEnd: Date;
    activityMinutes: number;
    activityTarget: number;
    shiftMs: number;
    shiftTargetHours: number;
    activeDays: number;
    activeDaysTarget: number;
    state: RingState;
    softRingsEnabled: boolean;
    streak?: number;
    heading?: string;
    footnote?: string;
}

function ringsInputFor(input: RingCardInput): RingsInput {
    const shiftHours = input.shiftMs / 3_600_000;
    return {
        face: input.face,
        activityMinutes: input.activityMinutes,
        activityTarget: input.activityTarget,
        shiftHours,
        shiftTarget: input.shiftTargetHours,
        activeDays: input.activeDays,
        activeDaysTarget: input.activeDaysTarget,
        state: input.state,
        softRingsEnabled: input.softRingsEnabled,
        cacheKey: ringsCacheKey(input.staffId, input.weekStart, {
            activityMinutes: input.activityMinutes,
            shiftHours: Math.round(shiftHours * 100) / 100,
            activeDays: input.activeDays,
            state: input.state,
            softRingsEnabled: input.softRingsEnabled,
            face: input.face
        })
    };
}

/**
 * The figures block. Colour never carries meaning alone, so every ring card
 * states the numbers in text as well.
 */
/**
 * The figures, as a sentence.
 *
 * The image beside this already lists every ring and its progress, so the text
 * exists to say the same thing without relying on colour or on the picture
 * loading. Prose rather than a fenced table: a member reading their own week
 * should not be looking at something shaped like terminal output.
 */
export function ringFigures(input: RingCardInput): string {
    const lines = [
        `**${input.activityMinutes} of ${input.activityTarget} activity minutes** ` +
            `this week, ${RING_STATE_LABEL[input.state]}.`
    ];

    if (input.streak !== undefined && input.streak > 0) {
        lines.push(
            input.streak === 1
                ? "First week running at target."
                : `**${input.streak} weeks** running at target.`
        );
    }
    return lines.join("\n");
}

/**
 * Status card. The labelled ring image does the explaining; the text says the
 * headline figure and when the week closes.
 */
export function ringCard(input: RingCardInput): RenderedMessage {
    const rings = ringsInputFor(input);
    const png = renderRingCard(rings);
    const fileName = `rings-${input.staffId}-${input.weekStart.getTime()}.png`;
    const attachment = new AttachmentBuilder(png, {
        name: fileName,
        description: describeRings(rings)
    });

    const container = new ContainerBuilder()
        .setAccentColor(RING_STATE_COLOUR[input.state])
        .addTextDisplayComponents(
            text(`${input.heading ?? `## ${input.displayName}`}\n${ringFigures(input)}`)
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${fileName}`)
                    .setDescription(describeRings(rings))
            )
        )
        .addTextDisplayComponents(
            text(`-# Week closes ${ts(input.weekEnd, "R")}`)
        );

    if (input.footnote) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(text(`-# ${input.footnote}`));
    }

    return { components: [container], files: [attachment], flags: V2_FLAGS };
}

/** Retained for callers that asked for the gallery form explicitly. */
export function ringGalleryCard(input: RingCardInput): RenderedMessage {
    return ringCard(input);
}

export interface ShiftSummaryInput extends RingCardInput {
    durationMs: number;
    pausedMs: number;
    earnedMinutes: number;
    reasonLabel: string;
    startedAt: Date;
    endedAt: Date;
}

export function shiftSummaryCard(input: ShiftSummaryInput): RenderedMessage {
    const card = ringCard({
        ...input,
        heading: `## Shift ended, ${input.reasonLabel}`,
        footnote: undefined
    });

    const summary = [
        `**${formatMinutes(input.earnedMinutes)}** earned this shift.`,
        `Ran ${ts(input.startedAt, "t")} to ${ts(input.endedAt, "t")}, ` +
            `${formatDuration(input.durationMs)} in total. ` +
            (input.pausedMs > 0 ? `Paused for ${formatDuration(input.pausedMs)}.` : "Never paused."),
        "",
        "-# Shift time measures availability, activity minutes measure participation. " +
            "Only the second counts toward compliance."
    ].join("\n");

    const container = card.components[0] as ContainerBuilder;
    container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(text(summary));
    return card;
}

export interface LeaderboardRowView {
    rank: number;
    label: string;
    activityMinutes: number;
    target: number;
    state: RingState;
    isViewer: boolean;
    onLeave: boolean;
    /** Opted out of public listing. Only a privileged viewer ever sees this row. */
    hidden?: boolean;
}

export interface LeaderboardCardOptions {
    title: string;
    windowLabel: string;
    rows: LeaderboardRowView[];
    viewerRow: LeaderboardRowView | null;
    page: number;
    pageCount: number;
    scope: string;
    totalMinutes: number;
    participants: number;
    footnote?: string;
    /** The viewer's own rings, shown beside their pinned row. */
    viewerRings?: { png: Buffer; alt: string };
}

export function leaderboardCard(options: LeaderboardCardOptions): RenderedMessage {
    const files: AttachmentBuilder[] = [];

    // One line per row, and nothing but rows between them. Discord ends an
    // ordered list at the first line that does not open with a number, so a
    // wrapped second line would split the list and restart the numbering.
    const renderRow = (row: LeaderboardRowView) => {
        const trailing = row.onLeave
            ? "on leave"
            : `${row.activityMinutes} min, ${percent(row.activityMinutes, row.target)}%`;
        const suffix = row.isViewer ? " (you)" : row.hidden ? " (hidden)" : "";
        return `${row.rank}. **${row.label}**${suffix} ${trailing}`;
    };

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.standings)
        .addTextDisplayComponents(
            text(
                `## ${options.title}\n${options.windowLabel}\n` +
                    `-# ${options.participants} tracked, ` +
                    `${formatMinutes(options.totalMinutes)} between them`
            )
        )
        .addSeparatorComponents(separator());

    if (options.rows.length === 0) {
        container.addTextDisplayComponents(
            text("_Nobody has recorded activity minutes in this window yet._")
        );
    } else {
        container.addTextDisplayComponents(text(options.rows.map(renderRow).join("\n")));
    }

    // The viewer's own row is pinned at the bottom regardless of position, with
    // their rings beside it so the card always tells them where they stand.
    if (options.viewerRow) {
        container.addSeparatorComponents(separator(true));
        const summary = `**Your position**\n${renderRow(options.viewerRow)}`;

        if (options.viewerRings) {
            const fileName = `leaderboard-rings-${options.scope}.png`;
            files.push(
                new AttachmentBuilder(options.viewerRings.png, {
                    name: fileName,
                    description: options.viewerRings.alt
                })
            );
            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(text(summary))
                    .setThumbnailAccessory(
                        new ThumbnailBuilder()
                            .setURL(`attachment://${fileName}`)
                            .setDescription(options.viewerRings.alt)
                    )
            );
        } else {
            container.addTextDisplayComponents(text(summary));
        }
    }

    if (options.footnote) {
        container.addTextDisplayComponents(text(`-# ${options.footnote}`));
    }

    const components: TopLevelComponent[] = [container];
    if (options.pageCount > 1) {
        container.addSeparatorComponents(separator());
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`leaderboard:${options.scope}:${options.page - 1}`)
                    .setLabel("Previous")
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(options.page <= 1),
                new ButtonBuilder()
                    .setCustomId("leaderboard:noop:0")
                    .setLabel(`${options.page} of ${options.pageCount}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`leaderboard:${options.scope}:${options.page + 1}`)
                    .setLabel("Next")
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(options.page >= options.pageCount)
            )
        );
    }

    return { components, files, flags: V2_FLAGS };
}

export interface ReviewRowInput {
    assessmentId: string;
    displayName: string;
    week1Minutes: number;
    week2Minutes: number;
    totalMinutes: number;
    requiredMinutes: number;
    /** Plain English history. Never a fortnight index. */
    priorOutcomes: string;
    /** What the next warning would be. Surfaced, never acted on. */
    warningWeight: string;
    /** Which buttons to draw, decided by domain/review.ts. */
    buttons: ReviewAction[];
    outcome: ReviewOutcome | null;
    /** Who decided, when, and why. The card is the log, so this stays on it. */
    decidedLine: string | null;
    reason: string | null;
    acknowledgedLine: string | null;
    departed: boolean;
    rehearsal: boolean;
    /** Set when a recompute has moved them above the requirement since. */
    contradiction: string | null;
    /** Their recent fortnights, drawn. Omitted while there is nothing to plot. */
    trend?: { png: Buffer; alt: string } | null;
}

const REVIEW_OUTCOME_COLOUR: Record<ReviewOutcome, number> = {
    warned: COLOUR.pending,
    excused: COLOUR.approved,
    dismissed: COLOUR.settled
};

const REVIEW_BUTTON: Record<
    ReviewAction,
    { label: string; style: ButtonStyle }
> = {
    warn: { label: "Issue warning", style: ButtonStyle.Danger },
    excuse: { label: "Excuse", style: ButtonStyle.Secondary },
    dismiss: { label: "Dismiss", style: ButtonStyle.Secondary },
    reopen: { label: "Reopen", style: ButtonStyle.Secondary }
};

/**
 * One member's row, which is also that member's permanent record of the
 * fortnight.
 *
 * It lives in its own message and is edited in place for the rest of its life,
 * so the queue and the log are the same object at two points in it. The
 * previous design batched every row into one message, which meant a decision
 * could only be shown by disabling buttons across the whole message: deciding
 * one member took everybody else's buttons with them.
 *
 * Colour is the state, as everywhere else: red is waiting on a human, amber a
 * warning, green an excusal, grey filed with nothing left to do.
 */
export function reviewRowCard(row: ReviewRowInput): ContainerBuilder {
    const shortfall = Math.max(0, row.requiredMinutes - row.totalMinutes);
    const reached = percent(row.totalMinutes, row.requiredMinutes);
    const colour = row.outcome ? REVIEW_OUTCOME_COLOUR[row.outcome] : COLOUR.adverse;

    const lines = [
        `**${row.displayName}**`,
        `**${row.totalMinutes} of ${row.requiredMinutes} minutes** (${reached}%), ` +
            `short by **${shortfall}**`,
        `-# Week one ${row.week1Minutes} min, week two ${row.week2Minutes} min`,
        `-# Earlier fortnights: ${row.priorOutcomes}`
    ];

    if (row.departed) {
        lines.push("-# ⚠️ No longer in the server. They cannot be warned, only cleared.");
    }

    // Said before the click, not after it. The bot counts and surfaces; it
    // never escalates by itself.
    if (!row.outcome) lines.push(`-# ${row.warningWeight}`);

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(text(lines.join("\n")));

    if (row.outcome && row.decidedLine) {
        container.addSeparatorComponents(separator());
        const settled = [`${emojiForColour(colour)} **${row.decidedLine}**`];
        if (row.reason) settled.push(`> ${row.reason}`);
        if (row.acknowledgedLine) settled.push(`-# ${row.acknowledgedLine}`);
        if (row.rehearsal) {
            settled.push("-# Rehearsal. Nothing was recorded against them and nobody was told.");
        }
        container.addTextDisplayComponents(text(settled.join("\n")));
    }

    if (row.contradiction) {
        container.addTextDisplayComponents(text(`-# ${row.contradiction}`));
    }

    // Above the buttons, because it is what the buttons are about: whether this
    // fortnight is a pattern or a one-off is the decision, and "0 of 240" reads
    // the same either way.
    if (row.trend) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${trendFileName(row.assessmentId)}`)
                    .setDescription(row.trend.alt)
            )
        );
    }

    if (row.buttons.length > 0) {
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                ...row.buttons.map((action) =>
                    new ButtonBuilder()
                        .setCustomId(`review:${row.assessmentId}:${action}`)
                        .setLabel(REVIEW_BUTTON[action].label)
                        .setStyle(REVIEW_BUTTON[action].style)
                )
            )
        );
    }

    return container;
}

export function trendFileName(assessmentId: string): string {
    return `trend-${assessmentId}.png`;
}

/** The row as its own message, which is how it is actually posted. */
export function reviewRowMessage(row: ReviewRowInput): RenderedMessage {
    return {
        components: [reviewRowCard(row)],
        files: row.trend
            ? [
                  new AttachmentBuilder(row.trend.png, {
                      name: trendFileName(row.assessmentId),
                      description: row.trend.alt
                  })
              ]
            : [],
        flags: V2_FLAGS
    };
}

export interface ReviewHeaderInput {
    fortnightIndex: number;
    windowLabel: string;
    headline: string;
    remaining: number;
    rehearsal: boolean;
    /** How the whole team did this fortnight. Omitted when nobody was assessed. */
    spread?: { png: Buffer; alt: string } | null;
}

/**
 * The queue's own message, edited as the queue is worked so the count at the
 * top is the count that is actually left.
 */
export function reviewHeaderCard(input: ReviewHeaderInput): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(input.remaining > 0 ? COLOUR.pending : COLOUR.settled)
        .addTextDisplayComponents(
            text(
                `## ${input.remaining > 0 ? "⏳" : "📁"} Fortnight review\n` +
                    `${input.windowLabel}\n${input.headline}\n` +
                    (input.rehearsal
                        ? "-# **Rehearsal.** Every decision below is recorded against a " +
                          "throwaway record and only Executives are messaged. Turn off the " +
                          "assessment dry run to make a review real."
                        : "-# The bot issues no warnings. Every outcome below is an Executive " +
                          "decision, and every one asks why.")
            )
        );

    // Whether 120 minutes is bad depends on what everybody else managed, and the
    // queue below cannot say: it only ever lists the people who fell short.
    if (input.spread) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${SPREAD_FILE}`)
                    .setDescription(input.spread.alt)
            )
        );
    }

    if (input.remaining > 0) {
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:ask`)
                    .setLabel(`Decide all ${input.remaining} remaining`)
                    .setStyle(ButtonStyle.Secondary)
            )
        );
    }

    return {
        components: [container],
        files: input.spread
            ? [
                  new AttachmentBuilder(input.spread.png, {
                      name: SPREAD_FILE,
                      description: input.spread.alt
                  })
              ]
            : [],
        flags: V2_FLAGS
    };
}

const SPREAD_FILE = "fortnight-spread.png";

/**
 * The second click on deciding a whole queue at once.
 *
 * It names every member it would touch rather than counting them, because the
 * whole objection to a bulk action is that it applies a decision to people
 * without reading them. Naming them is the least it can do.
 */
export function reviewBulkConfirmCard(input: {
    fortnightIndex: number;
    names: string[];
    skipped: string[];
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(
                `### ⏳ Decide ${input.names.length} remaining ` +
                    `${input.names.length === 1 ? "row" : "rows"} at once?\n` +
                    input.names.map((name) => `- ${name}`).join("\n") +
                    (input.skipped.length > 0
                        ? `\n\n-# Skipped, because you cannot warn yourself: ` +
                          `${input.skipped.join(", ")}. Excuse or dismiss instead.`
                        : "") +
                    "\n\nPick the outcome. You will be asked for one reason, and it is " +
                    "recorded against every row above."
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:warn`)
                    .setLabel("Warn all")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:excuse`)
                    .setLabel("Excuse all")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:dismiss`)
                    .setLabel("Dismiss all")
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:cancel`)
                    .setLabel("Leave them")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * The warning as the member receives it.
 *
 * It carries the Executive's own words rather than a generated line, because a
 * warning nobody explained is a warning nobody can appeal. The Acknowledge
 * button is the member saying they have read it: the row card and the warnings
 * view then show the difference between unread and ignored, which is the only
 * thing an Executive can fairly act on later.
 */
export function warningDmCard(input: {
    warningId: string;
    windowLabel: string;
    totalMinutes: number;
    requiredMinutes: number;
    reason: string;
}): RenderedMessage {
    const shortfall = Math.max(0, input.requiredMinutes - input.totalMinutes);
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.adverse)
        .addTextDisplayComponents(
            text(
                `### ${emojiForColour(COLOUR.adverse)} You have been issued a warning\n` +
                    `Fortnight ${input.windowLabel}. You recorded ` +
                    `**${input.totalMinutes} of ${input.requiredMinutes} activity minutes**, ` +
                    `short by **${shortfall}**.\n\n` +
                    `**Why**\n> ${input.reason}\n\n` +
                    "If you think this is wrong, or something was going on we should know " +
                    "about, reply to the Executive team.\n\n" +
                    `-# You can see everything held about you with ${cmd("mydata export")}.`
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`warning:${input.warningId}:ack`)
                    .setLabel("I have read this")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS };
}

/**
 * A member's warning record.
 *
 * Ordered newest first and always ephemeral, whoever is reading. A spent
 * warning is shown rather than hidden: it is still part of what happened, it
 * just no longer counts, and hiding it would make the record disagree with the
 * member's own memory of it.
 */
export function warningsCard(input: {
    displayName: string;
    isSelf: boolean;
    activeCount: number;
    expiryDays: number;
    rows: {
        issuedAt: Date;
        issuedBy: string;
        note: string;
        acknowledged: boolean;
        spent: boolean;
    }[];
    historyLine: string;
    windowLabel: (start: Date, end: Date) => string;
}): RenderedMessage {
    const clean = input.rows.length === 0;
    const container = new ContainerBuilder()
        .setAccentColor(input.activeCount > 0 ? COLOUR.pending : COLOUR.approved)
        .addTextDisplayComponents(
            text(
                `## ${emojiForColour(input.activeCount > 0 ? COLOUR.pending : COLOUR.approved)} ` +
                    `${input.isSelf ? "Your warnings" : `Warnings: ${input.displayName}`}\n` +
                    (clean
                        ? input.isSelf
                            ? "You have never been warned. Nothing is on your record."
                            : "They have never been warned. Nothing is on their record."
                        : `**${input.activeCount}** currently count` +
                          `${input.activeCount === 1 ? "s" : ""}, of ${input.rows.length} ` +
                          `ever issued.\n-# A warning stops counting after ` +
                          `${input.expiryDays} days. It stays on the record either way.`)
            )
        );

    for (const row of input.rows) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                `**${ts(row.issuedAt, "D")}**` +
                    (row.spent ? " · _spent_" : "") +
                    `, by ${row.issuedBy}\n> ${row.note}\n` +
                    `-# ${row.acknowledged ? "Acknowledged" : "Not acknowledged"}`
            )
        );
    }

    container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(
        text(`-# **Recent fortnights**\n-# ${input.historyLine}`)
    );

    return {
        components: [container],
        files: [],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}

/**
 * The confirmation before scrubbing assessment records.
 *
 * Deleting is rare here on purpose, so the card counts what would go and names
 * how many people it touches rather than asking "are you sure". The audit row
 * is written before the delete, which is the only reason this is offered as a
 * button at all.
 */
export function scrubConfirmCard(input: {
    fortnight: number | null;
    assessments: number;
    warnings: number;
    /** Of those assessments, how many were written by a rehearsal. */
    rehearsals: number;
    members: number;
    /** Rehearse the fortnight again once it is cleared. */
    rerun: boolean;
}): RenderedMessage {
    const scope =
        input.fortnight === null
            ? "every fortnight before the anchor"
            : `fortnight ${input.fortnight}`;

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.adverse)
        .addTextDisplayComponents(
            text(
                `### ${EMOJI_SCRUB} Delete the records for ${scope}?\n` +
                    `**${input.assessments}** assessment${input.assessments === 1 ? "" : "s"} ` +
                    `across **${input.members}** member${input.members === 1 ? "" : "s"}` +
                    (input.warnings > 0
                        ? `, and **${input.warnings}** warning` +
                          `${input.warnings === 1 ? "" : "s"} issued from them`
                        : ", and no warnings") +
                    ".\n\n" +
                    (input.rehearsals === input.assessments
                        ? "Every one of them was written by a rehearsal.\n\n"
                        : input.rehearsals > 0
                          ? `**${input.rehearsals}** of them came from a rehearsal; the rest ` +
                            "are real records of real fortnights.\n\n"
                          : "**None of them came from a rehearsal.** These are real records " +
                            "of real fortnights.\n\n") +
                    "Their cards in the review channel are deleted too, so a re-run is read " +
                    "on its own rather than against what is left of the last one.\n\n" +
                    "The audit log keeps everything they held, written before anything is " +
                    "removed. Nothing else in the database refers to them: rollups are " +
                    "rebuilt from raw activity, which this does not touch." +
                    (input.rerun
                        ? "\n\nThe fortnight is rehearsed again straight afterwards."
                        : "")
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`scrub:${input.fortnight ?? "pre"}:${input.rerun ? "goRerun" : "go"}`)
                    .setLabel(input.rerun ? `Delete ${input.assessments} and re-run` : `Delete ${input.assessments}`)
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`scrub:${input.fortnight ?? "pre"}:cancel`)
                    .setLabel("Leave them")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

const EMOJI_SCRUB = "🗑️";

/**
 * The team's week, for the recap channel.
 *
 * Deliberately not a roster: the personal recap already tells each member their
 * own figures, and a channel post repeating them is a leaderboard with extra
 * steps, which the leaderboard already is. What a channel can say that a DM
 * cannot is how the week went for everybody at once.
 *
 * No individual is named except the longest streak, which is the one figure
 * that is unambiguously good news and reads as recognition rather than as a
 * ranking.
 */
export function teamRecapCard(input: {
    windowLabel: string;
    headline: string;
    totalMinutes: string;
    medianMinutes: number;
    meanMinutes: number;
    targetMinutes: number;
    topStreak: { mention: string; weeks: number } | null;
    spread: { png: Buffer; alt: string } | null;
    rehearsal: boolean;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.report)
        .addTextDisplayComponents(
            text(
                `## ${emojiForColour(COLOUR.report)} The week in review\n` +
                    `${input.windowLabel}\n${input.headline}\n` +
                    `-# ${input.totalMinutes} between everyone. Median ` +
                    `${input.medianMinutes} min, average ${input.meanMinutes}, against a ` +
                    `${input.targetMinutes} minute target.`
            )
        );

    if (input.spread) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${TEAM_RECAP_FILE}`)
                    .setDescription(input.spread.alt)
            )
        );
    }

    if (input.topStreak && input.topStreak.weeks > 1) {
        container.addTextDisplayComponents(
            text(
                `-# Longest run going: ${input.topStreak.mention}, ` +
                    `${input.topStreak.weeks} weeks unbroken.`
            )
        );
    }

    container.addTextDisplayComponents(
        text(
            input.rehearsal
                ? "-# **Rehearsal.** This was not posted to the recap channel."
                : "-# Everyone has their own figures by direct message."
        )
    );

    return {
        components: [container],
        files: input.spread
            ? [
                  new AttachmentBuilder(input.spread.png, {
                      name: TEAM_RECAP_FILE,
                      description: input.spread.alt
                  })
              ]
            : [],
        flags: V2_FLAGS
    };
}

const TEAM_RECAP_FILE = "team-week.png";

/**
 * The leave request as it appears in the log channel, in each of the three
 * states it passes through.
 *
 * Pending it offers a decision. Decided it records one, and offers the purge
 * that removes the record entirely. Purged it keeps everything it said and adds
 * who removed it, so the channel still reads as a record of what was decided
 * rather than going quiet about a request that once existed.
 */
/**
 * How each state of a leave record is coloured.
 *
 * Colour never carries meaning alone, and every card below also says its state
 * in words. But the channel is read at a glance and scrolled past, so the
 * glance should be right. Amber is a decision waiting on a human, green a yes, red a
 * no, blue something running by itself, grey something finished with nothing
 * left to do.
 */
const LEAVE_STATUS_COLOUR: Record<LeaveStatus, number> = {
    pending: COLOUR.pending,
    approved: COLOUR.approved,
    declined: COLOUR.adverse,
    active: COLOUR.inProgress,
    ended: COLOUR.settled
};

const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
    pending: "Waiting on an Executive",
    approved: "Approved, not started yet",
    declined: "Declined",
    active: "On leave now",
    ended: "Back"
};

export function leaveRequestCard(options: {
    leaveId: string;
    displayName: string;
    startDate: Date;
    endDate: Date | null;
    reason: string;
    status: LeaveStatus;
    decided: string | null;
    /** What became of the leave itself: ended early, ran its course, came back. */
    outcome?: string | null;
    purged?: string | null;
}): RenderedMessage {
    // A purged record is grey whatever state it was decided in, so the mark
    // follows the colour the card is actually drawn in rather than the status
    // it still reports.
    const colour = options.purged ? COLOUR.settled : LEAVE_STATUS_COLOUR[options.status];

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(
            text(
                `## ${emojiForColour(colour)} Leave request\n` +
                    `**${options.displayName}**\n` +
                    `-# ${LEAVE_STATUS_LABEL[options.status]}\n` +
                    `From ${ts(options.startDate, "f")} ` +
                    `to ${options.endDate ? ts(options.endDate, "f") : "**open ended**"}` +
                    (options.endDate && options.status !== "ended"
                        ? `, ending ${ts(options.endDate, "R")}`
                        : "") +
                    `\n\n**Reason**\n${options.reason}`
            )
        );

    if (options.decided) {
        // The decision replaces the buttons in place, so the channel keeps one
        // card per request rather than a stub above an outcome.
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(text(options.decided));
    }

    if (options.outcome) {
        container.addTextDisplayComponents(text(options.outcome));
    }

    if (options.purged) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                `-# ${options.purged}\n-# The record is gone. The audit log retains what it ` +
                    "held."
            )
        );
        // No buttons: there is nothing left to act on, and a button that can
        // only ever answer "already gone" is worse than no button at all.
        return { components: [container], files: [], flags: V2_FLAGS };
    }

    const buttons: ButtonBuilder[] = [];

    if (options.status === "pending") {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`leave:${options.leaveId}:approve`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`leave:${options.leaveId}:decline`)
                .setLabel("Decline")
                .setStyle(ButtonStyle.Danger)
        );
    }

    // Leave that is running, or approved and about to, is the only leave there
    // is anything to end. The label says what the click does rather than naming
    // the state it moves to: an Executive pressing this is bringing someone
    // back, today, whatever the record says about next Friday.
    if (options.status === "approved" || options.status === "active") {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`leave:${options.leaveId}:end`)
                .setLabel(options.status === "active" ? "Bring them back now" : "Cancel this leave")
                .setStyle(ButtonStyle.Secondary)
        );
    }

    if (options.status !== "pending") {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`leavePurge:${options.leaveId}:ask`)
                .setLabel("Purge this record")
                .setStyle(ButtonStyle.Danger)
        );
    }

    if (buttons.length > 0) {
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)
        );
    }

    return { components: [container], files: [], flags: V2_FLAGS };
}

/**
 * The second click on ending someone's leave early.
 *
 * Ending leave restores ranks, restarts assessment and tells the member they
 * are back, all at once and all to somebody who is not in the room. That is
 * worth one confirmation, and the confirmation names the person and the date
 * being cut short rather than asking "are you sure".
 */
export function leaveEndConfirmCard(options: {
    leaveId: string;
    displayName: string;
    endDate: Date | null;
    active: boolean;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(
                `### ${options.active ? "Bring them back now?" : "Cancel this leave?"}\n` +
                    `${options.displayName} ` +
                    (options.active
                        ? options.endDate
                            ? `is due back ${ts(options.endDate, "D")}, ` +
                              `${ts(options.endDate, "R")}. Ending it now restores their ranks ` +
                              "and tells them they are back."
                            : "is on open ended leave. Ending it now restores their ranks and " +
                              "tells them they are back."
                        : "has not started this leave yet. Cancelling it means their ranks " +
                          "are never set aside and they are told it is off.") +
                    "\n\nThe fortnights this leave excused stay excused. They can request " +
                    "leave again at any time."
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`leave:${options.leaveId}:endConfirm`)
                    .setLabel(options.active ? "Bring them back" : "Cancel the leave")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`leave:${options.leaveId}:endCancel`)
                    .setLabel("Leave it running")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * What the parser made of what the member typed, shown before anything is
 * recorded.
 *
 * Plain English costs a member nothing to type and costs the parser a guess, so
 * the guess is put in front of them in full, weekday and date and year and time
 * and the zone it was read in, while the request is still only a form. A wrong
 * reading is one click from being thrown away here. Once submitted it is an
 * Executive's problem.
 */
export function leaveInterpretationCard(options: {
    token: string;
    startDate: Date | null;
    endDate: Date;
    reason: string;
    reasonLabel: string;
    timeZone: string;
    typed: string[];
}): RenderedMessage {
    const quoted = options.typed.map((value) => `**${value}**`).join(" and ");
    const lines = options.startDate
        ? `**Leave starts**\n${ts(options.startDate, "F")}\n\n` +
          `**Leave ends**\n${ts(options.endDate, "F")}\n-# ${ts(options.endDate, "R")}`
        : `**New return**\n${ts(options.endDate, "F")}\n-# ${ts(options.endDate, "R")}`;

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(
                "### Is this right?\n" +
                    `You typed ${quoted}. Read in **${options.timeZone}**, your own ` +
                    `timezone, that is:\n\n${lines}`
            )
        )
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(text(`**${options.reasonLabel}**\n${options.reason}`))
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`leaveConfirm:${options.token}:ok`)
                    .setLabel("That is right")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`leaveConfirm:${options.token}:redo`)
                    .setLabel("Start over")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * The confirmation before a purge, naming what it will destroy.
 *
 * Executives see this on an ephemeral message of their own rather than on the
 * log card, so a moment's hesitation is private and the channel is not left
 * holding a half-finished action.
 */
export function purgeConfirmCard(options: {
    leaveId: string;
    displayName: string;
    startDate: Date;
    endDate: Date | null;
    status: string;
    exemptions: string[];
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.adverse)
        .addTextDisplayComponents(
            text(
                "### Purge this leave record?\n" +
                    `**${options.displayName}**, ${ts(options.startDate, "D")} to ` +
                    `${options.endDate ? ts(options.endDate, "D") : "open ended"}, ` +
                    `currently **${options.status}**.\n\n` +
                    "This deletes the record from the database. It cannot be undone from " +
                    "Discord. The audit log keeps a copy of everything it held, which is the " +
                    "only way back."
            )
        );

    if (options.exemptions.length > 0) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                "**This record is exempting assessments**\n" +
                    options.exemptions.map((line) => `- ${line}`).join("\n") +
                    "\n\nRemoving it means the next recompute assesses those fortnights on " +
                    "the figures alone, and they may come out adverse."
            )
        );
    }

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`leavePurge:${options.leaveId}:go`)
                .setLabel("Purge it")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`leavePurge:${options.leaveId}:cancel`)
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary)
        )
    );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * The second onboarding gate: pick a ring face.
 *
 * It comes after the timezone because the timezone is functional and this is
 * not, and it is still a gate because a face nobody was asked about is a
 * setting nobody knows exists. Asking once, at the point the images start
 * appearing, is the difference between a preference and a thing they own.
 *
 * Four buttons, one image, no scrolling. The picture is the argument; the
 * blurbs underneath are for anyone deciding between two of them.
 */
export function faceSetupCard(
    faces: RingFaceOption[],
    guildId?: string | null
): RenderedMessage {
    const png = renderFacePicker();
    const fileName = "ring-faces.png";
    const attachment = new AttachmentBuilder(png, {
        name: fileName,
        description: describeFaces()
    });

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.personal)
        .addTextDisplayComponents(
            text(
                "### Pick your rings\n" +
                    "Your activity, shift time and active days are drawn as three rings. " +
                    "Choose the colours you want to look at. This is yours, and it changes " +
                    "nothing anybody measures."
            )
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${fileName}`)
                    .setDescription(describeFaces())
            )
        )
        .addTextDisplayComponents(
            text(faces.map((face) => `**${face.name}**: ${face.blurb}`).join("\n"))
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                ...faces.map((face) =>
                    new ButtonBuilder()
                        .setCustomId(`face:${face.id}:set`)
                        .setLabel(face.name)
                        .setStyle(ButtonStyle.Secondary)
                )
            )
        )
        .addTextDisplayComponents(
            text(`-# You can change it whenever you like with ${cmd("staff face", guildId)}.`)
        );

    return {
        components: [container],
        files: [attachment],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}

/** What the picker needs to know about a face. Kept structural so `render/` */
/** stays a leaf and does not reach into anything above it. */
export interface RingFaceOption {
    id: string;
    name: string;
    blurb: string;
}

/** The onboarding gate. Refuses the original action and explains why. */
export function timezoneSetupCard(guildId?: string | null): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.personal)
        .addTextDisplayComponents(
            text(
                "### Set your timezone first\n" +
                    "Set a timezone before you run anything else.\n\n" +
                    "Your timezone changes what you see and nothing more. It picks the clock " +
                    "your reports render in, and it holds your Monday recap until 09:00 where " +
                    "you are. Your totals, rings, leaderboard position and compliance run on the " +
                    "same UTC weeks as the rest of the team.\n\n" +
                    `Run ${cmd("timezone set", guildId)} and type what you know: a code like ` +
                    "**NZST**, or a region like **Pacific**. Each suggestion shows its current " +
                    "local time, so pick the one whose clock matches yours."
            )
        );
    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * Zone confirmation.
 *
 * The check is the two clock lines side by side. `zoneTime` is the instant as
 * seen from the zone the member picked; the `<t:...>` line is the same instant
 * as their own Discord client renders it. Matching lines mean the zone is
 * right. A timestamp alone could not do this: Discord renders it in the
 * reader's timezone, so it would agree with their clock whichever zone they
 * had chosen, and the card could never catch a mistake.
 */
export function timezoneConfirmCard(
    zone: string,
    now: Date,
    detail?: { abbreviation: string; offset: string; zoneTime: string }
): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.personal)
        .addTextDisplayComponents(
            text(
                "### Do these two times match?\n" +
                    `**${zone}**` +
                    (detail
                        ? `, ${[detail.abbreviation, detail.offset].filter(Boolean).join(", ")}`
                        : "") +
                    "\n\n" +
                    (detail?.zoneTime
                        ? `There, it is now **${detail.zoneTime}**.\n`
                        : "") +
                    `On your device, it is ${ts(now, "F")}.\n\n` +
                    "Matching lines mean you picked the right zone. If they disagree, choose " +
                    "again."
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`tz:confirm:${zone}`)
                    .setLabel("That is right")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId("tz:reselect")
                    .setLabel("Choose again")
                    .setStyle(ButtonStyle.Secondary)
            )
        );
    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/** Wrap loose containers into a paged message, respecting the 40 component cap. */
export function containersMessage(
    containers: ContainerBuilder[],
    files: AttachmentBuilder[] = []
): RenderedMessage {
    return {
        components: containers.slice(0, MAX_COMPONENTS),
        files,
        flags: V2_FLAGS
    };
}
