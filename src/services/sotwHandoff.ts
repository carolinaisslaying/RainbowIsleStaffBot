import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc, StaffOfWeekDoc } from "../db/types.js";
import { collections } from "../db/client.js";
import { findStaffById } from "../domain/staff.js";
import { previousWeekWindow, weekWindowFor, type WeekWindow } from "../domain/weekly.js";
import {
    bootHandoff,
    decideHandoff,
    drawPool,
    handoffSettled,
    refusalText,
    sotwEnabled,
    type Eligibility,
    type HandoffDecision,
    type Refusal,
    type Standing
} from "../domain/staffOfWeek.js";
import {
    appendEvent,
    findWeek,
    markHandedOff,
    recordEmpty,
    recordGrant,
    sotwEvent
} from "../domain/staffOfWeekStore.js";
import { downgradeNote } from "../domain/sotwColour.js";
import { congratsCard, handoffText, sotwCard, type HandoffSummary } from "../render/sotwCards.js";
import { pickCongratulation } from "../render/sotwMessages.js";
import { tryDm } from "../discord/roles.js";
import { sendOptions } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { labelWindow } from "../time/format.js";
import { claimSotwHandoff, sotwHandedOff } from "./notifications.js";
import { currentHolder, eligibilityOf, nameOf, rosterFor } from "./sotwContext.js";
import { handRoleTo, type ColourWrite } from "./sotwRole.js";
import { previewFor } from "./sotwPreviewService.js";
import { postNotice } from "./sotwNotices.js";
import { log } from "../log.js";

/**
 * The week boundary. Runs inside `closeWeek` after the rollup, because the draw
 * reads the closed week's frozen figures, and before the team recap, which
 * names the new holder.
 */

export async function drawPoolFor(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    standings: Standing[]
): Promise<Standing[]> {
    const eligibility = new Map<string, Eligibility>(
        (await rosterFor(client, config, week)).map((entry) => [entry.staff._id.toHexString(), entry.eligibility])
    );
    return drawPool(standings, config.weeklyTargetMinutes, eligibility);
}

async function closedStandings(week: WeekWindow, config: StaffBotConfig): Promise<Standing[]> {
    const closed = previousWeekWindow(week.start, config);
    const rows = await collections.weeklyStats().find({ weekStart: closed.start }).toArray();
    return rows.map((row) => ({ staffId: row.staffId.toHexString(), minutes: row.activityMinutes }));
}

export async function congratulate(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc,
    colour: ColourWrite,
    rng: () => number = Math.random
): Promise<boolean> {
    const saved = holder.sotwColour ?? null;
    const colourLine = !saved
        ? `The role has no colour yet — choose one with ${cmd("settings sotw-colour")} and it will ` +
          "be kept for next time."
        : !colour.ok
          ? "Your colour is saved and goes on the role as soon as the bot can reach it."
          : colour.downgraded
            ? (downgradeNote(saved) ?? "Your colour is on the role.")
            : "Your colour is on the role.";
    const card = congratsCard({
        message: pickCongratulation(rng),
        colourLine,
        preview: await previewFor(client, config, holder.discordId, saved)
    });
    const delivered = await tryDm(client, holder.discordId, sendOptions(card));
    if (!delivered) log.warn(`Could not DM the Staff of the Week congratulation to ${holder.discordId}`);
    return delivered;
}

/** The pending pick, if the week has one, and whether it may still hold the week. */
async function pendingPick(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    doc: StaffOfWeekDoc | null
): Promise<{ pickStaff: StaffDoc | null; pickEligibility: Eligibility | null }> {
    if (doc?.status !== "pending" || !doc.staffId) return { pickStaff: null, pickEligibility: null };
    const pickStaff = await findStaffById(doc.staffId);
    const pickEligibility: Eligibility = pickStaff
        ? await eligibilityOf(client, config, pickStaff, week)
        : { eligible: false, reason: "inactive" };
    return { pickStaff, pickEligibility };
}

interface HandoffOutcome {
    doc: StaffOfWeekDoc | null;
    pickStaff: StaffDoc | null;
    decision: HandoffDecision;
    pickFailed: Refusal | null;
    pool: Standing[];
    /** Finished after the week began, so nothing was drawn and an empty week says so. */
    midWeek: boolean;
}

/**
 * Everything after the decision: the record, the role, the congratulation,
 * the notice and `markHandedOff`. Shared by the boundary and by boot finishing
 * a handoff that never ran, so a pick honoured late is written the same way.
 */
async function completeHandoff(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    outcome: HandoffOutcome,
    now: Date,
    rng: () => number
): Promise<void> {
    const { doc, pickStaff, decision, pickFailed, pool } = outcome;
    const pickName = pickStaff ? await nameOf(client, config, pickStaff) : "The recorded pick";
    const failedText = pickFailed ? refusalText(pickFailed, pickName) : null;
    if (pickFailed) {
        await appendEvent(
            week.start,
            sotwEvent("pickFailed", { staffId: doc?.staffId ?? null, reason: pickFailed }, now)
        );
    }

    const poolDetail = { pool: pool.map((row) => ({ staffId: row.staffId, minutes: row.minutes })) };
    let holder: StaffDoc | null = null;
    if (decision.kind === "picked") {
        holder = pickStaff;
        await recordGrant(
            week.start,
            { staffId: new ObjectId(decision.staffId), status: "picked", decidedBy: doc?.decidedBy ?? null, eventKind: null, reason: null, detail: null },
            now
        );
    } else if (decision.kind === "random") {
        holder = await findStaffById(new ObjectId(decision.staffId));
        await recordGrant(
            week.start,
            { staffId: new ObjectId(decision.staffId), status: "random", decidedBy: null, eventKind: "drawn", reason: null, detail: poolDetail },
            now
        );
    } else if (decision.kind === "empty") {
        await recordEmpty(
            week.start,
            outcome.midWeek
                ? "The pick could not be honoured, and there is no draw once the week has begun."
                : "Nobody qualified for the draw.",
            outcome.midWeek ? null : poolDetail,
            now
        );
    }

    const label = labelWindow(week.start, week.end, config.accountingTimezone);
    // The receipt is already claimed, so a throw here must not swallow the
    // congratulation, the notice and `markHandedOff` that follow — a full
    // guild member fetch (`membersWithRole`, inside `handRoleTo`) has no catch
    // of its own, and a spent receipt means nothing would ever retry this week.
    let role: { granted: boolean; colour: ColourWrite };
    try {
        role = await handRoleTo(client, config, holder, `Staff of the Week for ${label}`);
    } catch (error) {
        log.error("Could not hand over the Staff of the Week role", error);
        role = { granted: false, colour: { ok: false, downgraded: false, colours: null } };
    }
    if (holder) await congratulate(client, config, holder, role.colour, rng);

    const poolNames: string[] = [];
    for (const row of pool) {
        const member = await findStaffById(new ObjectId(row.staffId));
        if (member) poolNames.push(await nameOf(client, config, member));
    }
    const holderName = holder ? await nameOf(client, config, holder) : "";
    const summary: HandoffSummary =
        decision.kind === "picked"
            ? { kind: "picked", holder: holderName, by: `<@${doc?.decidedBy}>` }
            : decision.kind === "random"
              ? { kind: "random", holder: holderName, pool: poolNames, failedPick: failedText }
              : decision.kind === "skipped"
                ? { kind: "skipped", by: `<@${doc?.decidedBy}>` }
                : { kind: "empty", failedPick: failedText, midWeek: outcome.midWeek };
    await postNotice(client, config, sotwCard(`Staff of the Week, ${label}`, handoffText(summary)));

    await markHandedOff(
        week.start,
        { decision: decision.kind, colourOk: role.colour.ok, granted: role.granted, ...(outcome.midWeek ? { midWeek: true } : {}) },
        now
    );
}

export async function runHandoff(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    now = new Date(),
    rng: () => number = Math.random
): Promise<boolean> {
    if (!sotwEnabled(config)) return false;
    if (!(await claimSotwHandoff(week.start))) return false;

    const doc = await findWeek(week.start);
    const { pickStaff, pickEligibility } = await pendingPick(client, config, week, doc);
    const needsDraw = doc?.status !== "skipped";
    const pool = needsDraw ? await drawPoolFor(client, config, week, await closedStandings(week, config)) : [];
    const { decision, pickFailed } = decideHandoff({
        week: doc ? { status: doc.status, staffId: doc.staffId?.toHexString() ?? null } : null,
        pickEligibility,
        pool,
        rng
    });
    await completeHandoff(client, config, week, { doc, pickStaff, decision, pickFailed, pool, midWeek: false }, now, rng);
    return true;
}

/**
 * A pick for a week that has already begun: checked against the hard refusals
 * alone, as at the boundary, but never replaced by a draw. A pick that fails
 * leaves the week empty and says why.
 */
async function honourPickMidWeek(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    doc: StaffOfWeekDoc | null,
    now: Date,
    rng: () => number = Math.random
): Promise<void> {
    const { pickStaff, pickEligibility } = await pendingPick(client, config, week, doc);
    const { decision, pickFailed } = decideHandoff({
        week: doc ? { status: doc.status, staffId: doc.staffId?.toHexString() ?? null } : null,
        pickEligibility,
        pool: [],
        rng
    });
    await completeHandoff(client, config, week, { doc, pickStaff, decision, pickFailed, pool: [], midWeek: true }, now, rng);
}

/** Never lets the handoff stop the recap or the assessment that follow it. */
export async function runHandoffSafely(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    now = new Date()
): Promise<void> {
    try {
        if (await runHandoff(client, config, week, now)) log.info("Handed Staff of the Week over.");
    } catch (error) {
        log.error("The Staff of the Week handoff failed", error);
    }
}

/** The holder keeps the role and their colour; everyone else loses it. Idempotent. */
export async function reassertRole(client: Client, config: StaffBotConfig, now = new Date()): Promise<void> {
    const holder = await currentHolder(config, now);
    await handRoleTo(client, config, holder?.staff ?? null, "Staff of the Week: re-asserted on boot");
}

/**
 * At boot, after the catch-up. The current week only: a missed week in the
 * past cannot usefully be handed off. `bootHandoff` decides; nothing here ever
 * draws once the week has begun, because drawing then is exactly what
 * `handoffSettled`/`HANDOFF_GRACE_MS` exist to stop.
 *
 * A cold start records the week as empty only when nothing is recorded for it.
 * Past the grace hour, an Executive's pick still waiting on a handoff that
 * never ran — the bot was down, or `closeWeek` failed partway — is honoured
 * against the hard refusals, because left pending it strands the week: nobody
 * holds the role, `/sotw view` names the pick, and the rest of the week cannot
 * be given to anybody else. A week without a pick is recorded as empty; a
 * skipped week stays skipped, and its notice was posted when it was skipped.
 * A handoff that claimed its receipt and stopped before
 * `markHandedOff` is finished without claiming again; one that had already
 * granted the role is only marked, so nobody is congratulated twice.
 */
export async function handoffOnBoot(
    client: Client,
    config: StaffBotConfig,
    coldStart: boolean,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const week = weekWindowFor(now, config);
        const doc = await findWeek(week.start);
        const action = bootHandoff({
            coldStart,
            claimed: await sotwHandedOff(week.start),
            handedOff: (doc?.handedOffAt ?? null) !== null,
            pastGrace: handoffSettled({ claimed: false, now, weekStart: week.start }),
            week: doc ? { status: doc.status, staffId: doc.staffId?.toHexString() ?? null } : null
        });

        switch (action.kind) {
            case "run":
                await runHandoff(client, config, week, now);
                return;
            case "reassert":
                await reassertRole(client, config, now);
                return;
            case "coldStart":
                if (await claimSotwHandoff(week.start)) {
                    if (!doc) await recordEmpty(week.start, "Staff of the Week started mid-week.", null, now);
                    await markHandedOff(week.start, { decision: "coldStart" }, now);
                }
                await reassertRole(client, config, now);
                return;
        }

        if (action.claim && !(await claimSotwHandoff(week.start))) {
            await reassertRole(client, config, now);
            return;
        }
        if (action.kind === "pick") {
            await honourPickMidWeek(client, config, week, doc, now);
            return;
        }
        if (action.kind === "empty") {
            await recordEmpty(
                week.start,
                doc
                    ? "The handoff did not run before the week began, and there is no draw once it has."
                    : "Staff of the Week started mid-week.",
                null,
                now
            );
            await markHandedOff(week.start, { decision: "empty", midWeek: true }, now);
        } else {
            await markHandedOff(week.start, { decision: doc?.status ?? null, resumed: !action.claim }, now);
        }
        await reassertRole(client, config, now);
    } catch (error) {
        log.error("The Staff of the Week boot handoff failed", error);
    }
}
