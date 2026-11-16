import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { CallModLimiter, callModRefusalText } from "../domain/callMod.js";
import { callModCard, callModRefusalCard } from "../render/callMod.js";
import { respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { log } from "../log.js";

/**
 * A command for the community server, open to everybody in it.
 *
 * Every other command is staff business and answers only in the staff server
 * or a DM, gated on tier. This one is the opposite: it is how a member who is
 * not staff gets a moderator's attention, so it has no tier, no staff record
 * and no onboarding, and it answers only in the community server. That is why
 * it is a `PublicCommand` and not a `Command`: it never enters the dispatcher
 * that resolves tiers, so no rule written for staff can reach it by accident.
 */
export interface PublicCommand {
    data: { toJSON(): unknown; name: string };
    execute(client: Client, config: StaffBotConfig, interaction: ChatInputCommandInteraction): Promise<void>;
}

const limiter = new CallModLimiter();

export const callModCommand: PublicCommand = {
    data: new SlashCommandBuilder()
        .setName("callmod")
        .setDescription("Call moderators to this channel for a serious rule breach"),

    async execute(_client, config, interaction) {
        const cooldowns = {
            userMinutes: config.callModUserCooldownMinutes,
            serverMinutes: config.callModServerCooldownMinutes
        };
        const now = Date.now();
        const refusal = limiter.claim(interaction.user.id, now, cooldowns);
        if (refusal) {
            await respond(interaction, callModRefusalCard(callModRefusalText(refusal, cooldowns)));
            return;
        }

        const ping = config.availabilityRole;
        if (!ping) log.warn("/callmod ran with availabilityRole unset, so nobody was pinged");

        try {
            const card = callModCard(ping, cmd("callmod", interaction.guildId));
            // The client pings nobody by default. This replaces that for this
            // one reply: the available role, and nothing else in the card.
            await interaction.reply({
                components: card.components,
                files: card.files,
                flags: card.flags,
                allowedMentions: { parse: [], roles: ping ? [ping] : [], repliedUser: false }
            } as Parameters<ChatInputCommandInteraction["reply"]>[0]);
            log.info(`/callmod by ${interaction.user.id} in channel ${interaction.channelId}`);
        } catch (error) {
            limiter.release(interaction.user.id, now);
            throw error;
        }
    }
};
