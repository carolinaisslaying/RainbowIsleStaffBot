import type { SotwColour } from "../db/types.js";
import { cooldownRemainingMs } from "./staffOfWeek.js";

/**
 * What a member has chosen but not saved, and when they last changed the role.
 *
 * In memory, like the config import: a restart forgets a staged colour, which
 * costs somebody pasting a code again and nothing more. Keyed by Discord id, so
 * only the person who staged a choice can save it.
 */

export const STAGE_TTL_MS = 10 * 60_000;

const staged = new Map<string, { colour: SotwColour | null; expiresAt: number }>();
const lastRoleWrite = new Map<string, number>();
const pendingSets = new Map<string, { staffId: string; reason: string | null; expiresAt: number }>();

export function stageColour(discordId: string, colour: SotwColour | null, now = Date.now()): void {
    staged.set(discordId, { colour, expiresAt: now + STAGE_TTL_MS });
}

/** Null when nothing is staged; `{ colour: null }` when "no colour" is. */
export function stagedColour(
    discordId: string,
    now = Date.now()
): { colour: SotwColour | null } | null {
    const entry = staged.get(discordId);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        staged.delete(discordId);
        return null;
    }
    return { colour: entry.colour };
}

export function clearStaged(discordId: string): void {
    staged.delete(discordId);
}

export function noteRoleWrite(discordId: string, now = Date.now()): void {
    lastRoleWrite.set(discordId, now);
}

/** Milliseconds until this member may change the role's colour again. */
export function roleWriteCooldown(discordId: string, now = Date.now()): number {
    return cooldownRemainingMs(lastRoleWrite.get(discordId), now);
}

/** A `/sotw set` waiting on "rest of this week" or "next week". */
export function stageSet(
    actorId: string,
    staffId: string,
    reason: string | null,
    now = Date.now()
): void {
    pendingSets.set(actorId, { staffId, reason, expiresAt: now + STAGE_TTL_MS });
}

export function takeSet(
    actorId: string,
    now = Date.now()
): { staffId: string; reason: string | null } | null {
    const entry = pendingSets.get(actorId);
    pendingSets.delete(actorId);
    if (!entry || entry.expiresAt <= now) return null;
    return { staffId: entry.staffId, reason: entry.reason };
}

/** Test seam. */
export function resetSotwStaging(): void {
    staged.clear();
    lastRoleWrite.clear();
    pendingSets.clear();
}
