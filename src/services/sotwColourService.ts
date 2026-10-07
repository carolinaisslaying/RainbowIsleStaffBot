import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour, StaffDoc } from "../db/types.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { forgetStaffLookup, setSotwColour } from "../domain/staff.js";
import { colourStatus, sotwEnabled } from "../domain/staffOfWeek.js";
import { describeColour, downgradeNote } from "../domain/sotwColour.js";
import { pickerUrl } from "../domain/sotwFragment.js";
import { clearStaged, noteRoleWrite, roleWriteCooldown, stagedColour } from "../domain/sotwStaging.js";
import { appendEvent, sotwEvent } from "../domain/staffOfWeekStore.js";
import { audit } from "../domain/audit.js";
import { describePreview, renderSotwPreview } from "../render/sotwPreview.js";
import { colourSettingsCard } from "../render/sotwCards.js";
import type { RenderedMessage } from "../render/cards.js";
import { currentHolder } from "./sotwContext.js";
import { previewAssets, previewTime } from "./sotwPreviewService.js";
import { applyRoleColour } from "./sotwRole.js";

/**
 * A member's own Staff of the Week colour: a preference on their record, set
 * whenever they like, holder or not. Saving it also recolours the role only if
 * they hold it at the moment they press Save.
 */

export async function colourCardFor(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    options: { staged?: { colour: SotwColour | null } | null; message?: string | null } = {}
): Promise<RenderedMessage> {
    const member = await fetchPublicMember(client, config, staff.discordId);
    const tier = resolveTier(staff.discordId, member, config);
    const holder = await currentHolder(config);
    const holding = holder?.staff._id.equals(staff._id) ?? false;

    const saved = staff.sotwColour ?? null;
    const shown = options.staged ? options.staged.colour : saved;
    const assets = await previewAssets(client, config, staff.discordId);
    const preview = shown
        ? (() => {
              const input = {
                  name: assets.nickname,
                  nameParts: assets.nameParts,
                  colour: shown,
                  avatar: assets.avatar,
                  badge: assets.badge,
                  time: previewTime(staff.timezone ?? config.accountingTimezone)
              };
              return { png: renderSotwPreview(input), alt: describePreview(input) };
          })()
        : null;

    return colourSettingsCard({
        status: colourStatus({ holding, tier }),
        savedLabel: saved ? describeColour(saved) : "No colour saved. The role would show no colour",
        staged: options.staged ? { label: describeColour(options.staged.colour) } : null,
        pickerUrl: config.staffOfWeekColourPickerUrl
            ? pickerUrl(config.staffOfWeekColourPickerUrl, { ...assets.fragment, colour: saved, enhanced: assets.enhanced })
            : null,
        preview,
        message: options.message ?? null,
        note: shown && !assets.enhanced ? downgradeNote(shown) : null
    });
}

/** Save what is staged. Returns the line the card shows afterwards. */
export async function saveStagedColour(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    now = Date.now()
): Promise<string> {
    const staged = stagedColour(staff.discordId, now);
    if (!staged) return "That choice has expired. Enter the code again.";

    // Re-derived at the click, never carried from the card. A member is never
    // "holding" while the feature is off: there is no role to touch, so no
    // cooldown, no write and no event, whatever a stale doc from before it was
    // switched off might otherwise say.
    const enabled = sotwEnabled(config);
    const holder = enabled ? await currentHolder(config, new Date(now)) : null;
    const holding = enabled && (holder?.staff._id.equals(staff._id) ?? false);

    if (holding) {
        const wait = roleWriteCooldown(staff.discordId, now);
        if (wait > 0) {
            return `Wait ${Math.ceil(wait / 1000)} seconds before changing the role's colour again. Your choice is still here.`;
        }
    }

    await setSotwColour(staff._id, staged.colour);
    forgetStaffLookup(staff.discordId);
    clearStaged(staff.discordId);
    await audit("sotw.colourSaved", {
        actorId: staff.discordId,
        targetStaffId: staff._id,
        detail: { colour: staged.colour }
    });

    if (!holding || !holder) return "Saved. It goes on the role the next time you are Staff of the Week.";

    noteRoleWrite(staff.discordId, now);
    const write = await applyRoleColour(client, config, staged.colour, "Staff of the Week colour changed by its holder", staff.discordId);
    if (!write.ok) {
        return "Saved, but the bot could not update the role. Your colour goes on it the next time the bot restarts or the week changes over.";
    }
    // What was actually put on the role, not the staged preference: a
    // downgraded write shows one colour on the role while the preference
    // stores the gradient or holographic choice behind it.
    await appendEvent(
        holder.week.start,
        sotwEvent(staged.colour ? "colour" : "colourCleared", {
            actorId: staff.discordId,
            staffId: staff._id,
            detail: write.colours ? { ...write.colours } : null
        })
    );
    return write.downgraded && staged.colour
        ? `Saved. The role now shows your colour. ${downgradeNote(staged.colour)}`
        : "Saved. The role now shows your colour.";
}
