import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    Client,
    GuildMember,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder
} from "discord.js";
import type { StaffDoc } from "../db/types.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { Tier } from "../domain/permissions.js";

export interface CommandContext {
    client: Client;
    config: StaffBotConfig;
    interaction: ChatInputCommandInteraction;
    /** The caller's staff record. Present for every gated command. */
    staff: StaffDoc;
    /** The caller as a member of the PUBLIC guild, where roles live. */
    member: GuildMember | null;
    tier: Tier;
}

export interface Command {
    data:
        | SlashCommandOptionsOnlyBuilder
        | SlashCommandSubcommandsOnlyBuilder
        | { toJSON(): unknown; name: string };
    /**
     * Minimum tier.
     *
     * Checked in the handler, never left to Discord alone, and it also drives
     * visibility: the staff server registration carries the permission gate
     * this tier maps to, and only Staff tier commands are offered in a DM,
     * where Discord has no way to gate on anything.
     */
    tier: Tier;
    /**
     * Restrict to the administrators seeded at deployment, above and beyond
     * `tier`.
     *
     * `resolveTier` already promotes a seeded admin to Executive, so the tier
     * lattice cannot express "Executive is not enough". This can. It is for the
     * two things an Executive should not reach: the bot's own configuration,
     * and the dry-run tools that write throwaway records and delete real ones.
     *
     * A deployment with **no** seeded admins falls back to `tier`, because the
     * alternative is a bot nobody can configure, including the person trying to
     * name the first administrator.
     */
    seededOnly?: boolean;
    /**
     * Whether an un-onboarded member may run this. Only /timezone set may.
     */
    bypassTimezoneGate?: boolean;
    /**
     * Also registered in the community server, hidden behind a permission gate
     * of zero, and runnable there only by an ID in BOOTSTRAP_ADMIN_IDS.
     *
     * This exists so a deployment stays recoverable. If staffGuildId is wrong,
     * or the bot was never added to the staff server, every other surface is
     * unreachable and there would be no way to correct the setting that caused
     * it. Keep this to configuration alone.
     */
    communityFallback?: boolean;
    execute(context: CommandContext): Promise<void>;
    autocomplete?(
        interaction: AutocompleteInteraction,
        config: StaffBotConfig
    ): Promise<void>;
}
