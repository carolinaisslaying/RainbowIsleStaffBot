import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder } from "discord.js";
import { cmd } from "../discord/commandMentions.js";
import { noticeCard, type RenderedMessage } from "./cards.js";
import { EMOJI } from "./emoji.js";
import { COLOUR } from "./theme.js";

/** The one button on the reminder: `shift:start`, routed in interactionCreate. */
export const SHIFT_START_BUTTON = "shift:start";

/**
 * The DM a member gets for being active without a shift open. Green and ▶️,
 * like the shift-started card, because it offers a shift to start. It must
 * read as a suggestion, so it carries no warning colour.
 */
export function shiftReminderCard(input: {
    messages: number;
    windowMinutes: number;
    cooldownHours: number;
    guildName: string;
    /** Discord shows them offline, so the button would only be refused. */
    showingOffline: boolean;
}): RenderedMessage {
    const card = noticeCard(
        "You are active, but not on shift",
        `You have sent ${input.messages} messages in ${input.guildName} in the last ` +
            `${input.windowMinutes} minutes, and without a shift none of them earn you ` +
            "minutes.\n\n" +
            "If you are moderating, start a shift and your messages count from now on." +
            (input.showingOffline
                ? `\n\n${EMOJI.warning} Discord shows you as offline, and invisible counts as ` +
                  "offline. Set your status to Online, Idle or Do Not Disturb first, or the " +
                  "shift will not start."
                : "") +
            `\n\n-# Off duty? Ignore this. You will not get another for ` +
            `${input.cooldownHours} ${input.cooldownHours === 1 ? "hour" : "hours"}, and ` +
            `${cmd("settings shift-reminders")} turns them off.`,
        { colour: COLOUR.onShift, emoji: EMOJI.onShift }
    );

    (card.components[0] as ContainerBuilder).addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(SHIFT_START_BUTTON)
                .setLabel("Start shift")
                .setStyle(ButtonStyle.Success)
        )
    );
    return card;
}
