import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { findStaffByDiscordId, relinkStaff, setLeaderboardOptOut } from "../domain/staff.js";
import { isExecutive } from "../domain/permissions.js";
import { fetchMember } from "../discord/roles.js";
import { errorCard, faceSetupCard, noticeCard } from "../render/cards.js";
import { FACES } from "../render/faces.js";
import { defer, respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";

export const staffCommand: Command = {
    tier: "staff",
    data: new SlashCommandBuilder()
        .setName("staff")
        .setDescription("Staff record management")
        .addSubcommand((sub) =>
            sub
                .setName("relink")
                .setDescription("Move a staff record to a new Discord account (Executive)")
                .addUserOption((option) =>
                    option.setName("old").setDescription("The old account").setRequired(true)
                )
                .addUserOption((option) =>
                    option.setName("new").setDescription("The new account").setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("face").setDescription("Choose the colours your rings are drawn in")
        )
        .addSubcommand((sub) =>
            sub
                .setName("privacy")
                .setDescription("Choose whether other Moderators can see you on the leaderboard")
                .addBooleanOption((option) =>
                    option
                        .setName("hide-me")
                        .setDescription(
                            "True hides you from other Moderators. Leads and Executives still " +
                                "see you."
                        )
                        .setRequired(true)
                )
        ),

    async execute({ client, config, interaction, staff, tier }) {
        const sub = interaction.options.getSubcommand();

        // The same picker the onboarding gate shows, so there is one place a
        // face is chosen and one card that describes the choice.
        if (sub === "face") {
            await respond(interaction, faceSetupCard(FACES, interaction.guildId));
            return;
        }

        // This sets a preference. It never shows a leaderboard, which is why it
        // is no longer called "leaderboard": two commands of that name in one
        // picker read as a duplicate, and people ran this one expecting rankings.
        if (sub === "privacy") {
            const hide = interaction.options.getBoolean("hide-me", true);
            await setLeaderboardOptOut(staff._id, hide);
            await respond(
                interaction,
                noticeCard(
                    hide ? "Hidden from other Moderators" : "Visible to everyone",
                    (hide
                        ? `Your row is gone from ${cmd("leaderboard", interaction.guildId)} for ` +
                          "other Moderators. You still see your own position there, and Leads " +
                          "and Executives still see you, marked as hidden.\n\nYour own " +
                          "leaderboard now arrives privately, where only you can read it, " +
                          "because it has your hidden row on it. So does theirs, for as long " +
                          "as anybody is hidden."
                        : `Your row is back on ${cmd("leaderboard", interaction.guildId)} for ` +
                          "everyone, and your leaderboard goes back to posting in the channel.") +
                        "\n\n-# This is a display preference and nothing more. Your minutes " +
                        "count either way, and fortnight assessment is unchanged.",
                    { ephemeral: true }
                )
            );
            return;
        }

        if (!isExecutive(tier)) {
            await respond(interaction, errorCard("Relinking accounts is Executive only."));
            return;
        }

        const oldUser = interaction.options.getUser("old", true);
        const newUser = interaction.options.getUser("new", true);

        if (oldUser.id === newUser.id) {
            await respond(interaction, errorCard("Those are the same account."));
            return;
        }

        await defer(interaction, true);

        const result = await relinkStaff(oldUser.id, newUser.id, interaction.user.id);
        if (!result.ok || !result.staff) {
            await respond(interaction, errorCard(result.error ?? "Relink failed."));
            return;
        }

        // Re-apply the current roles to the new account.
        const oldMember = await fetchMember(client, config.publicGuildId, oldUser.id);
        const newMember = await fetchMember(client, config.publicGuildId, newUser.id);
        const reapplied: string[] = [];

        if (oldMember && newMember) {
            const managed = [
                config.moderationDepartmentRole,
                ...config.staffRankRoles,
                ...config.leadRoles,
                ...config.executiveRoles
            ].filter(Boolean);
            for (const roleId of managed) {
                if (oldMember.roles.cache.has(roleId) && !newMember.roles.cache.has(roleId)) {
                    try {
                        await newMember.roles.add(roleId, "Staff record relinked");
                        reapplied.push(roleId);
                    } catch {
                        // Hierarchy or a deleted role. Reported below rather than thrown.
                    }
                }
            }
        }

        await respond(
            interaction,
            noticeCard(
                "Staff record relinked",
                `<@${oldUser.id}> to <@${newUser.id}>\n\n` +
                    `All history follows the record, because nothing outside the staff document ` +
                    `keys on a Discord ID.\n` +
                    (reapplied.length > 0
                        ? `Re-applied ${reapplied.length} role(s) to the new account.`
                        : "No roles needed re-applying.") +
                    (newMember ? "" : "\n\n**The new account is not in the public guild.**"),
                { ephemeral: true }
            )
        );
    }
};
