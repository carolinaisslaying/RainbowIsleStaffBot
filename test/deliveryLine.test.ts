import { describe, expect, it } from "vitest";
import { deliveryLine } from "../src/domain/review.js";

/**
 * The card used to say "They have been messaged" whenever the bot was permitted
 * to send one, because a single flag was set before the send and `tryDm`'s
 * answer was thrown away. These separate the two facts.
 */
describe("deliveryLine", () => {
    it("says a delivered message arrived", () => {
        expect(
            deliveryLine({ action: "warn", attempted: true, messaged: true, rehearsal: false })
        ).toBe("They have been messaged.");
    });

    it("does not claim delivery when the DM bounced", () => {
        const line = deliveryLine({
            action: "warn",
            attempted: true,
            messaged: false,
            rehearsal: false
        });
        expect(line).not.toContain("have been messaged");
        expect(line).toContain("could not be messaged");
        expect(line).toContain("direct messages are closed");
    });

    it("says the decision stands even when it could not be delivered", () => {
        // An Executive reading this must not think the record is in doubt.
        expect(
            deliveryLine({ action: "warn", attempted: true, messaged: false, rehearsal: false })
        ).toContain("stands on the record");
    });

    it("never claims a dismissal was raised with anybody", () => {
        for (const messaged of [true, false]) {
            expect(
                deliveryLine({ action: "dismiss", attempted: false, messaged, rehearsal: false })
            ).toBe("They were not told; a dismissal is not raised with them.");
        }
    });

    it("distinguishes a rehearsal skip from a failed send", () => {
        const skipped = deliveryLine({
            action: "warn",
            attempted: false,
            messaged: false,
            rehearsal: true
        });
        const bounced = deliveryLine({
            action: "warn",
            attempted: true,
            messaged: false,
            rehearsal: true
        });
        expect(skipped).toContain("not an Executive");
        expect(bounced).toContain("direct messages are closed");
        expect(skipped).not.toBe(bounced);
    });

    it("treats an excusal the same way as a warning", () => {
        expect(
            deliveryLine({ action: "excuse", attempted: true, messaged: true, rehearsal: false })
        ).toBe("They have been messaged.");
        expect(
            deliveryLine({ action: "excuse", attempted: true, messaged: false, rehearsal: false })
        ).toContain("could not be messaged");
    });
});
