import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffOfWeekDoc } from "../db/types.js";
import { env } from "../config/env.js";
import { fetchPublicMember, tierOf } from "../domain/permissions.js";
import { findStaffById, listActiveStaff } from "../domain/staff.js";
import { countMinutesBetween } from "../domain/activity.js";
import { reminderTimeFor, sotwEnabled } from "../domain/staffOfWeek.js";
import { findWeek } from "../domain/staffOfWeekStore.js";
import { weekWindowFor } from "../domain/weekly.js";
import { reminderCard, type Leader } from "../render/sotwCards.js";
import type { RenderedMessage } from "../render/cards.js";
import { tryDm } from "../discord/roles.js";
import { sendOptions } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { labelWindow } from "../time/format.js";
import { staffChannel } from "./leaveService.js";
import { claimSotwNotice, claimSotwReminder } from "./notifications.js";
import { barredFor, nameOf, rosterFor, weekSlots } from "./sotwContext.js";
import { log } from "../log.js";

/**
 * Notices go to one channel, `staffOfWeekChannelId`, so the Executives share a
 * single record rather than each holding a copy in their DMs. The reminder is
 * the exception: it asks each of them to do something, so it arrives by DM.
 */

export async function postNotice(client: Client, config: StaffBotConfig, card: RenderedMessage): Promise<void> {
    if (!config.staffOfWeekChannelId) {
        log.info("A Staff of the Week notice was not posted: no channel is set.");
        return;
    }
    const channel = await staffChannel(client, config, config.staffOfWeekChannelId);
    if (!channel) {
        log.warn("staffOfWeekChannelId is set but the channel could not be fetched.");
        return;
    }
    try {
        // Names fall back to mentions; a notice pings nobody.
        await channel.send({ ...sendOptions(card), allowedMentions: { parse: [] } });
    } catch (error) {
        log.error("Could not post a Staff of the Week notice", error);
    }
}

/** One notice per subject per week. */
export async function postNoticeOnce(
    client: Client,
    config: StaffBotConfig,
    key: string,
    card: RenderedMessage
): Promise<void> {
    if (await claimSotwNotice(key)) await postNotice(client, config, card);
}

/**
 * Everyone holding an Executive role, found through the staff records rather
 * than by fetching all 110,000 members of the community server, plus the
 * seeded administrators.
 */
export async function executiveIds(client: Client, config: StaffBotConfig): Promise<string[]> {
    const ids = new Set(env.bootstrapAdminIds);
    for (const staff of await listActiveStaff()) {
        const member = await fetchPublicMember(client, config, staff.discordId);
        if (tierOf(member, config) === "executive") ids.add(staff.discordId);
    }
    return [...ids];
}

export async function decisionLine(
    client: Client,
    config: StaffBotConfig,
    doc: StaffOfWeekDoc | null
): Promise<string> {
    if (doc?.status === "skipped") return `Skipped by <@${doc.decidedBy}>.`;
    if (doc?.status === "pending" && doc.staffId) {
        const staff = await findStaffById(doc.staffId);
        const name = staff ? await nameOf(client, config, staff) : "a member the bot no longer has a record of";
        return `**${name}**, picked by <@${doc.decidedBy}>.`;
    }
    return "Not decided yet. If nobody is picked, the bot draws a name at random.";
}

export async function buildReminder(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const nextDoc = await findWeek(slots.next.start);

    const barred = [];
    for (const id of await barredFor(slots.next, config)) {
        const staff = await findStaffById(new ObjectId(id));
        if (staff) barred.push(await nameOf(client, config, staff));
    }

    const leaders: Leader[] = [];
    for (const entry of await rosterFor(client, config, slots.next)) {
        if (!entry.eligibility.eligible) continue;
        leaders.push({
            name: await nameOf(client, config, entry.staff),
            minutes: await countMinutesBetween(entry.staff._id, slots.current.start, now),
            pendingLeave: entry.eligibility.pendingLeave
        });
    }
    leaders.sort((left, right) => right.minutes - left.minutes);

    return reminderCard({
        nextWeekLabel: labelWindow(slots.next.start, slots.next.end, config.accountingTimezone),
        decision: await decisionLine(client, config, nextDoc),
        barred,
        leaders: leaders.slice(0, 5),
        target: config.weeklyTargetMinutes,
        setCommand: cmd("sotw set")
    });
}

/** Built, then claimed, then sent: the recap rule. A failed DM is logged, never retried. */
export async function sendReminder(client: Client, config: StaffBotConfig, now = new Date()): Promise<number> {
    if (!sotwEnabled(config)) return 0;
    const card = await buildReminder(client, config, now);
    if (!(await claimSotwReminder(weekWindowFor(now, config).start))) return 0;

    let sent = 0;
    for (const id of await executiveIds(client, config)) {
        if (await tryDm(client, id, sendOptions(card))) sent += 1;
        else log.warn(`Could not DM the Staff of the Week reminder to ${id}`);
    }
    return sent;
}

/** At boot: send this week's reminder if its time has passed and it never went. */
export async function sendReminderIfDue(client: Client, config: StaffBotConfig, now = new Date()): Promise<void> {
    if (!sotwEnabled(config)) return;
    const due = reminderTimeFor(weekWindowFor(now, config).start, {
        timeZone: config.accountingTimezone,
        offsetMinutes: config.staffOfWeekReminderOffsetMinutes
    });
    if (now >= due) await sendReminder(client, config, now);
}
