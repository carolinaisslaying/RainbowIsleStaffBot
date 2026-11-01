import { describe, expect, it } from "vitest";
import { JOB_ALERT_INTERVAL_MS, jobAlertDue } from "../src/domain/adminAlerts.js";

describe("alerting about a failing job", () => {
    it("says so the first time", () => {
        expect(jobAlertDue(undefined, 1000)).toBe(true);
    });

    it("stays quiet while the same job keeps failing", () => {
        expect(jobAlertDue(1000, 1000 + JOB_ALERT_INTERVAL_MS - 1)).toBe(false);
    });

    it("says so again once the interval has passed", () => {
        expect(jobAlertDue(1000, 1000 + JOB_ALERT_INTERVAL_MS)).toBe(true);
    });
});
