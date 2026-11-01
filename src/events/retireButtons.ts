import type { ButtonInteraction, Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import {
    bootstrapAdminsConfigured,
    fetchPublicMember,
    isBootstrapAdmin,
    isExecutive,
    resolveTier
} from "../domain/permissions.js";
import { planRetirementSweep, runRetirementSweep } from "../services/retirementService.js";
import { retireConfirmCard } from "../render/configCards.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { staffDisplayName } from "../discord/displayName.js";
import { COLOUR } from "../render/theme.js";

/**
 * Past the sweep's threshold, from `/dev status`. A first cleanup can honestly
 * retire more than a quarter of the roster, and would otherwise stop every time.
 *
 * The roster is read again on each press, and the count on the final button must
 * still match it: the card is ephemeral and can be sat on, and a guard only
 * enforced where the button is drawn is not a guard. Unusable role settings
 * refuse here as they do everywhere.
 */
export async function handleRetireButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string,
    count: string | undefined
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    const permitted = bootstrapAdminsConfigured()
        ? isBootstrapAdmin(interaction.user.id)
        : isExecutive(resolveTier(interaction.user.id, member, config));
    if (!permitted) {
        await respond(interaction, errorCard("This is limited to the deployment's administrators."));
        return;
    }

    if (action === "cancel") {
        await interaction.update(
            sendOptions(
                noticeCard("Left as they are", "Nobody was retired.", { colour: COLOUR.settled })
            ) as never
        );
        return;
    }
    if (action !== "ask" && action !== "go") return;

    await interaction.deferUpdate();

    const plan = await planRetirementSweep(client, config);
    if (plan.block?.kind === "roles") {
        await interaction.editReply(
            sendOptions(errorCard(`Nobody was retired: ${plan.block.reason}.`)) as never
        );
        return;
    }

    if (action === "ask" || Number(count) !== plan.retiring.length) {
        const names = [];
        for (const { staff } of plan.retiring) {
            names.push(
                await staffDisplayName(client, config, staff.discordId, `<@${staff.discordId}>`)
            );
        }
        await interaction.editReply(sendOptions(retireConfirmCard(names)) as never);
        return;
    }

    const outcome = await runRetirementSweep(client, config, { pastThreshold: true });
    await interaction.editReply(
        sendOptions(
            noticeCard(
                "Done",
                `${outcome.retired} retired, ${outcome.returned} back on the team.`,
                { colour: COLOUR.settled }
            )
        ) as never
    );
}
