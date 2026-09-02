import {
    CheckboxGroupBuilder,
    LabelBuilder,
    ModalBuilder,
    RadioGroupBuilder,
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
export const APPEAL_MODAL = "warningAppeal";
export const APPEAL_DECLINE_MODAL = "appealDecline";
export const REVIEW_SUBSET_MODAL = "reviewSubset";
export const CONDUCT_WARN_MODAL = "conductWarn";
export const CONDUCT_WITHDRAW_MODAL = "conductWithdraw";

export const FIELD_START = "start";
export const FIELD_END = "end";
export const FIELD_REASON = "reason";
export const FIELD_CONFIG_JSON = "configJson";
export const FIELD_APPEAL = "appeal";
export const FIELD_SUBSET_ROWS = "rows";
export const FIELD_SUBSET_ACTION = "outcome";
export const FIELD_TIER = "tier";

/** Discord's cap on a checkbox group. The subset modal is built around it. */
export const SUBSET_MAX = 10;

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


/**
 * The member's own account of a warning.
 *
 * Not called a "reason". The Executive gave a reason; this is the other side of
 * it. Ask a member why they are appealing and they write a defence. Ask what
 * you should know and they write what happened.
 *
 * Longer than a decision reason, because explaining a fortnight of your life
 * takes more room than recording a verdict on it.
 */
export function appealModal(warningId: string, windowLabel: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${APPEAL_MODAL}:${warningId}`)
        .setTitle("Appeal this warning".slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# Fortnight ${windowLabel}. Your Executives will read this and decide again.`
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("What should they know?")
                .setDescription(
                    "Anything that explains the fortnight, or anything the record has wrong. " +
                        "You get one."
                )
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_APPEAL)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(10)
                        .setMaxLength(2000)
                )
        );
}


/**
 * An Executive leaving a warning standing after an appeal.
 *
 * Every review outcome asks for a reason, and the member reads this one rather
 * than only the queue. They asked a question; this answers it. Upholding an
 * appeal needs no modal of its own, because reopen already asks why and already
 * withdraws the warning.
 */
export function appealDeclineModal(warningId: string, displayName: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${APPEAL_DECLINE_MODAL}:${warningId}`)
        .setTitle("Leave the warning standing".slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# **${displayName}** will be sent this. Reopen instead if the appeal is right.`
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Why does it stand?")
                .setDescription(
                    "They read this. Answer what they raised instead of restating the " +
                        "original decision."
                )
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(10)
                        .setMaxLength(1500)
                )
        );
}


/**
 * Deciding a chosen few rather than everybody.
 *
 * One modal carries the whole decision: which rows, what outcome, and why. A
 * card of buttons per member would cost a click per row, which is what anybody
 * reaching for a bulk control wants to avoid.
 *
 * Nothing starts ticked. On the subset path an empty selection should decide
 * nobody, so a mistimed submit costs nothing, and the button beside it already
 * handles the everyone case.
 *
 * Discord caps a checkbox group at ten options. A longer queue gets its first
 * ten and a line saying so. Decided rows drop out of the undecided set, so
 * pressing the button again offers the next ten and the queue converges without
 * anybody holding a page number.
 */
export function reviewSubsetModal(input: {
    fortnightIndex: number;
    rows: { assessmentId: string; name: string; detail: string }[];
    totalRemaining: number;
}): ModalBuilder {
    const shown = input.rows.slice(0, SUBSET_MAX);
    const truncated = input.totalRemaining > shown.length;

    const modal = new ModalBuilder()
        .setCustomId(`${REVIEW_SUBSET_MODAL}:${input.fortnightIndex}`)
        .setTitle("Decide some of the queue".slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                truncated
                    ? `-# Showing ${shown.length} of ${input.totalRemaining} undecided rows, ` +
                      "which is as many as Discord fits in one list. Decide these and press " +
                      "the button again for the rest."
                    : `-# ${shown.length} undecided ${shown.length === 1 ? "row" : "rows"}. ` +
                      "One reason is recorded against every row you tick."
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Who?")
                .setDescription("Tick everyone this decision applies to.")
                .setCheckboxGroupComponent(
                    new CheckboxGroupBuilder()
                        .setCustomId(FIELD_SUBSET_ROWS)
                        .setMinValues(1)
                        .setMaxValues(shown.length)
                        .addOptions(
                            shown.map((row) => ({
                                value: row.assessmentId,
                                label: row.name.slice(0, 100),
                                description: row.detail.slice(0, 100),
                                default: false
                            }))
                        )
                )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("What happens to them?")
                .setDescription("The same outcome is recorded against every row you ticked.")
                .setRadioGroupComponent(
                    new RadioGroupBuilder()
                        .setCustomId(FIELD_SUBSET_ACTION)
                        .addOptions(
                            {
                                value: "warn",
                                label: "Warn",
                                description: "Issues a warning and messages them. Not yourself."
                            },
                            {
                                value: "excuse",
                                label: "Excuse",
                                description: "No warning. They are told it was excused."
                            },
                            {
                                value: "dismiss",
                                label: "Dismiss",
                                description: "Nothing recorded against them. They are not told."
                            }
                        )
                )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Why?")
                .setDescription("Recorded against every row you ticked, and against each member.")
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(4)
                        .setMaxLength(1000)
                )
        );

    return modal;
}


/**
 * Issuing a formal warning for conduct.
 *
 * The rung and the reason sit in one modal, because they are one decision. Each
 * rung says what it does to the record instead of trying to define the conduct.
 * You know what happened; you are choosing how long it counts for.
 *
 * The reason box runs longer than a review decision's. The member reads this one
 * in full and gets nothing else, so it has room for a message link and an
 * account of what happened.
 */
export function conductWarnModal(input: {
    /** Carried in the id: this modal is opened from a command, so there is no
     *  message to recover the subject from on submission. */
    subjectDiscordId: string;
    displayName: string;
    tiers: { value: string; label: string; description: string }[];
}): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${CONDUCT_WARN_MODAL}:${input.subjectDiscordId}`)
        .setTitle("Issue a formal warning".slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# **${input.displayName}** will be sent this, and it goes on their record.`
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("How serious?")
                .setDescription("This sets how long the warning counts for.")
                .setRadioGroupComponent(
                    new RadioGroupBuilder()
                        .setCustomId(FIELD_TIER)
                        .addOptions(
                            input.tiers.map((tier) => ({
                                value: tier.value,
                                label: tier.label,
                                description: tier.description.slice(0, 100)
                            }))
                        )
                )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("What happened?")
                .setDescription(
                    "They read this in full. Paste message or image links in here."
                )
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(10)
                        .setMaxLength(1500)
                )
        );
}

/** Taking a warning back. The reason is kept beside the one it was issued for. */
export function conductWithdrawModal(warningId: string, displayName: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(`${CONDUCT_WITHDRAW_MODAL}:${warningId}`)
        .setTitle("Withdraw this warning".slice(0, 45))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# **${displayName}** is told, and it stops counting against them. ` +
                    "The record keeps both reasons."
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Why is it being withdrawn?")
                .setDescription("Issued in error, wrong person, or the facts turned out otherwise.")
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
