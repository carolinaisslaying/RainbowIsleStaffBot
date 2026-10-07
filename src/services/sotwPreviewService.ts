import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour } from "../db/types.js";
import { fetchPublicMember } from "../domain/permissions.js";
import { describeColour, highestIconRole, splitEmoji, twemojiUrl } from "../domain/sotwColour.js";
import type { PickerFragmentInput } from "../domain/sotwFragment.js";
import { describePreview, renderSotwPreview, type NamePart } from "../render/sotwPreview.js";
import { guildHasEnhanced } from "./sotwRole.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { LruCache } from "../util/cache.js";
import { log } from "../log.js";

/**
 * Everything the preview and the picker link show about a member, fetched here
 * so the renderer stays a pure function. The name is the public-guild
 * nickname — the documented exception to `staffDisplayName` — because the
 * colour is only ever seen in the community server.
 */

export interface PreviewAssets {
    nickname: string;
    /** The nickname with each emoji fetched as a Twemoji image. */
    nameParts: NamePart[];
    avatar: string | null;
    badge: string | null;
    enhanced: boolean;
    fragment: Omit<PickerFragmentInput, "colour" | "enhanced">;
}

const images = new LruCache<string, string | null>(256);

async function dataUri(url: string): Promise<string | null> {
    const cached = images.get(url);
    if (cached !== undefined) return cached;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const type = response.headers.get("content-type") ?? "image/png";
        const body = Buffer.from(await response.arrayBuffer()).toString("base64");
        const uri = `data:${type};base64,${body}`;
        images.set(url, uri);
        return uri;
    } catch (error) {
        // Omitted rather than failed: a preview without a badge is still a preview.
        log.debug(`Could not fetch ${url} for a Staff of the Week preview`, error);
        images.set(url, null);
        return null;
    }
}

/**
 * An emoji whose image cannot be fetched is left out rather than drawn as a
 * missing glyph: the name is still readable without it.
 */
async function namePartsFor(name: string): Promise<NamePart[]> {
    const parts = await Promise.all(
        splitEmoji(name).map(async (segment): Promise<NamePart | null> => {
            if (segment.kind === "text") return { text: segment.text };
            const image = await dataUri(twemojiUrl(segment.emoji));
            return image ? { image } : null;
        })
    );
    return parts.filter((part): part is NamePart => part !== null);
}

export async function previewAssets(
    client: Client,
    config: StaffBotConfig,
    discordId: string
): Promise<PreviewAssets> {
    const member = await fetchPublicMember(client, config, discordId);
    const user = member?.user ?? (await client.users.fetch(discordId).catch(() => null));
    const nickname = member?.displayName ?? user?.displayName ?? "You";
    const enhanced = member ? guildHasEnhanced(member.guild) : false;

    const badgeRole = member
        ? highestIconRole(
              [...member.roles.cache.values()].map((role) => ({
                  id: role.id,
                  position: role.position,
                  icon: role.icon,
                  unicodeEmoji: role.unicodeEmoji,
                  role
              }))
          )
        : null;

    const avatarUrl =
        member?.displayAvatarURL({ extension: "png", size: 128 }) ??
        user?.displayAvatarURL({ extension: "png", size: 128 }) ??
        null;
    const badgeUrl = badgeRole
        ? badgeRole.icon
            ? badgeRole.role.iconURL({ extension: "png", size: 64 })
            : badgeRole.unicodeEmoji
              ? twemojiUrl(badgeRole.unicodeEmoji)
              : null
        : null;

    const [avatar, badge, nameParts] = await Promise.all([
        avatarUrl ? dataUri(avatarUrl) : Promise.resolve(null),
        badgeUrl ? dataUri(badgeUrl) : Promise.resolve(null),
        namePartsFor(nickname)
    ]);

    return {
        nickname,
        nameParts,
        avatar,
        badge,
        enhanced,
        fragment: {
            nickname,
            userId: discordId,
            guildId: config.publicGuildId,
            avatarHash: member?.avatar ?? user?.avatar ?? null,
            guildAvatar: Boolean(member?.avatar),
            roleId: badgeRole?.icon ? badgeRole.id : null,
            iconHash: badgeRole?.icon ?? null,
            emoji: badgeRole && !badgeRole.icon ? badgeRole.unicodeEmoji : null
        }
    };
}

/**
 * The time beside the name, as a Discord message shows it: the member's own
 * clock when they have set a timezone, the accounting one otherwise.
 */
export function previewTime(timeZone: string, now = new Date()): string {
    try {
        return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(now);
    } catch {
        return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(now);
    }
}

export async function previewTimeFor(config: StaffBotConfig, discordId: string, now = new Date()): Promise<string> {
    const staff = await findStaffByDiscordId(discordId);
    return previewTime(staff?.timezone ?? config.accountingTimezone, now);
}

export async function previewFor(
    client: Client,
    config: StaffBotConfig,
    discordId: string,
    colour: SotwColour | null
): Promise<{ png: Buffer; alt: string } | null> {
    if (!colour) return null;
    const assets = await previewAssets(client, config, discordId);
    const time = await previewTimeFor(config, discordId);
    const input = { name: assets.nickname, nameParts: assets.nameParts, colour, avatar: assets.avatar, badge: assets.badge, time };
    const key = [
        discordId,
        assets.nickname,
        time,
        describeColour(colour),
        assets.avatar?.length ?? 0,
        assets.badge?.length ?? 0
    ].join(":");
    return { png: renderSotwPreview(input, key), alt: describePreview(input) };
}
