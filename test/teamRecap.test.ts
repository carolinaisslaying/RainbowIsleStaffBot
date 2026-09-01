import { describe, expect, it } from "vitest";
import { summariseTeamWeek, teamRecapHeadline } from "../src/domain/teamRecap.js";
import type { TeamWeekRow } from "../src/domain/teamRecap.js";

const row = (minutes: number, extra: Partial<TeamWeekRow> = {}): TeamWeekRow => ({
    activityMinutes: minutes,
    shiftMs: minutes * 60_000,
    activeDays: minutes > 0 ? 3 : 0,
    ringState: minutes >= 120 ? "green" : "red",
    onLeave: false,
    ...extra
});

describe("summarising the team's week", () => {
    it("counts who closed and who was away", () => {
        const week = summariseTeamWeek(
            [row(200), row(130), row(40), row(0, { ringState: "leave", onLeave: true })],
            null
        );
        expect(week.counted).toBe(3);
        expect(week.closed).toBe(2);
        expect(week.onLeave).toBe(1);
    });

    it("leaves people on leave out of every average", () => {
        // Counting them drags the team's figures down for a week nobody was
        // expected to work, which makes a good week look like a bad one.
        const withLeave = summariseTeamWeek(
            [row(300), row(300), row(0, { ringState: "leave", onLeave: true })],
            null
        );
        expect(withLeave.meanMinutes).toBe(300);
        expect(withLeave.totalMinutes).toBe(600);
    });

    it("takes the median of an even roster from the middle pair", () => {
        expect(summariseTeamWeek([row(10), row(20), row(30), row(50)], null).medianMinutes).toBe(
            25
        );
    });

    it("reports no comparison rather than an infinite rise from zero", () => {
        // A previous week of zero has no percentage to be a change from.
        expect(summariseTeamWeek([row(300)], 0).deltaPercent).toBeNull();
        expect(summariseTeamWeek([row(300)], null).deltaPercent).toBeNull();
    });

    it("reports the change against the previous week", () => {
        expect(summariseTeamWeek([row(110), row(110)], 200).deltaPercent).toBe(10);
        expect(summariseTeamWeek([row(90), row(90)], 200).deltaPercent).toBe(-10);
    });

    it("survives an empty roster", () => {
        const week = summariseTeamWeek([], null);
        expect(week).toMatchObject({ counted: 0, closed: 0, totalMinutes: 0, meanMinutes: 0 });
    });

    it("sums the soft rings over the same people as the outer one", () => {
        // The rings are drawn against targets multiplied by the counted head
        // count, so a member excluded from one total and not another would put
        // the team above its own target for a week it did not earn.
        const week = summariseTeamWeek(
            [
                row(120),
                row(120),
                row(0, { onLeave: true, ringState: "leave", shiftMs: 999, activeDays: 9 })
            ],
            null
        );
        expect(week.counted).toBe(2);
        expect(week.totalActiveDays).toBe(6);
        expect(week.totalShiftMs).toBe(120 * 60_000 * 2);
    });
});

describe("the headline", () => {
    it("reads correctly when nobody closed anything", () => {
        const line = teamRecapHeadline(summariseTeamWeek([row(0), row(0)], 500));
        expect(line).toContain("0 of 2");
        expect(line).toContain("down on last week");
    });

    it("says when there is nothing to compare against", () => {
        expect(teamRecapHeadline(summariseTeamWeek([row(200)], null))).toContain(
            "No previous week"
        );
    });

    it("says level rather than 0% up", () => {
        expect(teamRecapHeadline(summariseTeamWeek([row(200)], 200))).toContain("Level with");
    });

    it("does not claim a roster of nobody closed nothing", () => {
        // An empty week said "0 of 0 closed their activity ring", which reads
        // as a failure rather than as an empty roster.
        expect(teamRecapHeadline(summariseTeamWeek([], null))).toContain("Nobody was on the roster");
    });

    it("says so when the whole team was on leave", () => {
        const line = teamRecapHeadline(
            summariseTeamWeek([row(0, { onLeave: true, ringState: "leave" })], null)
        );
        expect(line).toContain("Everybody was on leave");
    });

    it("mentions people on leave without counting them as failures", () => {
        const line = teamRecapHeadline(
            summariseTeamWeek([row(200), row(0, { onLeave: true, ringState: "leave" })], null)
        );
        expect(line).toContain("1 of 1");
        expect(line).toContain("1 was on leave");
    });
});
