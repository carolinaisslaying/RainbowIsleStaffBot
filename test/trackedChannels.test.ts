import { describe, expect, it } from "vitest";
import { isTracked, trackedChannelIds } from "../src/domain/trackedChannels.js";

describe("isTracked", () => {
    it("counts a channel on the list", () => {
        expect(isTracked(["general"], { channelId: "general", categoryId: null })).toBe(true);
    });

    it("counts a channel whose category is on the list", () => {
        expect(isTracked(["community"], { channelId: "art", categoryId: "community" })).toBe(true);
    });

    it("refuses a channel in an untracked category", () => {
        expect(isTracked(["community"], { channelId: "staff", categoryId: "staffroom" })).toBe(false);
    });

    it("refuses a channel with no category when only categories are tracked", () => {
        expect(isTracked(["community"], { channelId: "rules", categoryId: null })).toBe(false);
    });

    it("tracks nothing with an empty list", () => {
        expect(isTracked([], { channelId: "general", categoryId: "community" })).toBe(false);
    });
});

describe("trackedChannelIds", () => {
    const channels = [
        { id: "community", parentId: null },
        { id: "art", parentId: "community" },
        { id: "memes", parentId: "community" },
        { id: "staff", parentId: "staffroom" },
        { id: "general", parentId: null }
    ];

    it("opens a tracked category into the channels inside it", () => {
        expect(trackedChannelIds(["community"], channels).sort()).toEqual(
            ["art", "community", "memes"].sort()
        );
    });

    it("keeps directly tracked channels, including one that no longer exists", () => {
        expect(trackedChannelIds(["general", "deleted"], channels).sort()).toEqual(
            ["deleted", "general"].sort()
        );
    });

    it("lists a channel once when it is tracked both ways", () => {
        expect(trackedChannelIds(["community", "art"], channels).sort()).toEqual(
            ["art", "community", "memes"].sort()
        );
    });
});
