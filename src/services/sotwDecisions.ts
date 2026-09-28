import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { findStaffById } from "../domain/staff.js";
import { getStoredWeek, previousWeekWindow, weekWindowFor } from "../domain/weekly.js";
import { countMinutesBetween } from "../domain/activity.js";
import { audit } from "../domain/audit.js";
import {
    PENDING_LEAVE_NOTE,
    creditedHolders,
    isHolding,
    refusalText,
    restOfWeekOffered
} from "../domain/staffOfWeek.js";
import {
    findWeek,
    recentWeeks,
    recordGrant,
    recordPick,
    recordRemoval,
    recordSkip,
    toHolderRecord
} from "../domain/staffOfWeekStore.js";
import { stageSet } from "../domain/sotwStaging.js";
import { errorCard, type RenderedMessage } from "../render/cards.js";
import { sotwCard, viewCard, weekChoiceCard, type Leader } from "../render/sotwCards.js";
import { EMOJI } from "../render/emoji.js";
import { labelWindow } from "../time/format.js";
import { cmd } from "../discord/commandMentions.js";
import { currentHolder, eligibilityOf, nameOf, rosterFor, weekSlots } from "./sotwContext.js";
import { handRoleTo, takeRoleFrom } from "./sotwRole.js";
import { congratulate } from "./sotwHandoff.js";
import { decisionLine, postNotice } from "./sotwNotices.js";

/**
 * What an Executive can decide. Each returns the card they see; each posts a
 * notice to the channel so the others have the same record.
 */

const label = (config: StaffBotConfig, week: { start: Date; end: Date }) =>
    labelWindow(week.start, week.end, config.accountingTimezone);

/** `/sotw set`: straight to next week, or ask first when nobody holds this one. */
export async function offerOrSet(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const current = await findWeek(slots.current.start);
    const offered = restOfWeekOffered(
        current ? { status: current.status, staffId: current.staffId?.toHexString() ?? null } : null,
        slots.handedOff
    );
    if (!offered) return setNextWeek(client, config, actorId, subject, reason, now);

    stageSet(actorId, subject._id.toHexString(), reason);
    return weekChoiceCard({
        staffId: subject._id.toHexString(),
        name: await nameOf(client, config, subject),
        currentLabel: label(config, slots.current),
        nextLabel: label(config, slots.next)
    });
}

export async function setNextWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const name = await nameOf(client, config, subject);
    const verdict = await eligibilityOf(client, config, subject, slots.next);
    if (!verdict.eligible) return errorCard(refusalText(verdict.reason, name));

    const { replaced } = await recordPick(slots.next.start, subject._id, actorId, reason, now);
    await audit("sotw.set", {
        actorId,
        targetStaffId: subject._id,
        detail: { weekStart: slots.next.start, reason, replaced: replaced?.toHexString() ?? null }
    });

    // The closed week is the one before `current`; its minutes are shown and
    // never required.
    const closed = previousWeekWindow(slots.current.start, config);
    const stored = await getStoredWeek(subject._id, closed.start);
    const minutes = stored?.activityMinutes ?? (await countMinutesBetween(subject._id, closed.start, closed.end));
    const replacedName = replaced ? await findStaffById(replaced).then((staff) => (staff ? nameOf(client, config, staff) : null)) : null;

    const body =
        `**${name}** will be Staff of the Week for ${label(config, slots.next)}.\n` +
        (replacedName ? `This replaces **${replacedName}**.\n` : "") +
        (verdict.pendingLeave ? `${EMOJI.warning} ${name} ${PENDING_LEAVE_NOTE}.\n` : "") +
        `-# Last week: ${minutes} of ${config.weeklyTargetMinutes} minutes. For information only; ` +
        "meeting the minimum is not required for a pick. They are told when the week begins.";

    await postNotice(
        client,
        config,
        sotwCard(
            "Staff of the Week picked",
            `<@${actorId}> picked **${name}** for ${label(config, slots.next)}.` +
                (replacedName ? ` This replaces **${replacedName}**.` : "") +
                (reason ? `\n> ${reason}` : "")
        )
    );
    return sotwCard("Staff of the Week picked", body, { ephemeral: true });
}

export async function skipNextWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    await recordSkip(slots.next.start, actorId, reason, now);
    await audit("sotw.skip", { actorId, detail: { weekStart: slots.next.start, reason } });
    const week = label(config, slots.next);
    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week skipped", `<@${actorId}> skipped ${week}: nobody will hold it, and there is no draw.` + (reason ? `\n> ${reason}` : ""))
    );
    return sotwCard(
        "Week skipped",
        `Nobody will hold Staff of the Week for ${week}, and there will be no draw. A pick before the ` +
            "week begins replaces this.",
        { ephemeral: true }
    );
}

export async function grantRestOfWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const current = await findWeek(slots.current.start);
    // Holding, not a staffId: a pick left pending by a handoff that never
    // finished names somebody who holds nothing.
    if (current && isHolding(current.status)) return errorCard("Somebody already holds Staff of the Week this week.");

    const name = await nameOf(client, config, subject);
    const verdict = await eligibilityOf(client, config, subject, slots.current);
    if (!verdict.eligible) return errorCard(refusalText(verdict.reason, name));

    await recordGrant(
        slots.current.start,
        { staffId: subject._id, status: "picked", decidedBy: actorId, eventKind: "set", reason, detail: { restOfWeek: true } },
        now
    );
    const role = await handRoleTo(client, config, subject, `Staff of the Week for the rest of ${label(config, slots.current)}`);
    await congratulate(client, config, subject, role.colour);
    await audit("sotw.restOfWeek", { actorId, targetStaffId: subject._id, detail: { weekStart: slots.current.start, reason } });

    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week given", `<@${actorId}> gave **${name}** Staff of the Week for the rest of this week.` + (reason ? `\n> ${reason}` : ""))
    );
    return sotwCard(
        "Staff of the Week given",
        `**${name}** holds Staff of the Week for the rest of this week, and has been told.` +
            (role.granted ? "" : `\n${EMOJI.warning} The role could not be given in the community server.`),
        { ephemeral: true }
    );
}

export async function removeHolder(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    reason: string,
    expectedStaffId: string,
    guildId: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const holder = await currentHolder(config, now);
    if (!holder) return errorCard("Nobody holds Staff of the Week right now.");
    // The modal can sit open while the week is handed off or somebody else
    // removes and re-grants it: remove the person it named or nobody.
    if (holder.staff._id.toHexString() !== expectedStaffId) {
        return errorCard(`That holder has changed. Run ${cmd("sotw remove", guildId)} again.`);
    }

    await recordRemoval(holder.week.start, holder.staff._id, actorId, reason, now);
    const roleTaken = await takeRoleFrom(client, config, holder.staff, `Staff of the Week removed: ${reason}`.slice(0, 500));
    await audit("sotw.remove", { actorId, targetStaffId: holder.staff._id, detail: { weekStart: holder.week.start, reason } });

    const name = await nameOf(client, config, holder.staff);
    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week removed", `<@${actorId}> took Staff of the Week from **${name}**.\n> ${reason}`)
    );
    return sotwCard(
        "Staff of the Week removed",
        `**${name}** no longer holds it. They are not barred from the next two weeks, and this week ` +
            `is not counted as theirs. Pick somebody for the rest of the week with ${cmd("sotw set", guildId)}.` +
            (roleTaken ? "" : `\n${EMOJI.warning} The role could not be taken off in the community server.`),
        { ephemeral: true }
    );
}

export async function viewFor(client: Client, config: StaffBotConfig, now = new Date()): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const [currentDoc, nextDoc] = await Promise.all([findWeek(slots.current.start), findWeek(slots.next.start)]);

    const describe = async (doc: typeof currentDoc) => {
        if (!doc) return "Nothing recorded.";
        const holder = doc.staffId ? await findStaffById(doc.staffId) : null;
        const who = holder ? `**${await nameOf(client, config, holder)}**` : "Nobody";
        switch (doc.status) {
            case "picked":
                return `${who}, picked by <@${doc.decidedBy}>.`;
            case "random":
                return `${who}, drawn at random.`;
            case "skipped":
                return `Nobody: skipped by <@${doc.decidedBy}>.`;
            case "empty":
                return (doc.removedHolders?.length ?? 0) > 0 ? "Nobody: the holder was removed." : "Nobody: nobody qualified.";
            case "pending":
                return await decisionLine(client, config, doc);
        }
    };

    const history: string[] = [];
    for (const doc of await recentWeeks(slots.current.start, 4)) {
        const names = [];
        for (const id of creditedHolders(toHolderRecord(doc))) {
            const staff = await findStaffById(new ObjectId(id));
            if (staff) names.push(await nameOf(client, config, staff));
        }
        history.push(`- ${label(config, weekWindowFor(doc.weekStart, config))}: ${names.join(", ") || "nobody"}`);
    }

    const eligible: Leader[] = [];
    for (const entry of await rosterFor(client, config, slots.next)) {
        if (!entry.eligibility.eligible) continue;
        eligible.push({
            name: await nameOf(client, config, entry.staff),
            minutes: await countMinutesBetween(entry.staff._id, slots.current.start, now),
            pendingLeave: entry.eligibility.pendingLeave
        });
    }
    eligible.sort((left, right) => right.minutes - left.minutes);

    return viewCard({
        current: await describe(currentDoc),
        next: nextDoc ? await describe(nextDoc) : await decisionLine(client, config, null),
        history,
        eligible: eligible.slice(0, 10),
        target: config.weeklyTargetMinutes
    });
}
