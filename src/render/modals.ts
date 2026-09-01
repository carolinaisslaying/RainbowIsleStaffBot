import {
    LabelBuilder,
    ModalBuilder,
    TextDisplayBuilder,
    TextInputBuilder,
    TextInputStyle
} from "discord.js";

/**
 * Modals, in the Components V2 form.
 *
 * A V2 modal is a list of Labels, each wrapping one input, plus TextDisplays
 * for anything the member needs to read before they type. That is what lets the
 * hint about which clock the times are read in sit beside the fields rather
 * than being crammed into a placeholder nobody reads.
 *
 * Leave used to arrive as slash command options, which forced a single line for
 * the reason and gave no room to explain the format. It arrives here instead.
 */

export const LEAVE_REQUEST_MODAL = "leaveRequest";
export const LEAVE_EXTEND_MODAL = "leaveExtend";

export const CONFIG_IMPORT_MODAL = "configImport";
export const REVIEW_DECISION_MODAL = "reviewDecision";
export const REVIEW_BULK_MODAL = "reviewBulk";

export const FIELD_START = "start";
export const FIELD_END = "end";
export const FIELD_REASON = "reason";
export const FIELD_CONFIG_JSON = "configJson";

function dateField(
    customId: string,
    label: string,
    description: string,
    example: string,
    value?: string
): LabelBuilder {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(example)
        .setRequired(true)
        // Long enough for a sentence like "the first Monday of October at 9am".
        // The old 32 was sized for an ISO date and would truncate plain English
        // mid-word, which reads as the bot refusing a date it never received.
        .setMaxLength(64);
    if (value) input.setValue(value);

    return new LabelBuilder()
        .setLabel(label)
        .setDescription(description)
        .setTextInputComponent(input);
}

function reasonField(label: string, description: string): LabelBuilder {
    return new LabelBuilder()
        .setLabel(label)
        .setDescription(description)
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId(FIELD_REASON)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(10)
                .setMaxLength(1000)
                .setPlaceholder("As much or as little as you want an Executive to know.")
        );
}

/**
 * The clock line, which is also the only documentation the date fields have.
 *
 * It leads with plain English because that is what people type first, and
 * because a field that silently accepts "Tuesday at 10.16 pm" while advertising
 * `YYYY-MM-DD` teaches everyone the harder of the two. The exact format is kept
 * as a second sentence for the people who prefer it.
 */
function clockNote(timeZone: string): TextDisplayBuilder {
    return new TextDisplayBuilder().setContent(
        `Write the dates however you would say them: **Tuesday at 10.16 pm**, ` +
            "**tomorrow at 9am**, **the 6th**, **6 October**, **in 2 weeks**. " +
            `Read in **${timeZone}**, your own timezone.\n` +
            "-# `2026-10-06 09:00` works too. You will see what the dates were read as " +
            "before anything is sent."
    );
}

export function leaveRequestModal(timeZone: string, example: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(LEAVE_REQUEST_MODAL)
        .setTitle("Request leave")
        .addTextDisplayComponents(clockNote(timeZone))
        .addLabelComponents(
            dateField(
                FIELD_START,
                "Leave starts",
                "When your ranks are set aside and your assessment pauses.",
                example
            ),
            dateField(
                FIELD_END,
                "Leave ends",
                "Your leave closes itself at this moment and your ranks come back.",
                example
            ),
            reasonField(
                "Reason",
                "Visible to Executives only. Never shown to other Moderators."
            )
        );
}

/**
 * Extending reuses the same shape deliberately: the member is answering the
 * same question, so they should not have to learn a second format for it.
 */
export function leaveExtendModal(
    leaveId: string,
    timeZone: string,
    currentEnd: string,
    example: string
): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${LEAVE_EXTEND_MODAL}:${leaveId}`)
        .setTitle("Extend leave")
        .addTextDisplayComponents(clockNote(timeZone))
        .addLabelComponents(
            dateField(
                FIELD_END,
                "New return",
                `Currently ${currentEnd}. The new date has to be later than that.`,
                example,
                currentEnd
            ),
            reasonField(
                "Why the extension",
                "Visible to Executives only. Appended to your original reason."
            )
        );
}

/**
 * The import paste.
 *
 * A modal is the only way Discord lets a button collect text, and its ceiling
 * is 4000 characters. A full export of a deployment with a long tracked channel
 * list can pass that, which is the other reason the reader applies only the
 * keys it is given: an oversized file goes in as two pastes.
 */
export function configImportModal(): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(CONFIG_IMPORT_MODAL)
        .setTitle("Import configuration")
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "Paste an exported file, or just the keys you want to change. Only the keys " +
                    "you paste are touched.\n" +
                    "-# You will see every change listed before anything is written. If one " +
                    "key is wrong, none of them are applied."
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Configuration JSON")
                .setDescription("The whole file, or an object with the keys you want to set.")
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_CONFIG_JSON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(2)
                        .setMaxLength(4000)
                        .setPlaceholder('{ "weeklyTargetMinutes": 120 }')
                )
        );
}


/**
 * The reason behind a review decision.
 *
 * Every outcome asks for one, including dismissing and reopening. A warning
 * nobody explained is a warning nobody can appeal, and a reopen with no reason
 * is indistinguishable from a mistake. The prompt changes with the action, so
 * the field asks the question the Executive is actually answering rather than
 * a generic "reason".
 */
const DECISION_PROMPT: Record<string, { title: string; label: string; hint: string }> = {
    warn: {
        title: "Issue a warning",
        label: "Why this warning?",
        hint: "The member is sent these words. Say what they got wrong and what you expect."
    },
    excuse: {
        title: "Excuse the fortnight",
        label: "Why excuse it?",
        hint: "The member is sent these words. Say what you took into account."
    },
    dismiss: {
        title: "Dismiss the shortfall",
        label: "Why dismiss it?",
        hint: "Kept on the record for the next Executive who reads it. The member is not told."
    },
    reopen: {
        title: "Reopen this decision",
        label: "Why reopen it?",
        hint: "Any warning it issued is deleted and the member is told it has been withdrawn."
    }
};

export function reviewDecisionModal(
    assessmentId: string,
    action: string,
    displayName: string
): ModalBuilder {
    const prompt = DECISION_PROMPT[action] ?? DECISION_PROMPT.dismiss;
    return new ModalBuilder()
        .setCustomId(`${REVIEW_DECISION_MODAL}:${assessmentId}:${action}`)
        .setTitle(prompt.title.slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# About **${displayName}**.`)
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel(prompt.label)
                .setDescription(prompt.hint)
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(4)
                        .setMaxLength(1000)
                )
        );
}

/** One reason, recorded against every row the bulk action touches. */
export function reviewBulkModal(
    fortnightIndex: number,
    action: string,
    count: number
): ModalBuilder {
    const prompt = DECISION_PROMPT[action] ?? DECISION_PROMPT.dismiss;
    return new ModalBuilder()
// The count the confirmation showed rides along, so the run can say
        // whether the set moved while the modal was open.
        .setCustomId(`${REVIEW_BULK_MODAL}:${fortnightIndex}:${action}:${count}`)
        .setTitle(`${prompt.title} \u00d7 ${count}`.slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# Recorded against **${count}** ${count === 1 ? "row" : "rows"} at once, ` +
                    "and against each of those members individually."
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel(prompt.label)
                .setDescription(prompt.hint)
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(4)
                        .setMaxLength(1000)
                )
        );
}
