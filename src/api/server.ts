import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { collections } from "../db/client.js";
import { loadConfig } from "../config/guildConfig.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { currentWeekStats, computeStreak, weekWindowFor } from "../domain/weekly.js";
import { shiftHistory } from "../domain/shifts.js";
import { log } from "../log.js";

/**
 * Internal HTTP API, bound to the compose network only.
 *
 * StaffLearn runs Postgres and Drizzle and will never share this database.
 * These endpoints are shaped around read models rather than collections, so the
 * later platform merge happens at the API contract rather than as a schema
 * migration.
 */

function json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload)
    });
    response.end(payload);
}

function authorised(request: IncomingMessage): boolean {
    if (!env.apiBearerToken) return false; // unset means closed, not open
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) return false;

    // Constant time comparison, so the token cannot be probed byte by byte.
    const expected = Buffer.from(env.apiBearerToken);
    const supplied = Buffer.from(token);
    if (expected.length !== supplied.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected[index] ^ supplied[index];
    }
    return difference === 0;
}

async function staffSummary(discordId: string) {
    const staff = await findStaffByDiscordId(discordId);
    if (!staff) return null;

    const config = await loadConfig();
    const window = weekWindowFor(new Date(), config);
    const week = await currentWeekStats(staff._id, config);
    const streak = await computeStreak(staff._id, config);
    const shifts = await shiftHistory(staff._id, 5);

    // A read model, deliberately not a document dump.
    return {
        staffId: staff._id.toHexString(),
        discordId: staff.discordId,
        active: staff.active,
        timezone: staff.timezone,
        joinedTeamAt: staff.joinedTeamAt,
        currentWeek: {
            weekStart: window.start,
            weekEnd: window.end,
            activityMinutes: week.activityMinutes,
            activityTarget: config.weeklyTargetMinutes,
            shiftMs: week.shiftMs,
            activeDays: week.activeDays,
            ringState: week.ringState,
            onLeave: week.onLeave,
            partialLeave: week.partialLeave
        },
        streakWeeks: streak,
        recentShifts: shifts.map((shift) => ({
            startedAt: shift.startedAt,
            endedAt: shift.endedAt,
            endReason: shift.endReason,
            availableMs: shift.availableMs,
            activityMinutes: shift.activityMinutes
        }))
    };
}

/**
 * Bounded on purpose. An unpaginated read of every assessment ever written
 * grows without limit and is one request away from being the largest thing this
 * process has ever held in memory. The caller asks for a page; the response
 * says whether there is more.
 */
const ASSESSMENT_PAGE_DEFAULT = 500;
const ASSESSMENT_PAGE_MAX = 2000;

async function assessmentsBetween(from: Date, to: Date, limit: number, skip: number) {
    const docs = await collections
        .fortnightAssessments()
        .find({ windowStart: { $gte: from }, windowEnd: { $lte: to } })
        .sort({ fortnightIndex: 1, _id: 1 })
        .skip(skip)
        // One more than asked for, so "is there another page" is answered
        // without a second count over the same filter.
        .limit(limit + 1)
        .toArray();

    const staffIds = [...new Set(docs.slice(0, limit).map((doc) => doc.staffId.toHexString()))];
    const staff = await collections
        .staff()
        .find({ _id: { $in: staffIds.map((id) => new ObjectId(id)) } })
        .toArray();
    const discordIds = new Map(staff.map((doc) => [doc._id.toHexString(), doc.discordId]));

    const page = docs.slice(0, limit);
    return { hasMore: docs.length > limit, rows: page.map((doc) => ({
        staffId: doc.staffId.toHexString(),
        discordId: discordIds.get(doc.staffId.toHexString()) ?? null,
        fortnightIndex: doc.fortnightIndex,
        windowStart: doc.windowStart,
        windowEnd: doc.windowEnd,
        week1Minutes: doc.week1Minutes,
        week2Minutes: doc.week2Minutes,
        totalMinutes: doc.totalMinutes,
        requiredMinutes: doc.requiredMinutes,
        status: doc.status,
        reviewOutcome: doc.reviewOutcome,
        reviewedAt: doc.reviewedAt
    })) };
}

/**
 * Page arguments, validated rather than coerced. `Number("abc")` is NaN and NaN
 * compares false against every bound, so a bad limit would otherwise sail
 * through and land in `.limit(NaN)`.
 */
export function parsePaging(
    rawLimit: string | null,
    rawSkip: string | null
): { ok: true; limit: number; skip: number } | { ok: false; error: string } {
    const limit = rawLimit === null ? ASSESSMENT_PAGE_DEFAULT : Number(rawLimit);
    const skip = rawSkip === null ? 0 : Number(rawSkip);

    if (!Number.isInteger(limit) || limit < 1 || limit > ASSESSMENT_PAGE_MAX) {
        return { ok: false, error: `limit must be a whole number from 1 to ${ASSESSMENT_PAGE_MAX}` };
    }
    if (!Number.isInteger(skip) || skip < 0) {
        return { ok: false, error: "skip must be a whole number, zero or more" };
    }
    return { ok: true, limit, skip };
}

export function startApiServer(): ReturnType<typeof createServer> | null {
    if (!env.apiBearerToken) {
        log.warn("API_BEARER_TOKEN is unset; the internal API will not be started.");
        return null;
    }

    const server = createServer((request, response) => {
        void (async () => {
            try {
                const url = new URL(request.url ?? "/", "http://internal");

                if (url.pathname === "/health") {
                    json(response, 200, { ok: true });
                    return;
                }

                if (!authorised(request)) {
                    json(response, 401, { error: "unauthorised" });
                    return;
                }

                const summaryMatch = url.pathname.match(
                    /^\/api\/staff\/(\d{15,25})\/summary$/
                );
                if (summaryMatch && request.method === "GET") {
                    const summary = await staffSummary(summaryMatch[1]);
                    if (!summary) {
                        json(response, 404, { error: "no staff record" });
                        return;
                    }
                    json(response, 200, summary);
                    return;
                }

                if (url.pathname === "/api/assessments" && request.method === "GET") {
                    const from = new Date(url.searchParams.get("from") ?? "1970-01-01");
                    const to = new Date(url.searchParams.get("to") ?? "2999-01-01");
                    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
                        json(response, 400, { error: "from and to must be ISO instants" });
                        return;
                    }

                    const paging = parsePaging(
                        url.searchParams.get("limit"),
                        url.searchParams.get("skip")
                    );
                    if (!paging.ok) {
                        json(response, 400, { error: paging.error });
                        return;
                    }

                    const result = await assessmentsBetween(
                        from,
                        to,
                        paging.limit,
                        paging.skip
                    );
                    json(response, 200, {
                        assessments: result.rows,
                        limit: paging.limit,
                        skip: paging.skip,
                        hasMore: result.hasMore
                    });
                    return;
                }

                json(response, 404, { error: "not found" });
            } catch (error) {
                log.error("Internal API request failed", error);
                json(response, 500, { error: "internal error" });
            }
        })();
    });

    // Bound to the compose network. Never published in docker-compose.yml.
    server.listen(env.apiPort, "0.0.0.0", () => {
        log.info(`Internal API listening on ${env.apiPort}`);
    });

    return server;
}
