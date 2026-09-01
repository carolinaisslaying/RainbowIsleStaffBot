import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { StaffDoc } from "../db/types.js";
import { audit } from "./audit.js";

export async function findStaffByDiscordId(discordId: string): Promise<StaffDoc | null> {
    return collections.staff().findOne({ discordId });
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
                createdAt: now
            },
            $set: { updatedAt: now }
        },
        { upsert: true, returnDocument: "after" }
    );
    if (!result) throw new Error(`Failed to upsert staff record for ${discordId}`);
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
    await collections.staff().updateOne(
        { _id: staffId },
        { $set: { active, updatedAt: new Date() } }
    );
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
