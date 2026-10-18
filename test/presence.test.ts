import { describe, expect, it } from "vitest";
import {
    isOffline,
    mayStartShift,
    messageEffect,
    sweepShouldPause
} from "../src/domain/presence.js";

describe("nobody is on shift while offline", () => {
    it("reads invisible as offline", () => {
        expect(isOffline("offline")).toBe(true);
        expect(isOffline("invisible")).toBe(true);
        expect(isOffline("online")).toBe(false);
        expect(isOffline("idle")).toBe(false);
        expect(isOffline("dnd")).toBe(false);
        expect(isOffline(null)).toBe(false);
    });

    it("refuses a start while offline, and while the status cannot be read", () => {
        expect(mayStartShift("offline")).toBe(false);
        expect(mayStartShift("invisible")).toBe(false);
        expect(mayStartShift(null)).toBe(false);
        expect(mayStartShift("online")).toBe(true);
        expect(mayStartShift("idle")).toBe(true);
        expect(mayStartShift("dnd")).toBe(true);
    });

    it("ends the shift for a message sent while offline, paused or not", () => {
        expect(messageEffect("offline", true)).toBe("end");
        expect(messageEffect("offline", false)).toBe("end");
        expect(messageEffect("invisible", false)).toBe("end");
    });

    it("does not end anything when the status cannot be read", () => {
        expect(messageEffect(null, false)).toBe("credit");
        expect(messageEffect(null, true)).toBe("resume");
    });

    it("lets a visible message resume and credit as before", () => {
        expect(messageEffect("online", true)).toBe("resume");
        expect(messageEffect("idle", false)).toBe("credit");
        expect(messageEffect("dnd", true)).toBe("resume");
    });

    it("has the sweep pause an available offline shift, and nothing it cannot see", () => {
        expect(sweepShouldPause("offline", false)).toBe(true);
        expect(sweepShouldPause("offline", true)).toBe(false);
        expect(sweepShouldPause("online", false)).toBe(false);
        // A guild outage leaves every shift alone.
        expect(sweepShouldPause(null, false)).toBe(false);
    });
});
