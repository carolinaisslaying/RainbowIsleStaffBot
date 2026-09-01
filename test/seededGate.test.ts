import { describe, expect, it } from "vitest";
import { seededGatePermits } from "../src/domain/permissions.js";

/**
 * The gate above the tier check.
 *
 * `resolveTier` promotes a seeded admin to Executive, so the tier lattice
 * cannot express "Executive is not enough" and this does. The case worth
 * holding is the fallback: a deployment naming no administrators must not lock
 * everybody out of its own configuration.
 */
describe("the seeded-admin gate", () => {
    it("lets anything ungated through untouched", () => {
        for (const anyAdminsConfigured of [true, false]) {
            for (const callerIsAdmin of [true, false]) {
                expect(
                    seededGatePermits({
                        seededOnly: false,
                        anyAdminsConfigured,
                        callerIsAdmin
                    })
                ).toBe(true);
            }
        }
    });

    it("admits a seeded admin", () => {
        expect(
            seededGatePermits({
                seededOnly: true,
                anyAdminsConfigured: true,
                callerIsAdmin: true
            })
        ).toBe(true);
    });

    it("refuses an Executive who is not one", () => {
        // The whole point: Executive rank reaches everything else and stops
        // here, because configuration decides who counts as an Executive.
        expect(
            seededGatePermits({
                seededOnly: true,
                anyAdminsConfigured: true,
                callerIsAdmin: false
            })
        ).toBe(false);
    });

    it("falls back to the tier when the deployment names nobody", () => {
        // Otherwise the bot is unconfigurable by anyone, including whoever is
        // trying to name the first administrator, and /config is the only way
        // to fix whatever caused that.
        expect(
            seededGatePermits({
                seededOnly: true,
                anyAdminsConfigured: false,
                callerIsAdmin: false
            })
        ).toBe(true);
    });
});
