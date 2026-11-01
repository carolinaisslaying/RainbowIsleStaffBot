import type { LeaveDoc, RetiredCause, StaffDoc } from "../db/types.js";

/**
 * Who is on the team, as pure rules, so the cases that matter are tested without
 * a guild. Holding a tier in the public guild is what being on the team means;
 * this decides what a reading of that means for a record.
 *
 * Only Discord's own answer moves anybody. A lookup that failed is not evidence
 * of anything, and leave takes the department role from people who have not
 * gone anywhere.
 */

export type MemberReading =
    | { kind: "unknown" }
    | { kind: "absent" }
    | { kind: "present"; hasTier: boolean };

export type RetirementAction =
    | { kind: "none" }
    | { kind: "retire"; cause: RetiredCause }
    | { kind: "return" };

export function retirementAction(input: {
    active: boolean;
    /** Named in the deployment's administrators, who are never retired. */
    seeded: boolean;
    onLeave: boolean;
    reading: MemberReading;
}): RetirementAction {
    if (input.seeded) return input.active ? { kind: "none" } : { kind: "return" };
    if (input.reading.kind === "unknown") return { kind: "none" };

    if (input.reading.kind === "absent") {
        // Leaving the server ends everything, leave included.
        return input.active ? { kind: "retire", cause: "left_server" } : { kind: "none" };
    }

    if (input.reading.hasTier) return input.active ? { kind: "none" } : { kind: "return" };
    if (!input.active || input.onLeave) return { kind: "none" };
    return { kind: "retire", cause: "role_removed" };
}

/**
 * Whether leave explains a missing department role.
 *
 * Approved leave whose start has arrived counts as well as active leave:
 * activation takes the roles before it marks the record, so the member update
 * from that removal arrives while the record still says `approved`. Reading that
 * as somebody quitting would cancel the leave that had just begun.
 */
export function isOnLeaveNow(
    leave: readonly Pick<LeaveDoc, "status" | "startDate">[],
    wearsOnLeaveRole: boolean,
    now: Date
): boolean {
    if (wearsOnLeaveRole) return true;
    return leave.some(
        (record) =>
            record.status === "active" ||
            (record.status === "approved" && record.startDate.getTime() <= now.getTime())
    );
}

/** How long somebody stays retired before their leave is closed. */
export const LEAVE_CLOSE_DELAY_MS = 5 * 60_000;

/** Whether retirement has lasted long enough to close their leave. No date is long enough. */
export function leaveCloseDue(retiredAt: Date | null | undefined, now: Date): boolean {
    return !retiredAt || now.getTime() - retiredAt.getTime() >= LEAVE_CLOSE_DELAY_MS;
}

/**
 * Why the role settings cannot be trusted to say who is on the team, or null.
 *
 * `tierOf` answers `none` for a member fetched perfectly well when the roles are
 * unset or deleted, so a bad configuration reads exactly like everybody quitting.
 */
export function staffRolesProblem(
    roles: { moderationDepartmentRole: string; leadRoles: string[]; executiveRoles: string[] },
    existingRoleIds: ReadonlySet<string>
): string | null {
    if (!roles.moderationDepartmentRole) return "moderationDepartmentRole is unset";
    const keys: [string, string[]][] = [
        ["moderationDepartmentRole", [roles.moderationDepartmentRole]],
        ["leadRoles", roles.leadRoles],
        ["executiveRoles", roles.executiveRoles]
    ];
    for (const [key, ids] of keys) {
        const missing = ids.find((id) => !existingRoleIds.has(id));
        if (missing) return `${key} names a role that no longer exists (${missing})`;
    }
    return null;
}

/** More than this share of the roster at once looks like a fault, not a decision. */
export const SWEEP_THRESHOLD = 0.25;

export function sweepOverThreshold(retiring: number, roster: number): boolean {
    return roster > 0 && retiring / roster > SWEEP_THRESHOLD;
}

/**
 * A closed week lists a retired person only if they logged minutes in it. People
 * still on the team are listed either way.
 */
export function appearsInClosedWeek(input: { active: boolean; minutes: number }): boolean {
    return input.active || input.minutes > 0;
}

/** Time spent off the team, as spans `hoursTouchedBy` can read like leave. */
export function retiredSpans(
    staff: Pick<StaffDoc, "retiredAt" | "retiredPeriods">,
    now: Date
): { startDate: Date; endDate: Date }[] {
    const spans = (staff.retiredPeriods ?? []).map((period) => ({
        startDate: period.from,
        endDate: period.to
    }));
    if (staff.retiredAt) spans.push({ startDate: staff.retiredAt, endDate: now });
    return spans;
}
