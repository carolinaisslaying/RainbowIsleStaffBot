import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc, StaffOfWeekDoc } from "../db/types.js";
import { fetchPublicMember, resolveTier, wearsOnLeaveRole } from "../domain/permissions.js";
import { leaveOverlapping, pendingSpansOverlapping } from "../domain/leave.js";
import { weekLeave } from "../domain/leaveDays.js";
import { findStaffById, listActiveStaff } from "../domain/staff.js";
import { previousWeekWindow, weekWindowFor, type WeekWindow } from "../domain/weekly.js";
import {
    barredIds,
    eligibilityFor,
    handoffSettled,
    isHolding,
    targetWeeks,
    type Candidate,
    type Eligibility
} from "../domain/staffOfWeek.js";
import { findWeek, findWeeks, toHolderRecord } from "../domain/staffOfWeekStore.js";
import { sotwHandedOff } from "./notifications.js";
import { staffDisplayName } from "../discord/displayName.js";

/** The facts `eligibilityFor` needs, gathered from Discord and the database. */

export interface WeekSlots {
    current: WeekWindow;
    next: WeekWindow;
    handedOff: boolean;
}

export async function weekSlots(config: StaffBotConfig, now = new Date()): Promise<WeekSlots> {
    const calendarWeek = weekWindowFor(now, config);
    const previous = previousWeekWindow(now, config);
    const following = weekWindowFor(calendarWeek.end, config);
    const handedOff = handoffSettled({
        claimed: await sotwHandedOff(calendarWeek.start),
        now,
        weekStart: calendarWeek.start
    });
    const slots = targetWeeks({
        previousStart: previous.start,
        currentStart: calendarWeek.start,
        nextStart: following.start,
        currentHandedOff: handedOff
    });
    return {
        current: weekWindowFor(slots.current, config),
        next: weekWindowFor(slots.next, config),
        handedOff
    };
}

export async function candidateFor(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    week: WeekWindow
): Promise<Candidate> {
    const member = await fetchPublicMember(client, config, staff.discordId);
    // Leave removes the department role, which is the role tiers read. Somebody
    // on leave now is still staff, and whether their leave touches the week
    // being assigned is the leave rule's question, not this one's.
    const resolved = resolveTier(staff.discordId, member, config);
    const tier = resolved === "none" && wearsOnLeaveRole(member, config) ? "staff" : resolved;

    const [counting, pending] = await Promise.all([
        leaveOverlapping(staff._id, week.start, week.end),
        pendingSpansOverlapping(staff._id, week.start, week.end)
    ]);
    const exempt = weekLeave(counting, week.start, week.end, config.minimumLeaveDays).exempt;
    const exemptIfApproved = weekLeave(
        [...counting, ...pending],
        week.start,
        week.end,
        config.minimumLeaveDays
    ).exempt;

    return {
        staffId: staff._id.toHexString(),
        active: staff.active,
        tier,
        exemptByLeave: exempt,
        pendingLeave: !exempt && exemptIfApproved
    };
}

/** The credited holders of exactly the two week slots before `week`. */
export async function barredFor(week: WeekWindow, config: StaffBotConfig): Promise<Set<string>> {
    const first = previousWeekWindow(week.start, config).start;
    const second = previousWeekWindow(first, config).start;
    const docs = await findWeeks([first, second]);
    return barredIds([
        toHolderRecord(docs.get(first.getTime()) ?? null),
        toHolderRecord(docs.get(second.getTime()) ?? null)
    ]);
}

export async function eligibilityOf(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    week: WeekWindow,
    barred?: Set<string>
): Promise<Eligibility> {
    return eligibilityFor(
        await candidateFor(client, config, staff, week),
        barred ?? (await barredFor(week, config))
    );
}

export async function rosterFor(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<{ staff: StaffDoc; eligibility: Eligibility }[]> {
    const barred = await barredFor(week, config);
    const roster = [];
    for (const staff of await listActiveStaff()) {
        roster.push({ staff, eligibility: await eligibilityOf(client, config, staff, week, barred) });
    }
    return roster;
}

export async function currentHolder(
    config: StaffBotConfig,
    now = new Date()
): Promise<{ doc: StaffOfWeekDoc; staff: StaffDoc; week: WeekWindow } | null> {
    const week = weekWindowFor(now, config);
    const doc = await findWeek(week.start);
    if (!doc || !doc.staffId || !isHolding(doc.status)) return null;
    const staff = await findStaffById(doc.staffId);
    return staff ? { doc, staff, week } : null;
}

export async function nameOf(client: Client, config: StaffBotConfig, staff: StaffDoc): Promise<string> {
    return staffDisplayName(client, config, staff.discordId, `<@${staff.discordId}>`);
}
