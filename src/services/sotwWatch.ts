import type { Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { findStaffByDiscordId, findStaffById } from "../domain/staff.js";
import { leaveOverlapping, weekLeaveFor } from "../domain/leave.js";
import { sotwEnabled, type LateCause } from "../domain/staffOfWeek.js";
import { findWeek } from "../domain/staffOfWeekStore.js";
import { sotwCard } from "../render/sotwCards.js";
import { cmd } from "../discord/commandMentions.js";
import { currentHolder, nameOf, weekSlots } from "./sotwContext.js";
import { postNoticeOnce } from "./sotwNotices.js";
import { log } from "../log.js";

/**
 * Things that happen to a holder or a pending pick after the Executives
 * decided. Never automatic: the bot tells them, once per subject per week, and
 * `/sotw remove` is theirs to use.
 */

export async function checkLeaveAgainstSotw(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const slots = await weekSlots(config, now);
        const holder = await currentHolder(config, now);
        const next = await findWeek(slots.next.start);
        const checks = [
            { week: slots.current, applies: holder?.staff._id.equals(staffId) ?? false, what: "this week's Staff of the Week" },
            {
                week: slots.next,
                applies: next?.status === "pending" && (next.staffId?.equals(staffId) ?? false),
                what: "picked for next week"
            }
        ];
        for (const check of checks) {
            if (!check.applies) continue;
            const leave = await weekLeaveFor(staffId, check.week.start, check.week.end, config.minimumLeaveDays);
            if (!leave.exempt) continue;
            const staff = await findStaffById(staffId);
            const name = staff ? await nameOf(client, config, staff) : "A member";
            await postNoticeOnce(
                client,
                config,
                `late:${check.week.start.getTime()}:${staffId.toHexString()}:leave`,
                sotwCard(
                    "Staff of the Week and leave",
                    `**${name}**, ${check.what}, now has enough approved leave for that week not to count ` +
                        `for them. The bot has not changed anything. Use ${cmd("sotw remove")} or ${cmd("sotw set")} if you want to.`
                )
            );
        }
    } catch (error) {
        log.error("Could not check leave against Staff of the Week", error);
    }
}

const CAUSE_TEXT: Record<LateCause, string> = {
    left: "has left the community server, so Discord has already removed the role",
    notStaff: "is no longer Moderation staff",
    executive: "is now an Executive, and Executives cannot be Staff of the Week"
};

export async function checkHolderStanding(
    client: Client,
    config: StaffBotConfig,
    discordId: string,
    cause: LateCause,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const holder = await currentHolder(config, now);
        const staff = await findStaffByDiscordId(discordId);
        if (!holder || !staff || !holder.staff._id.equals(staff._id)) return;
        // Starting leave takes the department and rank roles before it adds
        // the on-leave role, so for a moment the holder reads as not staff.
        // Leave does not touch Staff of the Week; approved or active leave
        // covering now means this is that, and there is nothing to report.
        // (`leaveOverlapping` counts approved and active leave; an ended
        // record's end has already moved to when it ended, so it never
        // covers now.)
        if (cause !== "left") {
            const covering = await leaveOverlapping(staff._id, now, new Date(now.getTime() + 1));
            if (covering.length > 0) return;
        }
        const name = await nameOf(client, config, staff);
        await postNoticeOnce(
            client,
            config,
            `late:${holder.week.start.getTime()}:${staff._id.toHexString()}:${cause}`,
            sotwCard(
                "Change to this week's Staff of the Week",
                `**${name}**, this week's Staff of the Week, ${CAUSE_TEXT[cause]}. The bot still lists ` +
                    `them as Staff of the Week. Use ${cmd("sotw remove")} to change that, then pick somebody for the rest of the week.`
            )
        );
    } catch (error) {
        log.error("Could not check the Staff of the Week holder", error);
    }
}
