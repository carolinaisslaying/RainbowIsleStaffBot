import { beforeEach, describe, expect, it } from "vitest";
import {
    STAGE_TTL_MS,
    clearStaged,
    noteRoleWrite,
    resetSotwStaging,
    roleWriteCooldown,
    stageColour,
    stageSet,
    stagedColour,
    takeSet
} from "../src/domain/sotwStaging.js";

beforeEach(() => resetSotwStaging());

describe("a staged colour", () => {
    it("is held for ten minutes for the person who staged it", () => {
        stageColour("u1", { style: "solid", primary: 1 }, 0);
        expect(stagedColour("u1", STAGE_TTL_MS - 1)).toEqual({ colour: { style: "solid", primary: 1 } });
        expect(stagedColour("u2", 1)).toBeNull();
        expect(stagedColour("u1", STAGE_TTL_MS)).toBeNull();
    });

    it("can stage no colour at all, which is different from nothing staged", () => {
        stageColour("u1", null, 0);
        expect(stagedColour("u1", 1)).toEqual({ colour: null });
        clearStaged("u1");
        expect(stagedColour("u1", 1)).toBeNull();
    });
});

describe("the role-write cooldown", () => {
    it("runs thirty seconds from the last write", () => {
        expect(roleWriteCooldown("u1", 0)).toBe(0);
        noteRoleWrite("u1", 1000);
        expect(roleWriteCooldown("u1", 21_000)).toBe(10_000);
        expect(roleWriteCooldown("u1", 31_000)).toBe(0);
    });
});

describe("a pending set", () => {
    it("is taken once", () => {
        stageSet("exec", "abc", "Great week", 0);
        expect(takeSet("exec", 1)).toEqual({ staffId: "abc", reason: "Great week" });
        expect(takeSet("exec", 2)).toBeNull();
    });

    it("expires", () => {
        stageSet("exec", "abc", null, 0);
        expect(takeSet("exec", STAGE_TTL_MS)).toBeNull();
    });
});
