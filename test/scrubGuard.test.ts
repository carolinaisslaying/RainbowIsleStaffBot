import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { partitionByRealness, permittedScrub } from "../src/domain/scrub.js";
import type { FortnightAssessmentDoc, WarningDoc } from "../src/db/types.js";

/**
 * The switch that keeps a dry-run cleanup from reaching real history.
 *
 * Clearing up after a rehearsal has to stay a one-click job or nobody will
 * rehearse. Deleting somebody's actual assessment record should take a
 * deliberate act outside Discord, because a mistyped fortnight number is one
 * keystroke and editing a deployment file is not.
 */

const assessment = (rehearsal: boolean): FortnightAssessmentDoc =>
    ({
        _id: new ObjectId(),
        staffId: new ObjectId(),
        fortnightIndex: 3,
        windowStart: new Date(),
        windowEnd: new Date(),
        week1Minutes: 0,
        week2Minutes: 0,
        totalMinutes: 0,
        requiredMinutes: 240,
        status: "below",
        reviewedBy: null,
        reviewOutcome: null,
        reviewedAt: null,
        reviewNote: null,
        rehearsal
    }) as FortnightAssessmentDoc;

const warningFor = (parent: FortnightAssessmentDoc): WarningDoc =>
    ({
        _id: new ObjectId(),
        staffId: parent.staffId,
        assessmentId: parent._id,
        issuedBy: new ObjectId(),
        issuedAt: new Date(),
        note: "x",
        acknowledgedAt: null
    }) as WarningDoc;

describe("telling a rehearsal's records from real ones", () => {
    it("splits assessments on the flag", () => {
        const fake = assessment(true);
        const real = assessment(false);
        const split = partitionByRealness({ assessments: [fake, real], warnings: [] });
        expect(split.rehearsal.assessments).toEqual([fake]);
        expect(split.real.assessments).toEqual([real]);
    });

    it("sends a warning wherever its assessment went", () => {
        // A warning carries no flag of its own on older records. Its parent
        // does, and the parent is what decides whether it ever meant anything.
        const fake = assessment(true);
        const real = assessment(false);
        const split = partitionByRealness({
            assessments: [fake, real],
            warnings: [warningFor(fake), warningFor(real)]
        });
        expect(split.rehearsal.warnings).toHaveLength(1);
        expect(split.real.warnings).toHaveLength(1);
    });

    it("treats a record written before the flag existed as real", () => {
        // The flag is absent on everything written before rehearsals were
        // flagged, and the safe reading of an absent flag is "this was real".
        const legacy = { ...assessment(false) };
        delete (legacy as { rehearsal?: boolean }).rehearsal;
        const split = partitionByRealness({ assessments: [legacy], warnings: [] });
        expect(split.real.assessments).toHaveLength(1);
        expect(split.rehearsal.assessments).toHaveLength(0);
    });
});

describe("what a purge is permitted to touch", () => {
    const fake = assessment(true);
    const real = assessment(false);
    const target = {
        assessments: [fake, real],
        warnings: [warningFor(fake), warningFor(real)]
    };

    it("keeps real records out of reach while the switch is off", () => {
        const { allowed, refused } = permittedScrub(target, false);
        expect(allowed.assessments).toEqual([fake]);
        expect(refused.assessments).toEqual([real]);
        expect(allowed.warnings).toHaveLength(1);
        expect(refused.warnings).toHaveLength(1);
    });

    it("still clears a rehearsal without the switch", () => {
        // Otherwise cleaning up after a dry run needs a deployment change, and
        // nobody will dry run.
        const onlyFake = { assessments: [fake], warnings: [warningFor(fake)] };
        expect(permittedScrub(onlyFake, false).allowed.assessments).toHaveLength(1);
        expect(permittedScrub(onlyFake, false).refused.assessments).toHaveLength(0);
    });

    it("refuses everything when nothing in the target is a rehearsal", () => {
        const onlyReal = { assessments: [real], warnings: [] };
        expect(permittedScrub(onlyReal, false).allowed.assessments).toHaveLength(0);
        expect(permittedScrub(onlyReal, false).refused.assessments).toHaveLength(1);
    });

    it("passes everything through once the switch is on", () => {
        const { allowed, refused } = permittedScrub(target, true);
        expect(allowed).toBe(target);
        expect(refused.assessments).toHaveLength(0);
    });
});
