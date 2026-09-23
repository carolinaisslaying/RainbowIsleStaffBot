import { describe, expect, it } from "vitest";
import { rehearsalUpdate } from "../src/domain/assessments.js";

/**
 * The asymmetry that stops a rehearsal branding a fortnight for ever.
 *
 * `rehearsal` used to live in `$setOnInsert` alone, which handed realness to
 * whichever run created the document. `/dev rehearse` is always a rehearsal, so
 * reading a fortnight's card before it went out for real created every row of
 * it flagged — and the real run afterwards refreshed the figures, claimed the
 * announcement and DMed the roster over documents that still said they were not
 * real. Every warning it then issued counted against nobody, went to nobody but
 * Executives, and the whole fortnight was filtered out of the member's history.
 *
 * A real run promotes; a rehearsal never demotes.
 */
describe("what a run does to a row's rehearsal flag", () => {
    it("promotes a rehearsal's row when the real run arrives", () => {
        expect(rehearsalUpdate(false)).toEqual({ rehearsal: false });
    });

    it("leaves a real row alone when a rehearsal runs over it", () => {
        // The $set carries nothing, so $setOnInsert stays the only writer of
        // the flag and the existing document keeps whatever it already said.
        expect(rehearsalUpdate(true)).toEqual({});
    });

    it("never sets the flag true from an update", () => {
        // A rehearsal marks a row only by creating it. If this ever wrote
        // `rehearsal: true` into $set, rehearsing an announced fortnight would
        // silently void everybody's real warnings for it.
        for (const rehearsal of [true, false]) {
            expect(Object.values(rehearsalUpdate(rehearsal))).not.toContain(true);
        }
    });
});
