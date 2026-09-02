import { describe, expect, it } from "vitest";
import {
    activeWarningCount,
    warningWeightLine,
    countsNow,
    lifetimeDaysFor,
    warningIsSpent,
    warningTally,
    type WarningLike
} from "../src/domain/review.js";
import { DEFAULT_CONFIG } from "../src/config/guildConfig.js";

const DAY = 86_400_000;
const now = new Date("2026-09-02T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

/** The shipped ladder: Caution 90, Misconduct 180, Serious Misconduct never. */
const config = {
    warningExpiryDays: 180,
    cautionExpiryDays: 90,
    misconductExpiryDays: 180,
    seriousMisconductExpiryDays: 0
};

const conduct = (tier: WarningLike["tier"], days: number): WarningLike => ({
    kind: "conduct",
    tier,
    issuedAt: ago(days)
});

const activity = (days: number): WarningLike => ({ kind: "activity", issuedAt: ago(days) });

describe("how long a warning counts for", () => {
    it("reads each conduct rung from its own key", () => {
        expect(lifetimeDaysFor(conduct("caution", 0), config)).toBe(90);
        expect(lifetimeDaysFor(conduct("misconduct", 0), config)).toBe(180);
        expect(lifetimeDaysFor(conduct("seriousMisconduct", 0), config)).toBe(0);
    });

    it("leaves activity warnings on warningExpiryDays", () => {
        expect(lifetimeDaysFor(activity(0), config)).toBe(180);
    });

    it("treats a warning with no kind as activity", () => {
        // Every warning written before conduct warnings existed looks like this.
        expect(lifetimeDaysFor({ issuedAt: ago(0) }, config)).toBe(180);
    });

    it("reads a conduct warning with no tier as the middle rung", () => {
        // Nothing writes this, but a hand-edited document could. Guessing
        // upward would make a data error harsher than any decision anybody took.
        expect(lifetimeDaysFor({ kind: "conduct", issuedAt: ago(0) }, config)).toBe(180);
    });
});

describe("the ladder in practice", () => {
    it("spends a Caution after ninety days, not after a hundred and eighty", () => {
        expect(warningIsSpent(conduct("caution", 89), now, config)).toBe(false);
        expect(warningIsSpent(conduct("caution", 91), now, config)).toBe(true);
        // The activity clock would still be running here. The point of the rung.
        expect(warningIsSpent(activity(91), now, config)).toBe(false);
    });

    it("counts a Caution issued exactly on its boundary", () => {
        expect(warningIsSpent(conduct("caution", 90), now, config)).toBe(false);
    });

    it("never spends Serious Misconduct, however long ago", () => {
        // The example that drove the ladder: this should not stop counting
        // because enough months went by.
        expect(warningIsSpent(conduct("seriousMisconduct", 10), now, config)).toBe(false);
        expect(warningIsSpent(conduct("seriousMisconduct", 5000), now, config)).toBe(false);
    });

    it("treats any zero lifetime as permanent, not as instantly spent", () => {
        expect(
            warningIsSpent(activity(9999), now, { ...config, warningExpiryDays: 0 })
        ).toBe(false);
    });
});

describe("what counts right now", () => {
    it("excludes a rehearsal's warning", () => {
        expect(countsNow({ issuedAt: ago(1), rehearsal: true }, now, config)).toBe(false);
    });

    it("excludes a withdrawn warning even when its clock is still running", () => {
        // Withdrawal beats every clock, including a permanent one.
        expect(
            countsNow({ ...conduct("misconduct", 1), withdrawnAt: ago(0) }, now, config)
        ).toBe(false);
        expect(
            countsNow(
                { ...conduct("seriousMisconduct", 1), withdrawnAt: ago(0) },
                now,
                config
            )
        ).toBe(false);
    });

    it("counts an ordinary unexpired warning", () => {
        expect(countsNow(conduct("misconduct", 1), now, config)).toBe(true);
    });
});

describe("the total across a mixed record", () => {
    const record: WarningLike[] = [
        conduct("seriousMisconduct", 900), // permanent, counts
        conduct("misconduct", 10), // counts
        conduct("caution", 120), // spent at 90
        activity(10), // counts
        activity(200), // spent at 180
        { ...conduct("misconduct", 5), withdrawnAt: ago(1) }, // withdrawn
        { ...activity(2), rehearsal: true } // never real
    ];

    it("counts one total across both kinds", () => {
        expect(activeWarningCount(record, now, config)).toBe(3);
    });

    it("splits that total by kind without changing it", () => {
        const tally = warningTally(record, now, config);
        expect(tally).toEqual({ total: 3, conduct: 2, activity: 1 });
        expect(tally.conduct + tally.activity).toBe(tally.total);
    });

    it("counts nothing on an empty record", () => {
        expect(warningTally([], now, config)).toEqual({ total: 0, conduct: 0, activity: 0 });
    });

    it("keeps every entry on the record even when none of them count", () => {
        // The tally is about what counts; the record still holds all seven.
        expect(record).toHaveLength(7);
    });
});

describe("the shipped defaults", () => {
    it("match the ladder as designed", () => {
        expect(DEFAULT_CONFIG.cautionExpiryDays).toBe(90);
        expect(DEFAULT_CONFIG.misconductExpiryDays).toBe(180);
        expect(DEFAULT_CONFIG.seriousMisconductExpiryDays).toBe(0);
    });

    it("leaves the activity clock where it was", () => {
        expect(DEFAULT_CONFIG.warningExpiryDays).toBe(180);
    });

    it("ships no warning channel, so a deployment must choose one", () => {
        expect(DEFAULT_CONFIG.warningChannelId).toBe("");
    });
});


describe("what the review row tells an Executive", () => {
    it("says nothing counts when nothing does", () => {
        expect(warningWeightLine({ total: 0, conduct: 0, activity: 0 })).toContain(
            "No warnings"
        );
    });

    it("breaks one total down by kind", () => {
        const line = warningWeightLine({ total: 3, conduct: 2, activity: 1 });
        expect(line).toContain("3 warnings currently count");
        expect(line).toContain("2 conduct, 1 activity");
        expect(line).toContain("their 4th");
    });

    it("omits a kind that has none rather than printing a zero", () => {
        expect(warningWeightLine({ total: 2, conduct: 2, activity: 0 })).toContain(
            "(2 conduct)"
        );
        expect(warningWeightLine({ total: 2, conduct: 0, activity: 2 })).toContain(
            "(2 activity)"
        );
    });

    it("reads correctly at one", () => {
        const line = warningWeightLine({ total: 1, conduct: 1, activity: 0 });
        expect(line).toContain("1 warning currently counts");
        expect(line).toContain("their 2nd");
    });

    it("never suggests what should happen next", () => {
        // The bot surfaces the count and refuses to act on it. It has never
        // escalated on its own and must not start by implying an outcome.
        const line = warningWeightLine({ total: 5, conduct: 4, activity: 1 }).toLowerCase();
        expect(line).not.toContain("should");
        expect(line).not.toContain("dismiss");
        expect(line).not.toContain("recommend");
    });
});
