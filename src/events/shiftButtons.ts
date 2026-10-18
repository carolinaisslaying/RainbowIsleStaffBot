import type { ButtonInteraction, Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { findStaffByDiscordId, needsRingFace, needsTimezone } from "../domain/staff.js";
import { beginShift } from "../services/shiftService.js";
import { errorCard, faceSetupCard, timezoneSetupCard } from "../render/cards.js";
import { FACES } from "../render/faces.js";
import { respond, sendOptions } from "../discord/respond.js";
import { staffDisplayName } from "../discord/displayName.js";

/**
 * `shift:start`, the button on the reminder DM. It runs `/shift start` from a
 * card: the same tier, the same onboarding gates, and `beginShift` itself, so
 * leave, an open shift and an offline status refuse it as they refuse the
 * command. Its answer replaces the reminder, which leaves nothing to press twice.
 */
export async function handleShiftButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string
): Promise<void> {
    if (action !== "start") return;

    const member = await fetchPublicMember(client, config, interaction.user.id);
    const staff = await findStaffByDiscordId(interaction.user.id);
    if (resolveTier(interaction.user.id, member, config) === "none" || !staff) {
        await interaction.update(
            sendOptions(errorCard("You no longer hold the Moderation Department role.")) as never
        );
        return;
    }

    if (needsTimezone(staff)) {
        await interaction.update(sendOptions(timezoneSetupCard(interaction.guildId)) as never);
        return;
    }
    if (needsRingFace(staff)) {
        await interaction.update(sendOptions(faceSetupCard(FACES, interaction.guildId)) as never);
        return;
    }

    await interaction.deferUpdate();
    const displayName = await staffDisplayName(
        client,
        config,
        interaction.user.id,
        interaction.user.username
    );
    const result = await beginShift(client, config, staff, displayName, interaction.guildId);
    await respond(interaction, result.card);
}
