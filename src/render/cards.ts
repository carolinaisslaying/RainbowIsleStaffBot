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
import type { ConductTier, LeaveStatus, ReviewOutcome, RingState } from "../db/types.js";
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
import { EMOJI, emojiForColour } from "./emoji.js";
import { TIER_STYLE, tierConsequenceLine, tierTitle } from "./tiers.js";
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
                ? "First week meeting the minimum."
                : `**${input.streak} weeks** in a row meeting the minimum.`
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
            "Only activity minutes count, and only the fortnight requirement is reviewed."
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
    /** Set when a recompute or a leave change has moved them off the queue since. */
    contradiction: string | null;
    /** Still below the requirement. False once leave has taken them off the queue. */
    below: boolean;
    /** What leave did to this fortnight, and whether a request is still pending. */
    leaveLines: string[];
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
    const colour = row.outcome
        ? REVIEW_OUTCOME_COLOUR[row.outcome]
        : row.below
          ? COLOUR.adverse
          : COLOUR.settled;

    const lines = [
        `**${row.displayName}**`,
        row.requiredMinutes === 0
            ? `**${row.totalMinutes} minutes**, nothing required`
            : `**${row.totalMinutes} of ${row.requiredMinutes} minutes** (${reached}%)` +
              (shortfall > 0 ? `, **${shortfall}** under the requirement` : ""),
        `-# Week one ${row.week1Minutes} min, week two ${row.week2Minutes} min`,
        ...row.leaveLines.map((line) => `-# ${line}`),
        `-# Earlier fortnights: ${row.priorOutcomes}`
    ];

    if (row.departed) {
        lines.push("-# ⚠️ No longer in the server. They cannot be warned, only cleared.");
    }

    // Said before the click, not after it. The bot counts and surfaces; it
    // never escalates by itself.
    if (!row.outcome && row.below) lines.push(`-# ${row.warningWeight}`);

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
                        : "-# The bot never warns anyone on its own. Executives decide each " +
                          "row, and each decision needs a reason.")
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
        const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`reviewBulk:${input.fortnightIndex}:ask`)
                .setLabel(`Decide all ${input.remaining} remaining`)
                .setStyle(ButtonStyle.Secondary)
        );

        // "Some" only earns its place when there is a subset to choose. With
        // one row left the two buttons would do the same thing by different
        // routes, and the longer route asks a question with one answer.
        if (input.remaining > 1) {
            controls.addComponents(
                new ButtonBuilder()
                    .setCustomId(`reviewBulk:${input.fortnightIndex}:some`)
                    .setLabel("Decide some…")
                    .setStyle(ButtonStyle.Secondary)
            );
        }

        container.addActionRowComponents(controls);
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
                    .setLabel("Cancel")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * The warning as the member receives it.
 *
 * It carries the Executive's own words rather than a generated line, because a
 * warning nobody explained is a warning nobody can answer for. The Acknowledge
 * button is the member saying they have read it: the row card and the warnings
 * view then show the difference between unread and ignored, which is the only
 * thing an Executive can fairly act on later.
 */
export function warningDmCard(input: {
    /** The ASSESSMENT id. Both ends already know it when the DM is composed. */
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
                `### ${emojiForColour(COLOUR.adverse)} You have received an activity warning\n` +
                    `Fortnight ${input.windowLabel}. You recorded ` +
                    `**${input.totalMinutes} of ${input.requiredMinutes} activity minutes**, ` +
                    `**${shortfall}** under your fortnight requirement.\n\n` +
                    `**Why**\n> ${input.reason}\n\n` +
                    "If you think this is wrong, or something was going on that we should " +
                    "know about, contact an Executive.\n\n" +
                    `-# You can see everything held about you with ${cmd("settings export")}.`
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

export interface WarningRow {
    kind: "activity" | "conduct";
    tier: ConductTier | null;
    /** Days it counts for; zero is permanent. Shown at every rung. */
    lifetimeDays: number;
    issuedAt: Date;
    issuedBy: string;
    note: string;
    acknowledged: boolean;
    withdrawn: { at: Date; by: string; reason: string } | null;
    permanent: boolean;
    spent: boolean;
}

/** One entry, in both the record view and, later, the log. */
function warningRowLines(row: WarningRow): string {
    // The rung leads the entry at its own weight. Five warnings used to read as
    // five identical lines, so a Serious Misconduct sat in a list looking
    // exactly like a Caution.
    const heading =
        row.kind === "conduct" && row.tier
            ? `${tierTitle(row.tier, true)} · ${ts(row.issuedAt, "D")}`
            : `⚠️ ${ts(row.issuedAt, "D")}`;

    const state = row.withdrawn
        ? " · _withdrawn_"
        : row.spent
          ? " · _spent_"
          : "";

    const lines = [
        `${heading}${state}`,
        // Stated at every rung, in bold, because it is the thing that actually
        // differs between them -- but not once it has been withdrawn, when it
        // is no longer true of the record.
        ...(row.withdrawn
            ? []
            : [tierConsequenceLine(row.permanent ? 0 : row.lifetimeDays)]),
        `-# Issued by ${row.issuedBy}`,
        `> ${row.note}`
    ];

    if (row.withdrawn) {
        // Both reasons stay on the record: why it was issued, and why it was
        // taken back. A withdrawal that hid the original would make the entry
        // unreadable to anybody asking what happened.
        lines.push(
            `-# Withdrawn ${ts(row.withdrawn.at, "R")} by ${row.withdrawn.by}` +
                (row.withdrawn.reason ? `\n> ${row.withdrawn.reason}` : "")
        );
    } else {
        lines.push(`-# ${row.acknowledged ? "Acknowledged" : "Not acknowledged"}`);
    }

    return lines.join("\n");
}

export function warningsCard(input: {
    displayName: string;
    isSelf: boolean;
    tally: { total: number; conduct: number; activity: number };
    expiryDays: number;
    rows: WarningRow[];
    historyLine: string;
    windowLabel: (start: Date, end: Date) => string;
}): RenderedMessage {
    const clean = input.rows.length === 0;
    const counting = input.tally.total > 0;
    const colour = counting ? COLOUR.pending : COLOUR.approved;

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(
            text(
                `## ${emojiForColour(colour)} ` +
                    `${input.isSelf ? "Your warnings" : `Warnings: ${input.displayName}`}\n` +
                    (clean
                        ? input.isSelf
                            ? "You have never been warned. Nothing is on your record."
                            : "They have never been warned. Nothing is on their record."
                        : `**${input.tally.total}** of ${input.rows.length} ` +
                          `still count${input.tally.total === 1 ? "s" : ""} against ` +
                          `${input.isSelf ? "you" : "them"}.\n` +
                          "-# Activity warnings stop counting after a set time. Conduct " +
                          "warnings do not expire. Everything stays listed here either way."
                    )
            )
        );

    // Conduct first, because it is the more serious of the two, and split
    // because they are not the same thing — one list would say they were.
    const sections: { title: string; rows: WarningRow[] }[] = [
        {
            title: `Conduct (${input.tally.conduct} counting)`,
            rows: input.rows.filter((row) => row.kind === "conduct")
        },
        {
            title: `Activity (${input.tally.activity} counting)`,
            rows: input.rows.filter((row) => row.kind === "activity")
        }
    ];

    for (const section of sections) {
        if (section.rows.length === 0) continue;
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                `### ${section.title}\n` +
                    section.rows.map(warningRowLines).join("\n\n")
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
    /** Real records the deployment refused to put in scope. */
    protectedRecords: number;
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
                        ? "All of them came from rehearsals.\n\n"
                        : input.rehearsals > 0
                          ? `**${input.rehearsals}** of them came from a rehearsal; the rest ` +
                            "are real records of real fortnights.\n\n"
                          : "**None of them came from a rehearsal.** These are real records " +
                            "of real fortnights.\n\n") +
                    "Their cards in the review channel go too, so a re-run does not sit next " +
                    "to old ones.\n\n" +
                    (input.protectedRecords > 0
                        ? `-# **${input.protectedRecords}** further real ` +
                          `${input.protectedRecords === 1 ? "record was" : "records were"} ` +
                          "left out: this deployment does not delete real assessment history " +
                          "from a slash command.\n\n"
                        : "") +
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
                    .setLabel("Cancel")
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
    /** Every member's target, added up. What the team collectively owed. */
    teamTargetMinutes: string;
    topStreak: { mention: string; weeks: number } | null;
    /** The team's own rings. Never a mark per member: see teamRecapService. */
    rings: { png: Buffer; alt: string } | null;
    rehearsal: boolean;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.report)
        .addTextDisplayComponents(
            text(
                `## ${emojiForColour(COLOUR.report)} The week in review\n` +
                    `${input.windowLabel}\n${input.headline}\n` +
                    `-# ${input.totalMinutes} between everyone, against a combined ` +
                    `weekly minimum of ${input.teamTargetMinutes}.`
            )
        );

    if (input.rings) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder()
                    .setURL(`attachment://${TEAM_RECAP_FILE}`)
                    .setDescription(input.rings.alt)
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
        files: input.rings
            ? [
                  new AttachmentBuilder(input.rings.png, {
                      name: TEAM_RECAP_FILE,
                      description: input.rings.alt
                  })
              ]
            : [],
        flags: V2_FLAGS
    };
}

const TEAM_RECAP_FILE = "team-week.png";

/**
 * A bulk run, while it is running.
 *
 * A queue of twelve is twelve records, twelve direct messages and twelve card
 * edits, which is long enough that a card saying nothing reads as a card that
 * has died. This is edited as the run goes, so the person who pressed the
 * button can see it moving and knows which names are already done if something
 * fails halfway.
 */
export function reviewBulkProgressCard(input: {
    outcome: string;
    done: number;
    total: number;
    skipped: number;
    finished: boolean;
    /** Names, once it is over. Left out while running: the list only churns. */
    doneNames?: string[];
    skippedNames?: string[];
    reason?: string;
    /** Rows decided by somebody else between the confirmation and the run. */
    movedOn?: number;
}): RenderedMessage {
    const bar = progressBar(input.done + input.skipped, input.total);

    const lines = input.finished
        ? [
              `**${input.done}** ${input.done === 1 ? "row" : "rows"} ${input.outcome}.`,
              ...(input.doneNames && input.doneNames.length > 0
                  ? [input.doneNames.join(", ")]
                  : []),
              ...(input.skippedNames && input.skippedNames.length > 0
                  ? [
                        "",
                        `**Skipped ${input.skipped}.** ${input.skippedNames.join(", ")}. You ` +
                            "cannot warn yourself, and somebody who has left cannot be warned."
                    ]
                  : []),
              ...(input.movedOn && input.movedOn > 0
                  ? [
                        "",
                        `-# ${input.movedOn} ${input.movedOn === 1 ? "row was" : "rows were"} ` +
                            "decided by somebody else while you were typing, so " +
                            `${input.movedOn === 1 ? "it was" : "they were"} left alone.`
                    ]
                  : []),
              ...(input.reason ? ["", `**Recorded against each:** ${input.reason}`] : [])
          ]
        : [
              `${bar}`,
              `Working through ${input.total}: **${input.done + input.skipped}** done.`,
              "-# Each one writes a record and, where it applies, sends a message. " +
                  "Leave this open."
          ];

    return noticeCard(
        input.finished
            ? `${input.done} ${input.done === 1 ? "row" : "rows"} ${input.outcome}`
            : `Deciding ${input.total} rows`,
        lines.join("\n"),
        {
            ephemeral: true,
            colour: input.finished ? COLOUR.approved : COLOUR.pending
        }
    );
}

/** Twelve cells, because a bar that is mostly rounding error tells you nothing. */
function progressBar(done: number, total: number): string {
    const cells = 12;
    const filled = total === 0 ? cells : Math.round((done / total) * cells);
    return "▰".repeat(filled) + "▱".repeat(Math.max(0, cells - filled));
}



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
    pending: COLOUR.leave,
    approved: COLOUR.approved,
    declined: COLOUR.adverse,
    active: COLOUR.inProgress,
    ended: COLOUR.settled,
    cancelled: COLOUR.settled
};

const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
    pending: "Waiting on an Executive",
    approved: "Approved, not started yet",
    declined: "Declined",
    active: "On leave now",
    ended: "Back",
    cancelled: "Cancelled before it started"
};

export function leaveRequestCard(options: {
    leaveId: string;
    displayName: string;
    startDate: Date;
    endDate: Date;
    /** The return date as booked, when the leave ended before it. */
    plannedEndDate?: Date | null;
    reason: string;
    status: LeaveStatus;
    decided: string | null;
    /** What became of the leave itself: ended early, ran its course, came back. */
    outcome?: string | null;
    purged?: string | null;
    /** What approving this request would do to the member's requirements. */
    effectLines?: string[];
    /** A later return date waiting on an Executive, and what it would change. */
    pendingExtension?: { endDate: Date; reason: string; effectLines: string[] } | null;
}): RenderedMessage {
    // A purged record is grey whatever state it was decided in, so the mark
    // follows the colour the card is actually drawn in rather than the status
    // it still reports.
    const colour = options.purged ? COLOUR.settled : LEAVE_STATUS_COLOUR[options.status];
    const leaveMark = emojiForColour(colour);

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(
            text(
                `## ${leaveMark} Leave request\n` +
                    `**${options.displayName}**\n` +
                    `-# ${LEAVE_STATUS_LABEL[options.status]}\n` +
                    `From ${ts(options.startDate, "f")} to ${ts(options.endDate, "f")}` +
                    (options.status !== "ended" && options.status !== "cancelled"
                        ? `, ending ${ts(options.endDate, "R")}`
                        : "") +
                    (options.plannedEndDate
                        ? `\n-# Booked until ${ts(options.plannedEndDate, "f")}`
                        : "") +
                    `\n\n**Reason**\n${options.reason}`
            )
        );

    if (options.status === "pending" && options.effectLines && options.effectLines.length > 0) {
        container.addTextDisplayComponents(
            text(`**If approved**\n${options.effectLines.map((line) => `-# ${line}`).join("\n")}`)
        );
    }

    const extension =
        options.status === "approved" || options.status === "active"
            ? options.pendingExtension
            : null;
    // An extension is a request waiting on an Executive, so it is drawn in the
    // leave colour in its own block beneath the card. Inside the card it took
    // the green or blue of the leave it amends, and read as settled.
    let extensionBlock: ContainerBuilder | null = null;
    if (extension && !options.purged) {
        extensionBlock = new ContainerBuilder().setAccentColor(COLOUR.leave);
        extensionBlock.addTextDisplayComponents(
            text(
                `### ${emojiForColour(COLOUR.leave)} Extension requested\n` +
                    `To ${ts(extension.endDate, "f")}\n` +
                    `> ${extension.reason}\n` +
                    extension.effectLines.map((line) => `-# ${line}`).join("\n") +
                    "\n-# The leave still ends on its current date until this is decided."
            )
        );
        extensionBlock.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`leave:${options.leaveId}:extApprove`)
                    .setLabel("Approve extension")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`leave:${options.leaveId}:extDecline`)
                    .setLabel("Decline extension")
                    .setStyle(ButtonStyle.Danger)
            )
        );
    }

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

    return {
        components: extensionBlock ? [container, extensionBlock] : [container],
        files: [],
        flags: V2_FLAGS
    };
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
    endDate: Date;
    active: boolean;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.pending)
        .addTextDisplayComponents(
            text(
                `### ${options.active ? "Bring them back now?" : "Cancel this leave?"}\n` +
                    `${options.displayName} ` +
                    (options.active
                        ? `is due back ${ts(options.endDate, "D")}, ` +
                          `${ts(options.endDate, "R")}. Ending it now restores their staff roles ` +
                          "and tells them they are back."
                        : "has not started this leave yet. Cancelling it means their staff roles " +
                          "are never set aside and they are told it is off.") +
                    (options.active
                        ? "\n\nExemptions follow the leave they actually took, so a week this " +
                          "cuts short can stop being exempt, and any closed fortnight it changes " +
                          "is reassessed."
                        : "\n\nA cancelled leave exempts nothing, and the record stays on the " +
                          "card marked as cancelled. You are asked why next, and they are told.") +
                    " They can request leave again at any time."
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
                    .setLabel("Keep it running")
                    .setStyle(ButtonStyle.Secondary)
            )
        );

    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

/**
 * What a member is told when an Executive calls off their leave before it
 * started.
 *
 * Not the welcome-back card. Nobody was away and nothing was set aside, so
 * there is no stretch of absence to report, no roles to list as restored and
 * nothing that "starts again". Drawn from that card, it quoted an away period
 * that ran backwards and restored a role they had never lost.
 */
export function leaveCancelledCard(options: {
    startDate: Date;
    endDate: Date;
    cancelledBy: string;
    reason: string;
    guildId?: string | null;
}): RenderedMessage {
    return noticeCard(
        "Leave cancelled",
        `**Your leave has been cancelled** by <@${options.cancelledBy}> before it started. ` +
            `It was booked from ${ts(options.startDate, "D")} to ${ts(options.endDate, "D")}.\n\n` +
            `**Why:** ${options.reason}\n\n` +
            "Your staff roles were never set aside, so nothing changes: your activity keeps " +
            "counting as usual.\n\n" +
            `If you still need the time, ask again with ${cmd("leave request", options.guildId)}, ` +
            "or talk to the Executive team.",
        { colour: COLOUR.settled }
    );
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
    /** What the leave does to their requirements. */
    effectLines: string[];
}): RenderedMessage {
    const quoted = options.typed.map((value) => `**${value}**`).join(" and ");
    const lines = options.startDate
        ? `**Leave starts**\n${ts(options.startDate, "F")}\n\n` +
          `**Leave ends**\n${ts(options.endDate, "F")}\n-# ${ts(options.endDate, "R")}`
        : `**New return**\n${ts(options.endDate, "F")}\n-# ${ts(options.endDate, "R")}`;

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.leave)
        .addTextDisplayComponents(
            text(
                "### Is this right?\n" +
                    `You typed ${quoted}. Read in **${options.timeZone}**, your own ` +
                    `timezone, that is:\n\n${lines}`
            )
        )
        .addSeparatorComponents(separator())
        .addTextDisplayComponents(
            text(
                (options.effectLines.length > 0
                    ? `**What it changes**\n${options.effectLines.join("\n")}\n\n`
                    : "") + `**${options.reasonLabel}**\n${options.reason}`
            )
        )
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
    endDate: Date;
    status: string;
    /** Verdicts the purge would move, one line each. */
    verdictChanges: string[];
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.adverse)
        .addTextDisplayComponents(
            text(
                "### Purge this leave record?\n" +
                    `**${options.displayName}**, ${ts(options.startDate, "D")} to ` +
                    `${ts(options.endDate, "D")}, ` +
                    `currently **${options.status}**.\n\n` +
                    "This deletes the record from the database. It cannot be undone from " +
                    "Discord. The audit log keeps a copy of everything it held, which is the " +
                    "only way back."
            )
        );

    if (options.verdictChanges.length > 0) {
        container.addSeparatorComponents(separator());
        container.addTextDisplayComponents(
            text(
                `**Purging this changes ${options.verdictChanges.length} ` +
                    `${options.verdictChanges.length === 1 ? "verdict" : "verdicts"}**\n` +
                    options.verdictChanges.map((line) => `- ${line}`).join("\n") +
                    "\n\nThose fortnights are reassessed as soon as the record is gone. A row " +
                    "that falls below the requirement goes back on the review queue."
            )
        );
    }

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`leavePurge:${options.leaveId}:go`)
                .setLabel(options.verdictChanges.length > 0 ? "Purge and reassess" : "Purge it")
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
                    "Choose the colours you want to look at. It only changes how your " +
                    "rings look."
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
            text(`-# You can change it whenever you like with ${cmd("settings face", guildId)}.`)
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
                    "your reports render in, and it holds your weekly recap until 09:00 where " +
                    "you are. Your totals, rings, leaderboard position and fortnight review run " +
                    "on the same weeks as the rest of the team.\n\n" +
                    `Run ${cmd("settings timezone", guildId)} and type what you know: a code like ` +
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


/**
 * A warning's card in the warning channel, at whatever point of its life.
 *
 * The only thing that draws one, so colour, buttons and record cannot disagree —
 * the same rule `leaveCardFor` and `reviewRowFor` follow. Colour is the state:
 * amber while it is waiting on somebody, blue once it has landed, grey once it
 * has been taken back, red when it never arrived at all.
 *
 * Both kinds of warning appear here, drawn by this one function. An activity
 * warning already has a review row, but that row is a decision queue — organised
 * by fortnight, not by member, and purgeable. This is the durable record, and
 * the two kinds differ on it only where they genuinely differ: an activity
 * warning carries no rung, so it takes the plain adverse accent rather than one
 * off the ladder.
 */
export function warningLogCard(input: {
    warningId: string;
    displayName: string;
    mention: string;
    kind: "activity" | "conduct";
    tier: ConductTier | null;
    issuedAt: Date;
    issuedBy: string;
    reason: string;
    permanent: boolean;
    lifetimeDays: number;
    acknowledgedAt: Date | null;
    delivery: "delivered" | "failed" | "unknown";
    withdrawn: { at: Date; by: string; reason: string } | null;
    /** When leave took the fortnight this warning was issued for off the queue. */
    coveredByLeaveAt?: Date | null;
}): RenderedMessage {
    // The rung owns the accent here, which is the one place in this bot where
    // colour means severity rather than state. Three rungs drawn in state
    // colours were indistinguishable from each other, and severity is the thing
    // a reader must not miss while scrolling past.
    //
    // Withdrawal is the exception to the exception. A withdrawn warning counts
    // against nobody and was often taken back because it was wrong; leaving it
    // the loudest red in the channel would misrepresent the record to anybody
    // who did not stop to read. Grey-means-finished is the one state reading
    // that survives everywhere else in the bot, and it survives here.
    const colour = input.withdrawn
        ? COLOUR.settled
        : input.tier
          ? TIER_STYLE[input.tier].colour
          : COLOUR.adverse;

    // State moved out of the accent, so it has to be unmistakable in words.
    const stateLine = input.withdrawn
        ? `${EMOJI.purge} **Withdrawn** ${ts(input.withdrawn.at, "R")} by ` +
          `${input.withdrawn.by}. It no longer counts against them.\n` +
          `> ${input.withdrawn.reason.split("\n").join("\n> ")}`
        : input.delivery === "failed"
          ? "⚠️ **Never delivered.** Their direct messages are closed, so they have not seen " +
            "this. It is still on their record."
          : input.acknowledgedAt
            ? `-# ✅ Acknowledged ${ts(input.acknowledgedAt, "R")}`
            : input.delivery === "delivered"
              ? "-# 📨 Delivered, not yet acknowledged"
              : "-# Not yet acknowledged";

    const lines = [
        tierTitle(input.tier),
        `**${input.displayName}** (${input.mention})`,
        // The consequence, at every rung, in bold. It is the only thing that
        // genuinely differs between the rungs, so it reads as plainly as the
        // name does rather than sitting in a footnote.
        //
        // Except once it has been withdrawn, when it is simply false: a
        // withdrawn warning counts against nobody, and "this never stops
        // counting" sitting above "it counts against them nowhere" is a card
        // arguing with itself. The withdrawal line says what is true now.
        ...(input.withdrawn
            ? []
            : [tierConsequenceLine(input.permanent ? 0 : input.lifetimeDays)]),
        `-# Issued ${ts(input.issuedAt, "F")} by ${input.issuedBy}`,
        "",
        `> ${input.reason.split("\n").join("\n> ")}`,
        "",
        stateLine,
        ...(input.coveredByLeaveAt && !input.withdrawn
            ? [
                  "",
                  `⚠️ **Leave changed ${ts(input.coveredByLeaveAt, "R")}** and took the ` +
                      "fortnight this warning was issued for off the review queue. It still " +
                      "stands until an Executive withdraws it."
              ]
            : [])
    ];

    const container = new ContainerBuilder()
        .setAccentColor(colour)
        .addTextDisplayComponents(text(lines.join("\n")));

    // A withdrawn warning offers nothing: it is finished, and the one action a
    // card has is the one its state actually has.
    if (!input.withdrawn) {
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`conduct:${input.warningId}:withdraw`)
                    .setLabel("Withdraw")
                    .setStyle(ButtonStyle.Secondary)
            )
        );
    }

    return { components: [container], files: [], flags: V2_FLAGS };
}

/** The DM a conduct warning arrives as. */
export function conductWarnDmCard(input: {
    warningId: string;
    tier: ConductTier;
    /** The Executive who issued it, as a mention. A warning has an author. */
    issuedBy: string;
    consequence: string;
    reason: string;
}): RenderedMessage {
    const style = TIER_STYLE[input.tier];

    // The rung is the heading, not a subtitle beneath a generic one. What this
    // card has to convey in its first line is how serious it is; "You have been
    // issued a formal warning" was identical at every rung and buried the one
    // word that differed.
    const container = new ContainerBuilder()
        .setAccentColor(style.colour)
        .addTextDisplayComponents(
            text(
                `${tierTitle(input.tier)}\n` +
                    `${input.issuedBy} has given you a warning.\n\n` +
                    `${input.consequence}\n\n` +
                    `**What happened**\n> ${input.reason.split("\n").join("\n> ")}\n\n` +
                    "If you disagree, contact an Executive.\n\n" +
                    `-# ${cmd("settings export")} shows you everything this bot holds about you.`
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
