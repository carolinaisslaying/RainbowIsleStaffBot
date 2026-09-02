import { describe, expect, it } from "vitest";
import {
    appealPermitted,
    appealWindowCloses,
    deliveryState,
    queueCounts,
    queueHeadline
} from "../src/domain/review.js";

const DAY = 86_400_000;
const now = new Date("2026-09-02T12:00:00Z");

describe("what the row says about delivery", () => {
    it("reports an acknowledgement above everything else", () => {
        expect(
            deliveryState({
                acknowledgedAt: now,
                deliveredAt: now,
                deliveryFailedAt: null
            })
        ).toBe("acknowledged");
    });

    it("separates a bounced DM from an unacknowledged one", () => {
        expect(
            deliveryState({ acknowledgedAt: null, deliveredAt: now, deliveryFailedAt: null })
        ).toBe("delivered");
        expect(
            deliveryState({ acknowledgedAt: null, deliveredAt: null, deliveryFailedAt: now })
        ).toBe("failed");
    });

    it("calls a warning written before delivery was recorded unknown, not delivered", () => {
        // The whole point: never assert a delivery the bot did not observe.
        expect(deliveryState({ acknowledgedAt: null })).toBe("unknown");
    });

    it("still reports an acknowledgement on a pre-existing warning", () => {
        // Somebody acknowledged it, so it plainly arrived, whatever we recorded.
        expect(deliveryState({ acknowledgedAt: now })).toBe("acknowledged");
    });
});

describe("the appeal window", () => {
    const base = {
        appealFiled: false,
        windowDays: 14,
        now
    };

    it("is open the moment the warning is delivered", () => {
        expect(appealPermitted({ ...base, deliveredAt: now })).toEqual({ ok: true });
    });

    it("is open on the last day", () => {
        const delivered = new Date(now.getTime() - 14 * DAY + 1000);
        expect(appealPermitted({ ...base, deliveredAt: delivered })).toEqual({ ok: true });
    });

    it("closes once the window has passed", () => {
        const delivered = new Date(now.getTime() - 14 * DAY - 1000);
        expect(appealPermitted({ ...base, deliveredAt: delivered })).toEqual({
            ok: false,
            reason: "window-closed"
        });
    });

    it("never opens for a warning that was never delivered", () => {
        // Counted from delivery on purpose. A member whose DMs are closed never
        // saw the warning, and a window counted from issue could expire before
        // they had any chance to contest it.
        expect(appealPermitted({ ...base, deliveredAt: null })).toEqual({
            ok: false,
            reason: "never-delivered"
        });
        expect(appealPermitted({ ...base, deliveredAt: undefined })).toEqual({
            ok: false,
            reason: "never-delivered"
        });
    });

    it("allows exactly one appeal", () => {
        expect(
            appealPermitted({ ...base, deliveredAt: now, appealFiled: true })
        ).toEqual({ ok: false, reason: "already-filed" });
    });

    it("reports the existing appeal ahead of a closed window", () => {
        // Both are true for a stale appeal; "you already did" is the more useful
        // of the two, and does not read as a door that shut on them.
        const delivered = new Date(now.getTime() - 100 * DAY);
        expect(
            appealPermitted({ ...base, deliveredAt: delivered, appealFiled: true })
        ).toEqual({ ok: false, reason: "already-filed" });
    });

    it("honours a configured window other than the default", () => {
        const delivered = new Date(now.getTime() - 20 * DAY);
        expect(appealPermitted({ ...base, deliveredAt: delivered, windowDays: 30 })).toEqual({
            ok: true
        });
        expect(appealPermitted({ ...base, deliveredAt: delivered, windowDays: 7 })).toEqual({
            ok: false,
            reason: "window-closed"
        });
    });

    it("names when the window shuts, and says so when it never opened", () => {
        expect(appealWindowCloses(now, 14)?.getTime()).toBe(now.getTime() + 14 * DAY);
        expect(appealWindowCloses(null, 14)).toBeNull();
        expect(appealWindowCloses(undefined, 14)).toBeNull();
    });
});

describe("the header with an appeal open", () => {
    it("counts appeals apart from decisions", () => {
        const counts = queueCounts([
            { outcome: "warned", underAppeal: true },
            { outcome: "warned", underAppeal: false },
            { outcome: null }
        ]);
        expect(counts).toEqual({ below: 3, decided: 2, remaining: 1, underAppeal: 1 });
    });

    it("says so on a queue where every row is decided", () => {
        // The case the count exists for: an "All reviewed" header that still has
        // somebody waiting on an answer.
        const headline = queueHeadline(
            queueCounts([
                { outcome: "warned", underAppeal: true },
                { outcome: "excused", underAppeal: false }
            ]),
            240
        );
        expect(headline).toContain("All reviewed");
        expect(headline).toContain("1 under appeal");
    });

    it("stays quiet when nobody has appealed", () => {
        const headline = queueHeadline(
            queueCounts([{ outcome: "warned" }, { outcome: "excused" }]),
            240
        );
        expect(headline).not.toContain("appeal");
    });

    it("mentions appeals on a queue still being worked", () => {
        const headline = queueHeadline(
            queueCounts([
                { outcome: "warned", underAppeal: true },
                { outcome: null },
                { outcome: null }
            ]),
            240
        );
        expect(headline).toContain("2 still to decide");
        expect(headline).toContain("1 under appeal");
    });
});
