import {
    Events,
    MessageFlags,
    type ChatInputCommandInteraction,
    type Client,
    type Interaction
} from "discord.js";
import { ObjectId } from "mongodb";
import { loadConfig, type StaffBotConfig } from "../config/guildConfig.js";
import { commandsByName } from "../commands/index.js";
import type { Command } from "../commands/types.js";
import {
    ensureStaff,
    findStaffByDiscordId,
    needsRingFace,
    needsTimezone,
    setRingFace,
    setTimezone
} from "../domain/staff.js";
import {
    atLeast,
    bootstrapAdminsConfigured,
    fetchPublicMember,
    isBootstrapAdmin,
    seededGatePermits,
    resolveTier,
    wearsOnLeaveRole,
    type Tier
} from "../domain/permissions.js";
import { pendingOrApprovedLeaveFor } from "../domain/leave.js";
import { EMOJI } from "../render/emoji.js";
import { errorCard, faceSetupCard, noticeCard, timezoneSetupCard } from "../render/cards.js";
import { FACES, faceFor } from "../render/faces.js";
import { respond, sendOptions } from "../discord/respond.js";
import { COLOUR } from "../render/theme.js";
import { handleReviewBulkButton, handleReviewButton } from "./reviewButtons.js";
import { handleReviewModal } from "./reviewModals.js";
import { handleWarningButton } from "./warningButtons.js";
import {
    handleAppealButton,
    handleAppealDeclineModal,
    handleAppealModal
} from "./appealButtons.js";
import { handleScrubButton } from "./scrubButtons.js";
import { handleLeaveButton } from "./leaveButtons.js";
import { handleLeaveModal } from "./leaveModals.js";
import { handleLeaveConfirmButton } from "./leaveConfirm.js";
import { handleLeavePurgeButton } from "./leavePurge.js";
import {
    handleConfigButton,
    handleConfigImportModal
} from "./configTransferButtons.js";
import {
    APPEAL_DECLINE_MODAL,
    APPEAL_MODAL,
    CONFIG_IMPORT_MODAL,
    REVIEW_BULK_MODAL,
    REVIEW_DECISION_MODAL
} from "../render/modals.js";
import { renderLeaderboard, type LeaderboardScope } from "../commands/leaderboard.js";
import { canonicaliseTimezone } from "../time/timezones.js";
import { publicGuildName, staffGuildName } from "../discord/guildNames.js";
import { cmd } from "../discord/commandMentions.js";
import { log } from "../log.js";
import { staffDisplayName } from "../discord/displayName.js";

export function registerInteractionHandler(client: Client): void {
    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
        try {
            if (interaction.isAutocomplete()) {
                const command = commandsByName.get(interaction.commandName);
                if (command?.autocomplete) {
                    await command.autocomplete(interaction, await loadConfig());
                }
                return;
            }

            if (interaction.isButton()) {
                await routeButton(client, interaction);
                return;
            }

            if (interaction.isModalSubmit()) {
                await routeModal(client, interaction);
                return;
            }

            if (!interaction.isChatInputCommand()) return;

            const config = await loadConfig();
            const command = commandsByName.get(interaction.commandName);
            if (!command) return;

            if (!isAllowedSurface(interaction, command, config)) {
                await respond(interaction, wrongSurfaceCard(interaction.guildId, config));
                return;
            }

            // Roles live in the public guild, wherever the command was typed.
            const member = await fetchPublicMember(client, config, interaction.user.id);
            const tier = await resolveTierAllowingLeave(
                interaction.user.id,
                member,
                config
            );

            if (tier === "none") {
                await respond(
                    interaction,
                    errorCard(
                        "This bot is for the Moderation Department. You do not hold the " +
                            `department role in ${publicGuildName()}.` +
                            (bootstrapAdminsConfigured()
                                ? ""
                                : "\n\n-# The bot has not been set up yet, and nobody is " +
                                  "able to set it up. Whoever deployed it needs to name an " +
                                  "administrator before any command will work.")
                    )
                );
                return;
            }

            if (!atLeast(tier, command.tier)) {
                await respond(
                    interaction,
                    errorCard(`**/${command.data.name}** is for ${command.tier} and above.`)
                );
                return;
            }

            // Above the tier check, not part of it: a seeded admin already
            // resolves as Executive, so the lattice cannot say "Executive is
            // not enough" and this has to. Skipped entirely when the deployment
            // names no administrators, or the bot would be unconfigurable by
            // anybody, the person setting it up included.
            if (
                !seededGatePermits({
                    seededOnly: command.seededOnly === true,
                    anyAdminsConfigured: bootstrapAdminsConfigured(),
                    callerIsAdmin: isBootstrapAdmin(interaction.user.id)
                })
            ) {
                await respond(
                    interaction,
                    errorCard(
                        `**/${command.data.name}** is limited to the administrators named when ` +
                            "this bot was deployed. Executive rank does not reach it, on " +
                            "purpose: it changes how the bot itself behaves rather than what " +
                            "it decides about anyone.\n\n" +
                            "Ask whoever runs the deployment."
                    )
                );
                return;
            }

            const staff = await ensureStaff(interaction.user.id);

            // The onboarding gate, in two steps. Timezone first because it is
            // functional and everything else reads wrong without it; the ring
            // face second because it is not, and because the point of asking is
            // that the first card they see is one they chose.
            if (needsTimezone(staff) && !command.bypassTimezoneGate) {
                await respond(interaction, timezoneSetupCard(interaction.guildId));
                return;
            }

            if (needsRingFace(staff) && !command.bypassTimezoneGate) {
                await respond(interaction, faceSetupCard(FACES, interaction.guildId));
                return;
            }

            await command.execute({ client, config, interaction, staff, member, tier });
        } catch (error) {
            log.error("Interaction handler failed", error);
            await failSafely(interaction);
        }
    });
}

/**
 * Tier resolution that survives leave.
 *
 * Activating leave removes the Moderation Department role, so `tierOf` stops
 * recognising the member as staff. Without this, someone whose leave is running
 * cannot run /leave end, /leave extend or anything else, and the only way back
 * is an Executive editing roles by hand.
 *
 * Two independent signals restore Staff tier: the on-leave role, which only
 * this bot grants, and a leave record for them that is approved or active. The
 * second covers a deployment with no on-leave role configured. Neither can lift
 * anyone above Staff, so a Lead or an Executive on leave keeps whatever their
 * remaining roles say, and nobody gains anything by taking leave.
 */
async function resolveTierAllowingLeave(
    userId: string,
    member: import("discord.js").GuildMember | null,
    config: StaffBotConfig
): Promise<Tier> {
    const tier = resolveTier(userId, member, config);
    if (tier !== "none") return tier;

    if (wearsOnLeaveRole(member, config)) return "staff";

    const staff = await findStaffByDiscordId(userId);
    if (!staff) return "none";
    const leave = await pendingOrApprovedLeaveFor(staff._id);
    const away = leave.some(
        (record) => record.status === "approved" || record.status === "active"
    );
    return away ? "staff" : "none";
}

/**
 * Commands run in the staff server or in a direct message with the bot.
 *
 * The one exception is configuration, which a seeded admin may also run in the
 * community server. That keeps a deployment recoverable: if staffGuildId is
 * wrong, or the bot was never added to the staff server, every other surface is
 * unreachable and nothing could correct the setting that caused it.
 *
 * A null guild id means a DM. Everything else has to earn its way in: the
 * community server has 110,000 members, and a moderator's shift figures,
 * warnings and leave are not its business even ephemerally.
 */
function isAllowedSurface(
    interaction: ChatInputCommandInteraction,
    command: Command,
    config: StaffBotConfig
): boolean {
    if (interaction.guildId === null) return true;
    if (interaction.guildId === config.staffGuildId) return true;

    if (
        interaction.guildId === config.publicGuildId &&
        command.communityFallback &&
        isBootstrapAdmin(interaction.user.id)
    ) {
        log.warn(
            `${interaction.user.id} ran /${interaction.commandName} in the community server ` +
                "as a seeded admin. Set staffGuildId correctly so this is no longer needed."
        );
        return true;
    }

    return false;
}

function wrongSurfaceCard(guildId: string | null, config: StaffBotConfig) {
    const inCommunity = guildId === config.publicGuildId;
    return noticeCard(
        "Not here",
        `This bot answers in ${staffGuildName()} or in a direct message with it.\n\n` +
            (inCommunity
                ? "Your shift figures, leave and any warnings are staff business, so they stay " +
                  "out of the community server. Configuration is the one exception, and only " +
                  "for the admins seeded in the environment."
                : "Your shift figures, leave and any warnings are staff business, so they stay " +
                  "out of every other server."),
        { ephemeral: true }
    );
}

/**
 * Modal submissions.
 *
 * A modal is opened by a command that already passed the tier and timezone
 * gates, but the submission is a fresh interaction that could in principle
 * arrive from anywhere, so the staff record is resolved again rather than
 * trusted. Modals are opened from leave alone at present.
 */
async function routeModal(
    client: Client,
    interaction: import("discord.js").ModalSubmitInteraction
): Promise<void> {
    const config = await loadConfig();
    const configHatch =
        interaction.customId === CONFIG_IMPORT_MODAL &&
        interaction.guildId === config.publicGuildId;
    if (
        !configHatch &&
        interaction.guildId !== null &&
        interaction.guildId !== config.staffGuildId
    ) {
        await respond(interaction, wrongSurfaceCard(interaction.guildId, config));
        return;
    }

    // Ahead of the staff lookup: configuring the bot is the one thing a seeded
    // admin does before there is anything for a staff record to describe.
    if (interaction.customId === CONFIG_IMPORT_MODAL) {
        await handleConfigImportModal(client, config, interaction);
        return;
    }

    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return;

    const member = await fetchPublicMember(client, config, interaction.user.id);
    const tier = await resolveTierAllowingLeave(interaction.user.id, member, config);
    if (tier === "none") {
        await respond(
            interaction,
            errorCard("You no longer hold the Moderation Department role.")
        );
        return;
    }

    // The member's own appeal, from the DM carrying their warning. Routed
    // before the review modals: those are Executive work on somebody else's
    // row, and this is the one modal whose author is its subject.
    if (interaction.customId.startsWith(`${APPEAL_MODAL}:`)) {
        await handleAppealModal(client, config, interaction);
        return;
    }

    // The Executive's answer to one. Its own handler because it is the opposite
    // permission: the appeal belongs to its subject, the decision does not.
    if (interaction.customId.startsWith(`${APPEAL_DECLINE_MODAL}:`)) {
        await handleAppealDeclineModal(client, config, interaction);
        return;
    }

    // Review decisions carry their reason in a modal, so they arrive here as
    // well. Routed before leave, which is the fallthrough.
    if (
        interaction.customId.startsWith(`${REVIEW_DECISION_MODAL}:`) ||
        interaction.customId.startsWith(`${REVIEW_BULK_MODAL}:`)
    ) {
        await handleReviewModal(client, config, interaction);
        return;
    }

    await handleLeaveModal(
        client,
        config,
        interaction,
        staff,
        await staffDisplayName(client, config, interaction.user.id, interaction.user.username)
    );
}

async function routeButton(client: Client, interaction: import("discord.js").ButtonInteraction) {
    const config = await loadConfig();
    const [namespace, first, second] = interaction.customId.split(":");

    // Buttons live on cards posted in the staff server or sent as DMs, with one
    // exception. The configuration buttons follow their command into the
    // community server, because that is the recovery hatch: when staffGuildId
    // is wrong, `/config view` there is the only surface left, and an import is
    // the fastest way to put a broken deployment back. The handler checks
    // Executive on every click, and a seeded admin resolves as Executive, which
    // is what makes the hatch work at all.
    const configHatch = namespace === "config" && interaction.guildId === config.publicGuildId;
    if (
        !configHatch &&
        interaction.guildId !== null &&
        interaction.guildId !== config.staffGuildId
    ) {
        await respond(interaction, wrongSurfaceCard(interaction.guildId, config));
        return;
    }

    if (namespace === "config") {
        await handleConfigButton(client, config, interaction, first, second);
        return;
    }

    if (namespace === "review") {
        await handleReviewButton(client, config, interaction, new ObjectId(first), second);
        return;
    }
    if (namespace === "reviewBulk") {
        await handleReviewBulkButton(client, config, interaction, Number(first), second);
        return;
    }
    if (namespace === "scrub") {
        await handleScrubButton(client, config, interaction, first, second);
        return;
    }
    if (namespace === "warning") {
        await handleWarningButton(client, config, interaction, new ObjectId(first), second);
        return;
    }
    // Lives on the member's warning DM, like the acknowledgement beside it.
    if (namespace === "appeal") {
        await handleAppealButton(client, config, interaction, first, second);
        return;
    }
    if (namespace === "leave") {
        await handleLeaveButton(client, config, interaction, new ObjectId(first), second);
        return;
    }
    if (namespace === "leaveConfirm") {
        await handleLeaveConfirmButton(client, config, interaction, first, second);
        return;
    }
    if (namespace === "leavePurge") {
        await handleLeavePurgeButton(client, config, interaction, first, second);
        return;
    }

    if (namespace === "tz") {
        // Both answers replace the card that asked the question. A button that
        // has been pressed cannot be pressed again to any effect, so leaving it
        // sitting above the answer invites a second click that does nothing and
        // makes the conversation read as two messages where one thing happened.
        if (first === "reselect") {
            await interaction.update(
                sendOptions(
                    noticeCard(
                        "Choose again",
                        `Run ${cmd("timezone set", interaction.guildId)} and pick another zone.`
                    )
                ) as never
            );
            return;
        }
        const zone = canonicaliseTimezone(interaction.customId.slice("tz:confirm:".length));
        if (!zone) {
            await interaction.update(
                sendOptions(
                    errorCard("That zone is no longer valid. Run the command again.")
                ) as never
            );
            return;
        }
        const staff = await ensureStaff(interaction.user.id);
        await setTimezone(staff._id, zone);

        // Straight into the second question rather than saying "saved" and
        // making them run a command to be asked it. Onboarding is two choices;
        // it should feel like two choices, not like being refused twice.
        if (needsRingFace(staff)) {
            await interaction.update(
                sendOptions(faceSetupCard(FACES, interaction.guildId)) as never
            );
            return;
        }

        await interaction.update(
            sendOptions(
                noticeCard(
                    "Timezone saved",
                    `**${zone}**. You can use every other command now.\n\n` +
                        "-# Display only: your totals, rings, leaderboard position and " +
                        "compliance outcomes are the same UTC weeks as everyone else's.",
                    { colour: COLOUR.approved, emoji: EMOJI.clock }
                )
            ) as never
        );
        return;
    }

    if (namespace === "face") {
        // The picker is the member's own ephemeral card, so the answer replaces
        // it rather than sitting under it. Same rule as the timezone confirm.
        const staff = await ensureStaff(interaction.user.id);
        const face = faceFor(first);
        await setRingFace(staff._id, face.id);
        await interaction.update(
            sendOptions(
                noticeCard(
                    `${face.name} it is`,
                    `Your rings are ${face.blurb.charAt(0).toLowerCase()}${face.blurb.slice(1)}\n\n` +
                        "Run the command you were after and you will see them. Change your " +
                        `mind whenever you like with ${cmd("staff face", interaction.guildId)}.`,
                    { colour: COLOUR.approved }
                )
            ) as never
        );
        return;
    }

    if (namespace === "leaderboard") {
        if (first === "noop") return;
        const staff = await findStaffByDiscordId(interaction.user.id);
        if (!staff) return;
        const member = await fetchPublicMember(client, config, interaction.user.id);
        const tier = resolveTier(interaction.user.id, member, config);

        // Paging edits the message the buttons are on, and anyone can press
        // them. So on a leaderboard sitting in a channel, the next page is
        // rendered as everyone's page, whoever turned it. A Lead
        // pressing Next on a public card would otherwise rewrite that public
        // card with the privileged view, publishing every hidden row to the
        // channel. Their own privileged copy is one command away and arrives
        // where only they can read it.
        const inChannel = !interaction.message.flags.has(MessageFlags.Ephemeral);
        const readerTier = inChannel ? "staff" : tier;

        await interaction.deferUpdate();
        const card = await renderLeaderboard(
            client,
            config,
            staff,
            readerTier,
            first as LeaderboardScope,
            Number.parseInt(second, 10) || 1
        );
        await interaction.editReply({
            components: card.components,
            files: card.files,
            flags: MessageFlags.IsComponentsV2
        });
    }
}

async function failSafely(interaction: Interaction): Promise<void> {
    if (!interaction.isRepliable()) return;
    try {
        const card = errorCard(
            "Something went wrong handling that. The error is in the logs. Try again shortly."
        );
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                components: card.components,
                files: [],
                flags: MessageFlags.IsComponentsV2
            });
        } else {
            await interaction.reply({
                components: card.components,
                files: [],
                flags: card.flags
            } as never);
        }
    } catch (error) {
        log.debug("Could not deliver failure card", error);
    }
}
