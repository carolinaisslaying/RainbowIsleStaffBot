import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { StaffDoc } from "../db/types.js";
import { audit } from "./audit.js";
import { LruCache } from "../util/cache.js";

/**
 * Discord ID to staff record, cached.
 *
 * `messageCreate` asks this of every message in a 110,000 member server, before
 * it knows whether the author is staff at all, so almost every call is a miss
 * that costs a round trip to Mongo. Misses are cached too — that is the whole
 * point, since they are the common case — but only briefly, so somebody who
 * joins the department is picked up without a restart.
 *
 * Every write that changes who a Discord ID resolves to invalidates it:
 * `ensureStaff`, `relinkStaff` and `setStaffActive`.
 *
 * Both hits and misses also expire, which is the belt to that braces. The other
 * writers here — `setTimezone`, `setRingFace`, `setLeaderboardOptOut` — take a
 * staffId and have no Discord ID to invalidate by, so a document they edit
 * would otherwise be served stale from a cached hit indefinitely. A short life
 * means any such gap heals itself within a minute instead of lasting until a
 * restart. The hot path still avoids essentially every query it used to make:
 * one lookup per member per minute against one per message.
 */
const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 60_000;
const staffByDiscordId = new LruCache<string, { doc: StaffDoc | null; at: number }>(2000);

export function forgetStaffLookup(discordId?: string): void {
    if (discordId === undefined) staffByDiscordId.clear();
    else staffByDiscordId.delete(discordId);
}

export async function findStaffByDiscordId(discordId: string): Promise<StaffDoc | null> {
    const cached = staffByDiscordId.get(discordId);
    if (cached) {
        const age = Date.now() - cached.at;
        if (age < (cached.doc === null ? MISS_TTL_MS : HIT_TTL_MS)) return cached.doc;
    }

    const doc = await collections.staff().findOne({ discordId });
    staffByDiscordId.set(discordId, { doc, at: Date.now() });
    return doc;
}

export async function findStaffById(staffId: ObjectId): Promise<StaffDoc | null> {
    return collections.staff().findOne({ _id: staffId });
}

export async function findManyStaff(staffIds: ObjectId[]): Promise<Map<string, StaffDoc>> {
    if (staffIds.length === 0) return new Map();
    const docs = await collections.staff().find({ _id: { $in: staffIds } }).toArray();
    return new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
}

export async function listActiveStaff(): Promise<StaffDoc[]> {
    return collections.staff().find({ active: true }).toArray();
}

/**
 * How many active members are hiding from the leaderboard.
 *
 * A count rather than the records, because the one caller needs it before it
 * has acknowledged an interaction: Discord allows three seconds, the leaderboard
 * itself takes longer than that to build, and whether the reply is ephemeral has
 * to be decided at the moment it is deferred.
 */
export async function countHiddenStaff(): Promise<number> {
    return collections.staff().countDocuments({ active: true, leaderboardOptOut: true });
}

/**
 * Registration is implicit: the first time we see a member of the Moderation
 * Department, they get a record. Timezone stays null until they set it, and the
 * onboarding gate refuses every other command until they do.
 */
export async function ensureStaff(discordId: string): Promise<StaffDoc> {
    const now = new Date();
    const result = await collections.staff().findOneAndUpdate(
        { discordId },
        {
            $setOnInsert: {
                _id: new ObjectId(),
                discordId,
                previousDiscordIds: [],
                timezone: null,
                timezoneSetAt: null,
                joinedTeamAt: now,
                active: true,
                leaderboardOptOut: false,
                ringFace: null,
                createdAt: now
            },
            $set: { updatedAt: now }
        },
        { upsert: true, returnDocument: "after" }
    );
    if (!result) throw new Error(`Failed to upsert staff record for ${discordId}`);
    // The record now exists, or its contents moved. Either way the cached
    // answer for this ID is out of date, and a cached miss would keep a
    // brand-new member unrecognised until it expired.
    forgetStaffLookup(discordId);
    return result;
}

export async function setTimezone(staffId: ObjectId, timezone: string): Promise<void> {
    const now = new Date();
    await collections.staff().updateOne(
        { _id: staffId },
        { $set: { timezone, timezoneSetAt: now, updatedAt: now } }
    );
    await audit("timezone.set", { targetStaffId: staffId, detail: { timezone } });
}

/**
 * The second half of onboarding. Cosmetic, and still required: a member who has
 * never been asked has no face, and the whole point is that the first ring card
 * they ever see is one they chose.
 */
export async function setRingFace(staffId: ObjectId, faceId: string): Promise<void> {
    await collections.staff().updateOne(
        { _id: staffId },
        { $set: { ringFace: faceId, updatedAt: new Date() } }
    );
    await audit("face.set", { targetStaffId: staffId, detail: { face: faceId } });
}

/** Has this member ever chosen a face? */
export function needsRingFace(staff: StaffDoc | null): boolean {
    return !staff || !staff.ringFace;
}

export async function setLeaderboardOptOut(
    staffId: ObjectId,
    optOut: boolean
): Promise<void> {
    await collections.staff().updateOne(
        { _id: staffId },
        { $set: { leaderboardOptOut: optOut, updatedAt: new Date() } }
    );
}

export async function setStaffActive(staffId: ObjectId, active: boolean): Promise<void> {
    const result = await collections.staff().findOneAndUpdate(
        { _id: staffId },
        { $set: { active, updatedAt: new Date() } },
        { returnDocument: "after" }
    );
    // `active` is read off the cached document by reviewRowFor to decide whether
    // somebody has departed, so a stale copy would draw a departed member as
    // present and offer buttons that refuse.
    if (result) forgetStaffLookup(result.discordId);
    await audit(active ? "staff.reactivated" : "staff.deactivated", {
        targetStaffId: staffId
    });
}

/**
 * Account migration. All history follows automatically, because nothing outside
 * this document keys on Discord ID.
 */
export async function relinkStaff(
    oldDiscordId: string,
    newDiscordId: string,
    actorId: string
): Promise<{ ok: boolean; error?: string; staff?: StaffDoc }> {
    const existing = await findStaffByDiscordId(oldDiscordId);
    if (!existing) return { ok: false, error: "No staff record for the old account." };

    const collision = await findStaffByDiscordId(newDiscordId);
    if (collision && !collision._id.equals(existing._id)) {
        return {
            ok: false,
            error: "The new account already has its own staff record. Merge manually before relinking."
        };
    }

    const result = await collections.staff().findOneAndUpdate(
        { _id: existing._id },
        {
            $set: { discordId: newDiscordId, updatedAt: new Date() },
            $addToSet: { previousDiscordIds: oldDiscordId }
        },
        { returnDocument: "after" }
    );

    // Both IDs change meaning: the old one stops resolving, the new one starts.
    forgetStaffLookup(oldDiscordId);
    forgetStaffLookup(newDiscordId);

    await audit("staff.relink", {
        actorId,
        targetStaffId: existing._id,
        detail: { oldDiscordId, newDiscordId }
    });

    return { ok: true, staff: result ?? undefined };
}

/** The onboarding gate. Null timezone means every action is refused. */
export function needsTimezone(staff: StaffDoc | null): boolean {
    return !staff || !staff.timezone;
}

/** Display timezone, falling back to the accounting zone for un-onboarded staff. */
export function displayTimezone(staff: StaffDoc | null, fallback: string): string {
    return staff?.timezone ?? fallback;
}
