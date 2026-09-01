import type { ButtonInteraction, Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { scrub, scrubPreview } from "../domain/scrub.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { COLOUR } from "../render/theme.js";
import { EMOJI } from "../render/emoji.js";
import { log } from "../log.js";

/**
 * The second click on scrubbing assessment records.
 *
 * The preview is taken again rather than trusted from the first click: the card
 * is ephemeral and can be sat on, and an assessment run in between would change
 * what the button is about to delete.
 */
export async function handleScrubButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    scope: string,
    action: string
): Promise<void> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (!isExecutive(resolveTier(interaction.user.id, member, config))) {
        await respond(interaction, errorCard("Scrubbing records is Executive only."));
        return;
    }

    if (action === "cancel") {
        await interaction.update(
            sendOptions(
                noticeCard("Left alone", "Nothing was deleted.", { colour: COLOUR.settled })
            ) as never
        );
        return;
    }

    if (action !== "go") return;

    await interaction.deferUpdate();

    const fortnight = scope === "pre" ? null : Number(scope);
    const target = await scrubPreview(fortnight);

    if (target.assessments.length === 0) {
        await interaction.editReply(
            sendOptions(
                noticeCard("Already gone", "There was nothing left to delete.", {
                    colour: COLOUR.settled
                })
            ) as never
        );
        return;
    }

    try {
        const result = await scrub(
            target,
            interaction.user.id,
            fortnight === null
                ? "Assessments for fortnights before the anchor, written by a boot against an empty database"
                : `Assessments for fortnight ${fortnight}, removed by an Executive`
        );

        await interaction.editReply(
            sendOptions(
                noticeCard(
                    "Deleted",
                    `${result.assessments} assessment${result.assessments === 1 ? "" : "s"} and ` +
                        `${result.warnings} warning${result.warnings === 1 ? "" : "s"} are gone.` +
                        "\n\nThe audit log holds what they said and is the only way back. " +
                        "Members' rings, rollups and leaderboard positions are unaffected: " +
                        "those are rebuilt from raw activity, which this did not touch.",
                    { colour: COLOUR.settled, emoji: EMOJI.purge }
                )
            ) as never
        );
    } catch (error) {
        // The audit row is written first and the delete is abandoned if it
        // fails, so this branch means nothing was removed.
        log.error("Scrub aborted", error);
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "The audit row could not be written, so nothing was deleted. Records are " +
                        "not removed without a trace of what they held."
                )
            ) as never
        );
    }
}
