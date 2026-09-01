import { randomBytes } from "node:crypto";
import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { loadConfig, setConfigValue, type StaffBotConfig } from "../config/guildConfig.js";
import { readImport, type ConfigChange } from "../config/configTransfer.js";
import { isExecutive, resolveTier, fetchPublicMember } from "../domain/permissions.js";
import { audit } from "../domain/audit.js";
import { configExportCard, configImportCard, resolveGuildNames } from "../render/configCards.js";
import { errorCard, noticeCard } from "../render/cards.js";
import { respond, sendOptions } from "../discord/respond.js";
import { COLOUR } from "../render/theme.js";
import { FIELD_CONFIG_JSON, configImportModal } from "../render/modals.js";
import { log } from "../log.js";

/**
 * Exporting the configuration, and reading one back.
 *
 * Both buttons live on `/config view`, which is Executive only and ephemeral,
 * and both re-check that tier on every click rather than trusting the card they
 * sit on. A card can be several days old by the time somebody presses it, and
 * the person pressing it is not always the person it was drawn for.
 *
 * An import is staged in memory between the paste and the confirmation, the
 * same way a leave request is. The parsed changes are worth nothing until an
 * Executive agrees to them, they belong to one person for the minute it takes
 * to read a list, and a collection of abandoned pastes in Mongo is a liability
 * nobody asked for. A restart forgets them, which the expiry message says.
 */

interface PendingImport {
    changes: ConfigChange[];
    executiveId: string;
    expiresAt: number;
}

const TTL_MS = 10 * 60_000;
const pending = new Map<string, PendingImport>();

function sweep(): void {
    const now = Date.now();
    for (const [token, entry] of pending) {
        if (entry.expiresAt <= now) pending.delete(token);
    }
}

/** Test seam: how many pastes are waiting. */
export function pendingImportCount(): number {
    sweep();
    return pending.size;
}

async function refuseUnlessExecutive(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction | ModalSubmitInteraction
): Promise<boolean> {
    const member = await fetchPublicMember(client, config, interaction.user.id);
    if (isExecutive(resolveTier(interaction.user.id, member, config))) return false;
    await respond(interaction, errorCard("Configuration is Executive only."));
    return true;
}

export async function handleConfigImportModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    if (await refuseUnlessExecutive(client, config, interaction)) return;

    const raw = interaction.fields.getTextInputValue(FIELD_CONFIG_JSON);
    // Read against the live document rather than the one the card was drawn
    // from, so a change made while the modal sat open is not silently undone.
    const fresh = await loadConfig();
    const report = readImport(raw, fresh);

    if (!report.ok) {
        await respond(interaction, configImportCard(report, "", new Map()));
        return;
    }

    sweep();
    const token = randomBytes(8).toString("hex");
    pending.set(token, {
        changes: report.changes,
        executiveId: interaction.user.id,
        expiresAt: Date.now() + TTL_MS
    });

    const guildNames = await resolveGuildNames(client, fresh);
    await respond(interaction, configImportCard(report, token, guildNames));
}

export async function handleConfigButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string,
    token: string
): Promise<void> {
    if (await refuseUnlessExecutive(client, config, interaction)) return;

    if (action === "export") {
        const fresh = await loadConfig();
        await respond(interaction, configExportCard(fresh));
        await audit("config.export", { actorId: interaction.user.id });
        return;
    }

    if (action === "import") {
        // A modal is the reply and cannot follow anything else, so the tier
        // check above is the only thing allowed to touch this interaction.
        await interaction.showModal(configImportModal());
        return;
    }

    if (action === "discard") {
        pending.delete(token);
        await interaction.update(
            sendOptions(
                noticeCard("Discarded", "Nothing was written. The configuration is unchanged.", {
                    colour: COLOUR.settled
                })
            ) as never
        );
        return;
    }

    if (action !== "apply") return;

    sweep();
    const entry = pending.get(token);
    if (!entry) {
        await interaction.update(
            sendOptions(
                errorCard(
                    "That paste has expired, or the bot restarted since you sent it. Nothing " +
                        "was written. Press **Import JSON** and paste it again."
                )
            ) as never
        );
        return;
    }

    // The person who pasted it is the person who applies it. Two Executives
    // working at once would otherwise let one confirm the other's paste from a
    // card describing changes they never read.
    if (entry.executiveId !== interaction.user.id) {
        await respond(
            interaction,
            errorCard("That import belongs to whoever pasted it. Start your own.")
        );
        return;
    }

    await interaction.deferUpdate();
    pending.delete(token);

    const applied: ConfigChange[] = [];
    const failed: string[] = [];
    for (const change of entry.changes) {
        try {
            await setConfigValue(change.key, change.to);
            await audit("config.set", {
                actorId: interaction.user.id,
                detail: { key: change.key, previous: change.from, value: change.to, via: "import" }
            });
            applied.push(change);
        } catch (error) {
            // One write failing does not roll back the ones before it, and
            // pretending otherwise would be worse than saying so: the card
            // names what landed and what did not.
            log.error(`Config import failed on ${change.key}`, error);
            failed.push(change.key);
        }
    }

    const names = applied.map((change) => `**${change.key}**`).join(", ");
    await interaction.editReply(
        sendOptions(
            failed.length === 0
                ? noticeCard(
                      `${applied.length} key(s) updated`,
                      `${names}.\n\nRun the view again to see the configuration as it now ` +
                          "stands.",
                      { colour: COLOUR.approved }
                  )
                : noticeCard(
                      "Partly applied",
                      `Written: ${names || "*nothing*"}.\n\n**Failed:** ` +
                          `${failed.map((key) => `**${key}**`).join(", ")}. Those keys still ` +
                          "hold their previous values. Set them one at a time to see the error.",
                      { colour: COLOUR.adverse }
                  )
        ) as never
    );
}
