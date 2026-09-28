import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { StaffDoc } from "../db/types.js";
import { botRecordAction, type AccountLookup } from "../domain/botRecords.js";
import { forgetStaffLookup } from "../domain/staff.js";
import { log } from "../log.js";

/**
 * Remove every staff record that belongs to a bot account, at boot.
 *
 * A bot is never staff (`tierOf` says so), but a bot given the Moderation role
 * for a while could pick up a record, and nothing ever retired it: it stayed on
 * every leaderboard, and was rolled up and assessed each week, long after the
 * role was gone. A bot was never a person, so there is nobody's record here to
 * keep, and this is the one delete that does not go through `DELETION.md`.
 *
 * Follows that file's full purge order, children before parents, and keeps the
 * audit log. The audit row is written first and a record whose row cannot be
 * written is left alone, as `purgeLeaveRecord` does: a delete with no trace is
 * the one mistake nobody can see afterwards.
 */
export async function removeBotStaffRecords(client: Client): Promise<number> {
    const staff = await collections.staff().find({}).toArray();
    let removed = 0;

    for (const record of staff) {
        if (botRecordAction(await lookupAccount(client, record.discordId)) !== "remove") continue;
        if (await removeRecord(record)) removed += 1;
    }

    return removed;
}

async function lookupAccount(client: Client, discordId: string): Promise<AccountLookup> {
    try {
        const user = await client.users.fetch(discordId);
        return user.bot ? { kind: "bot" } : { kind: "person" };
    } catch (error) {
        log.debug(`Could not look up ${discordId} while checking for bot records`, error);
        return { kind: "unknown" };
    }
}

async function removeRecord(record: StaffDoc): Promise<boolean> {
    const staffId = record._id;
    const byStaff = { staffId };
    const deliveries = { _id: { $regex: staffId.toHexString() } };

    const counts = {
        warnings: await collections.warnings().countDocuments(byStaff),
        fortnightAssessments: await collections.fortnightAssessments().countDocuments(byStaff),
        leave: await collections.leave().countDocuments(byStaff),
        weeklyStats: await collections.weeklyStats().countDocuments(byStaff),
        shifts: await collections.shifts().countDocuments(byStaff),
        activityDays: await collections.activityDays().countDocuments(byStaff),
        deliveries: await collections.deliveries().countDocuments(deliveries)
    };

    try {
        await collections.auditLog().insertOne({
            _id: new ObjectId(),
            actorId: null,
            action: "staff.botRecordRemoved",
            targetStaffId: staffId,
            detail: { discordId: record.discordId, staff: record, counts },
            at: new Date()
        });
    } catch (error) {
        log.error(
            `Left the staff record of bot ${record.discordId} in place: the audit row could ` +
                "not be written, and nothing is removed without one.",
            error
        );
        return false;
    }

    await collections.warnings().deleteMany(byStaff);
    await collections.fortnightAssessments().deleteMany(byStaff);
    await collections.leave().deleteMany(byStaff);
    await collections.weeklyStats().deleteMany(byStaff);
    await collections.shifts().deleteMany(byStaff);
    await collections.activityDays().deleteMany(byStaff);
    await collections.deliveries().deleteMany(deliveries);
    await collections.staff().deleteOne({ _id: staffId });
    forgetStaffLookup(record.discordId);

    log.warn(
        `Removed the staff record of bot account ${record.discordId} and everything stored ` +
            `against it: ${JSON.stringify(counts)}. Cards already posted that name it stay ` +
            "in their channels."
    );
    return true;
}
