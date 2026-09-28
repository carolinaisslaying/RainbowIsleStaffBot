import { describe, expect, it } from "vitest";
import { leaderboardCard, ringFigures, teamRecapCard } from "../src/render/cards.js";
import { EMOJI } from "../src/render/emoji.js";

const row = (overrides: Record<string, unknown> = {}) => ({
    rank: 1,
    label: "Robin",
    activityMinutes: 300,
    target: 120,
    state: "green" as const,
    isViewer: false,
    onLeave: false,
    ...overrides
});

const text = (card: { components: { toJSON(): unknown }[] }) => JSON.stringify(card.components.map((c) => c.toJSON()));

describe("the holder on the leaderboard", () => {
    const card = (rows: ReturnType<typeof row>[]) =>
        leaderboardCard({
            title: "Activity leaderboard",
            windowLabel: "This week",
            rows,
            viewerRow: null,
            page: 1,
            pageCount: 1,
            scope: "week",
            totalMinutes: 300,
            participants: rows.length
        });

    it("marks the holder's row beside the name", () => {
        expect(text(card([row({ staffOfWeek: true })]))).toContain(`**Robin** ${EMOJI.staffOfWeek}`);
    });

    it("marks nobody else", () => {
        expect(text(card([row()]))).not.toContain(EMOJI.staffOfWeek);
    });

    it("sits beside the padlock on a hidden holder's row", () => {
        expect(text(card([row({ staffOfWeek: true, hidden: true })]))).toContain(
            `**Robin** ${EMOJI.hidden} ${EMOJI.staffOfWeek}`
        );
    });
});

describe("the holder on the team recap", () => {
    const recap = (staffOfWeek: string | null) =>
        teamRecapCard({
            windowLabel: "Week",
            headline: "Headline",
            totalMinutes: "10 hours",
            teamTargetMinutes: "12 hours",
            topStreak: null,
            rings: null,
            rehearsal: false,
            staffOfWeek
        });

    it("names the new holder in the same message", () => {
        expect(text(recap("Robin"))).toContain(`${EMOJI.staffOfWeek} **Staff of the Week:** Robin`);
    });

    it("says nothing when nobody holds it", () => {
        expect(text(recap(null))).not.toContain(EMOJI.staffOfWeek);
    });
});

describe("the holder's own figures", () => {
    const base = {
        staffId: "a",
        displayName: "Robin",
        weekStart: new Date("2026-09-28T00:00:00Z"),
        weekEnd: new Date("2026-10-05T00:00:00Z"),
        activityMinutes: 10,
        activityTarget: 120,
        shiftMs: 0,
        shiftTargetHours: 4,
        activeDays: 1,
        activeDaysTarget: 3,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("counts the weeks they have held it", () => {
        const line = ringFigures({ ...base, staffOfWeek: { times: 3, last: new Date("2026-09-21T00:00:00Z") } });
        expect(line).toContain(`${EMOJI.staffOfWeek} Staff of the Week **3 times**`);
        expect(line).toContain("<t:");
    });

    it("says it once for once", () => {
        expect(ringFigures({ ...base, staffOfWeek: { times: 1, last: new Date("2026-09-21T00:00:00Z") } })).toContain(
            "**once**"
        );
    });

    it("says nothing for somebody who never has", () => {
        expect(ringFigures({ ...base, staffOfWeek: { times: 0, last: null } })).not.toContain(EMOJI.staffOfWeek);
    });
});
