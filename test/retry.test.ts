import { describe, expect, it } from "vitest";
import { retrying } from "../src/domain/retry.js";

const answers = (...list: string[]) => {
    let calls = 0;
    return { attempt: async () => list[calls++], calls: () => calls };
};
const slept: number[] = [];
const sleep = async (ms: number) => void slept.push(ms);

describe("asking again", () => {
    it("stops at the first answer it can trust", async () => {
        const { attempt, calls } = answers("yes");
        expect(await retrying(attempt, (r) => r === "yes", [1, 2], sleep)).toBe("yes");
        expect(calls()).toBe(1);
    });

    it("gets there after a failure", async () => {
        const { attempt, calls } = answers("unknown", "yes");
        expect(await retrying(attempt, (r) => r === "yes", [1, 2], sleep)).toBe("yes");
        expect(calls()).toBe(2);
    });

    it("hands back the last answer after running out of tries", async () => {
        const { attempt, calls } = answers("unknown", "unknown", "unknown");
        expect(await retrying(attempt, (r) => r === "yes", [1, 2], sleep)).toBe("unknown");
        expect(calls()).toBe(3);
    });
});
