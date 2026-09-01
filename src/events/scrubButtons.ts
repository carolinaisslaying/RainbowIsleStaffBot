import type { ButtonInteraction, Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier, isExecutive } from "../domain/permissions.js";
import { isBootstrapAdmin, bootstrapAdminsConfigured } from "../domain/permissions.js";
import {
    deleteReviewMessages,
    runFortnightAssessment
} from "../services/assessmentService.js";
import {
    deleteScrubbed,
    permittedScrub,
    recordScrubIntent,
    scrubPreview
} from "../domain/scrub.js";
import { env } from "../config/env.js";
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
    // The same gate as the command that opened this card. The button is a
    // second interaction and Discord will happily deliver it from anybody who
    // can see the message, so the check is repeated rather than assumed.
    const member = await fetchPublicMember(client, config, interaction.user.id);
    const permitted = bootstrapAdminsConfigured()
        ? isBootstrapAdmin(interaction.user.id)
        : isExecutive(resolveTier(interaction.user.id, member, config));
    if (!permitted) {
        await respond(
            interaction,
            errorCard("Purging records is limited to the deployment's administrators.")
        );
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

    if (action !== "go" && action !== "goRerun") return;

    await interaction.deferUpdate();

    const fortnight = scope === "pre" ? null : Number(scope);

    // Re-derived on the second click, not carried from the first. The card is
    // ephemeral and can be sat on, and the deployment could have been
    // restarted with a different setting in between. A guard that is only
    // checked where the button is drawn is not a guard.
    const found = await scrubPreview(fortnight);
    const { allowed: target, refused } = permittedScrub(found, env.devDangerousCommands);

    if (refused.assessments.length > 0 && target.assessments.length === 0) {
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "Nothing was deleted. Every record that matched is a real one, and this " +
                        "deployment does not delete real assessment history from a slash " +
                        "command."
                )
            ) as never
        );
        return;
    }

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

    // Three steps, in this order and no other.
    //
    // The audit row first, because nothing user-visible may disappear untraced
    // and it carries where every card was. Then the cards, while the documents
    // that know their locations still exist: deleting the documents first
    // leaves a channel full of orphaned cards for members whose records are
    // gone. Then the documents.
    //
    // The audit write has its own try, and nothing else shares it. All three
    // used to sit under one catch whose card said "the audit row could not be
    // written, so nothing was deleted" — true only of the first step. A failure
    // between the two deleteMany calls left warnings gone and assessments
    // present, and told the operator nothing had happened.
    let receipt;
    try {
        receipt = await recordScrubIntent(
            target,
            interaction.user.id,
            fortnight === null
                ? "Assessments for fortnights before the anchor, written by a boot against an empty database"
                : `Assessments and cards for fortnight ${fortnight}`
        );
    } catch (error) {
        log.error("Scrub aborted before deleting anything: the audit write failed", error);
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "The audit row could not be written, so nothing was deleted. Records are " +
                        "not removed without a trace of what they held."
                )
            ) as never
        );
        return;
    }

    try {
        const messages = await deleteReviewMessages(client, target.assessments);
        const result = await deleteScrubbed(target, receipt);

        let rerunNote = "";
        if (action === "goRerun" && fortnight !== null) {
            await runFortnightAssessment(client, config, fortnight, { dryRun: true });
            rerunNote =
                "\n\nThe fortnight has been rehearsed again and its cards are back up, " +
                "marked as a rehearsal.";
        } else if (action === "goRerun") {
            rerunNote =
                "\n\nNothing was re-run: a purge of every pre-anchor fortnight has no single " +
                "fortnight to rehearse.";
        }

        await interaction.editReply(
            sendOptions(
                noticeCard(
                    "Deleted",
                    `${result.assessments} assessment${result.assessments === 1 ? "" : "s"} and ` +
                        `${result.warnings} warning${result.warnings === 1 ? "" : "s"} are gone` +
                        (messages > 0
                            ? `, along with ${messages} card${messages === 1 ? "" : "s"} in the ` +
                              "review channel."
                            : ".") +
                        (refused.assessments.length > 0
                            ? `\n\n${refused.assessments.length} real ` +
                              `${refused.assessments.length === 1 ? "record" : "records"} ` +
                              "were left alone."
                            : "") +
                        "\n\nThe audit log holds what they said and is the only way back. " +
                        "Members' rings, rollups and leaderboard positions are unaffected: " +
                        "those are rebuilt from raw activity, which this did not touch." +
                        rerunNote,
                    { colour: COLOUR.settled, emoji: EMOJI.purge }
                )
            ) as never
        );
    } catch (error) {
        // The audit row landed before this ran, so the deletion is on record
        // whether or not it finished. What this cannot say is how far it got:
        // the cards and the two deleteMany calls are separate operations and
        // any of them may have completed. So it says exactly that, and points
        // at the one place that knows.
        log.error("Scrub failed after the audit row was written", error);
        await interaction.editReply(
            sendOptions(
                errorCard(
                    "Something failed partway through deleting. **The audit row was written " +
                        "first, so whatever went is on record there** — read it before doing " +
                        "anything else.\n\nSome records may be gone and some may remain. " +
                        "Running the purge again is safe: it takes a fresh count of what is " +
                        "actually left."
                )
            ) as never
        );
    }
}
