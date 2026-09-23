import { SlashCommandBuilder } from "discord.js";
import type { Command, CommandContext } from "./types.js";
import { fetchPublicMember, isLeadOrAbove, resolveTier } from "../domain/permissions.js";
import { conductWarningPermitted } from "../domain/conduct.js";
import { ensureStaff, findStaffByDiscordId } from "../domain/staff.js";
import { CONDUCT_TIERS, type ConductTier } from "../db/types.js";
import { conductWarnModal } from "../render/modals.js";
import { TIER_STYLE } from "../render/tiers.js";
import { errorCard } from "../render/cards.js";
import { defer, respond } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { staffDisplayName } from "../discord/displayName.js";
import { warningsViewFor } from "../services/warningsService.js";

export const warningsCommand: Command = {
    tier: "staff",
    subcommands: {
        issue: { tier: "executive" }
    },
    data: new SlashCommandBuilder()
        .setName("warnings")
        .setDescription("Read a warning record, or issue a conduct warning")
        .addSubcommand((sub) =>
            sub
                .setName("view")
                .setDescription("Warning history. Yours, or a member's (Lead and Executive)")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Whose record. Leave empty for your own.")
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("issue")
                .setDescription("Warn a member for conduct (Executive)")
                .addUserOption((option) =>
                    option
                        .setName("user")
                        .setDescription("Who is being warned")
                        .setRequired(true)
                )
        ),

    async execute(context) {
        if (context.interaction.options.getSubcommand() === "issue") {
            await issueWarning(context);
            return;
        }
        await viewWarnings(context);
    }
};

async function viewWarnings({ client, config, interaction, staff, tier }: CommandContext) {
    const target = interaction.options.getUser("user");

    // Anyone may read their own record; reading somebody else's is the audit
    // capacity a Lead holds, and the tier that issues them.
    if (target && target.id !== interaction.user.id && !isLeadOrAbove(tier)) {
        await respond(
            interaction,
            errorCard(
                "Only Leads and Executives can look up another member's warnings. " +
                    `Run ${cmd("warnings view", interaction.guildId)} with no user to ` +
                    "see your own."
            )
        );
        return;
    }

    await defer(interaction, true);

    const subject = target ? await findStaffByDiscordId(target.id) : staff;
    if (!subject) {
        await respond(interaction, errorCard(`<@${target?.id}> has no staff record.`));
        return;
    }

    await respond(
        interaction,
        await warningsViewFor(client, config, subject, subject._id.equals(staff._id))
    );
}

/**
 * A conduct warning goes on somebody's permanent record on one person's
 * say-so, so every rule about who may issue and who may receive one is checked
 * before the modal opens. `showModal` cannot follow a defer, so this must not
 * respond or defer on the way to it. The Executive tier itself is enforced by
 * the dispatcher, from `subcommands.issue`.
 */
async function issueWarning({ client, config, interaction, staff, tier }: CommandContext) {
    const target = interaction.options.getUser("user", true);
    const subjectMember = await fetchPublicMember(client, config, target.id);
    const subjectTier = resolveTier(target.id, subjectMember, config);
    const subject = await ensureStaff(target.id);

    const permitted = conductWarningPermitted({
        issuerTier: tier,
        subjectTier,
        issuerStaffId: staff._id,
        subjectStaffId: subject._id,
        subjectDeparted: subject.active === false || subjectMember === null
    });
    if (!permitted.ok) {
        await respond(interaction, errorCard(permitted.reason));
        return;
    }

    // The rung descriptions name what separates them rather than trying to
    // define the conduct: the Executive knows what happened, and what they are
    // choosing is how serious it was.
    await interaction.showModal(
        conductWarnModal({
            subjectDiscordId: target.id,
            displayName: await staffDisplayName(client, config, target.id, target.username),
            tiers: CONDUCT_TIERS.map((value) => ({
                value,
                label: TIER_STYLE[value].label,
                description: describeTier(value)
            }))
        })
    );
}

/** What separates the two rungs: gravity, judged case by case, not a clock. */
function describeTier(tier: ConductTier): string {
    return tier === "caution"
        ? "The lower rung. Stays on the record permanently."
        : "The higher rung. Stays on the record permanently.";
}
