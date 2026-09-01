import { describe, expect, it } from "vitest";
import {
    adoptLegacyReviewChannel,
    CONFIG_KEYS,
    DEFAULT_CONFIG,
    isArrayKey,
    isUnset,
    keysInGroup,
    type StaffBotConfig
} from "../src/config/guildConfig.js";
import { renderValue, setupStatus } from "../src/render/configCards.js";

const NAMES = new Map([["11", "Rainbow Isle"]]);

function config(overrides: Partial<StaffBotConfig> = {}): StaffBotConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}

describe("key metadata", () => {
    it("assigns every key to a group", () => {
        const grouped = (["servers", "roles", "channels", "targets", "timings", "calendar"] as const)
            .flatMap((group) => keysInGroup(group));
        expect(grouped.sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
    });

    it("gives every required key a stated consequence", () => {
        for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
            if (spec.importance === "required") {
                expect(spec.consequence, `${key} needs a consequence`).toBeTruthy();
            }
        }
    });

    it("knows which keys hold lists", () => {
        expect(isArrayKey("trackedChannels")).toBe(true);
        expect(isArrayKey("executiveRoles")).toBe(true);
        expect(isArrayKey("leaveChannelId")).toBe(false);
    });
});

describe("unset detection", () => {
    it("treats an empty string and an empty list as unset", () => {
        expect(isUnset(config(), "availabilityRole")).toBe(true);
        expect(isUnset(config(), "executiveRoles")).toBe(true);
    });

    it("does not treat a zero or a false as unset", () => {
        expect(isUnset(config({ weekStartDay: 0 }), "weekStartDay")).toBe(false);
        expect(isUnset(config({ softRingsEnabled: false }), "softRingsEnabled")).toBe(false);
    });
});

describe("value rendering", () => {
    it("renders roles and channels as mentions Discord will resolve to names", () => {
        expect(renderValue("availabilityRole", config({ availabilityRole: "42" }), NAMES)).toBe(
            "<@&42>"
        );
        expect(renderValue("leaveChannelId", config({ leaveChannelId: "42" }), NAMES)).toBe(
            "<#42>"
        );
    });

    it("renders a list of roles as separate mentions", () => {
        expect(renderValue("leadRoles", config({ leadRoles: ["1", "2"] }), NAMES)).toBe(
            "<@&1> <@&2>"
        );
    });

    it("names a guild rather than printing a bare snowflake", () => {
        expect(renderValue("publicGuildId", config({ publicGuildId: "11" }), NAMES)).toBe(
            "Rainbow Isle"
        );
    });

    it("spells out the weekday instead of showing an index", () => {
        expect(renderValue("weekStartDay", config({ weekStartDay: 1 }), NAMES)).toBe("**Monday**");
        expect(renderValue("weekStartDay", config({ weekStartDay: 0 }), NAMES)).toBe("**Sunday**");
    });

    it("renders the anchor as a timestamp the reader's client localises", () => {
        expect(renderValue("fortnightAnchor", config(), NAMES)).toMatch(/^<t:\d+:D>$/);
    });

    it("shows booleans as on and off", () => {
        expect(renderValue("softRingsEnabled", config({ softRingsEnabled: true }), NAMES)).toBe(
            "**on**"
        );
        expect(renderValue("softRingsEnabled", config({ softRingsEnabled: false }), NAMES)).toBe(
            "**off**"
        );
    });

    it("marks a missing required key more loudly than a missing optional one", () => {
        expect(renderValue("trackedChannels", config(), NAMES)).toBe("**not set**");
        expect(renderValue("recapChannelId", config(), NAMES)).toBe("*not set*");
    });
});

describe("setup status", () => {
    it("reports nothing ready on a bare install", () => {
        const status = setupStatus({ ...DEFAULT_CONFIG, publicGuildId: "", staffGuildId: "" });
        expect(status.ready).toBe(false);
        expect(status.requiredSet).toBe(0);
        expect(status.missingRequired).toContain("trackedChannels");
    });

    it("counts the two guild IDs that the environment bootstraps", () => {
        const status = setupStatus(config({ publicGuildId: "1", staffGuildId: "2" }));
        expect(status.requiredSet).toBe(2);
        expect(status.ready).toBe(false);
    });

    it("is ready once every required key holds something", () => {
        const status = setupStatus(
            config({
                publicGuildId: "1",
                staffGuildId: "2",
                moderationDepartmentRole: "3",
                executiveRoles: ["4"],
                availabilityRole: "5",
                trackedChannels: ["6"],
                leaveChannelId: "7",
                reportChannelId: "8"
            })
        );
        expect(status.ready).toBe(true);
        expect(status.missingRequired).toEqual([]);
        expect(status.requiredSet).toBe(status.requiredTotal);
    });

    it("still lists recommended gaps once the essentials are done", () => {
        const status = setupStatus(
            config({
                publicGuildId: "1",
                staffGuildId: "2",
                moderationDepartmentRole: "3",
                executiveRoles: ["4"],
                availabilityRole: "5",
                trackedChannels: ["6"],
                leaveChannelId: "7",
                reportChannelId: "8"
            })
        );
        expect(status.missingRecommended).toContain("leadRoles");
        expect(status.missingRecommended).toContain("onLeaveRole");
    });
});

describe("leaderboard rows stay a valid ordered list", () => {
    it("emits exactly one line per row, so Discord keeps numbering", async () => {
        const { leaderboardCard } = await import("../src/render/cards.js");
        const rows = [1, 2, 3, 4].map((rank) => ({
            rank,
            label: `Member ${rank}`,
            activityMinutes: 100 - rank,
            target: 120,
            state: "amber" as const,
            isViewer: false,
            onLeave: false
        }));
        const card = leaderboardCard({
            title: "t",
            windowLabel: "w",
            rows,
            viewerRow: null,
            page: 1,
            pageCount: 1,
            scope: "week",
            totalMinutes: 394,
            participants: 4
        });

        const json = JSON.stringify(card.components[0].toJSON());
        const body = [...json.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
            .map((match) => JSON.parse(`"${match[1]}"`))
            .find((block: string) => block.includes("Member 1")) as string;

        const lines = body.split("\n").filter(Boolean);
        expect(lines).toHaveLength(4);
        // A line that does not open with "N. " would end the list early.
        for (const [index, line] of lines.entries()) {
            expect(line.startsWith(`${index + 1}. `)).toBe(true);
        }
    });

    it("keeps the viewer's true rank when pinning them below the page", async () => {
        const { leaderboardCard } = await import("../src/render/cards.js");
        const card = leaderboardCard({
            title: "t",
            windowLabel: "w",
            rows: [],
            viewerRow: {
                rank: 17,
                label: "Me",
                activityMinutes: 40,
                target: 120,
                state: "red",
                isViewer: true,
                onLeave: false
            },
            page: 2,
            pageCount: 3,
            scope: "week",
            totalMinutes: 0,
            participants: 20
        });
        const json = JSON.stringify(card.components[0].toJSON());
        expect(json).toContain("17. ");
    });
});

describe("shipped defaults", () => {
    // These are policy, agreed with the Executives, and the bot ships with them
    // in force. A change here is a change to what every unconfigured deployment
    // does, so it should be a deliberate edit and not a drift.
    it("matches the agreed Targets, Timings and Calendar table", () => {
        expect(DEFAULT_CONFIG.weeklyTargetMinutes).toBe(120);
        expect(DEFAULT_CONFIG.fortnightRequiredMinutes).toBe(240);
        expect(DEFAULT_CONFIG.weeklyShiftTargetHours).toBe(4);
        expect(DEFAULT_CONFIG.weeklyActiveDaysTarget).toBe(3);
        expect(DEFAULT_CONFIG.amberThresholdPercent).toBe(75);
        expect(DEFAULT_CONFIG.softRingsEnabled).toBe(true);

        expect(DEFAULT_CONFIG.awayAfterMinutes).toBe(20);
        expect(DEFAULT_CONFIG.autoEndAfterAwayMinutes).toBe(30);
        expect(DEFAULT_CONFIG.maxShiftHours).toBe(12);
        expect(DEFAULT_CONFIG.heatmapLookbackWeeks).toBe(8);

        expect(DEFAULT_CONFIG.accountingTimezone).toBe("UTC");
        expect(DEFAULT_CONFIG.weekStartDay).toBe(1); // Monday
        expect(new Date(DEFAULT_CONFIG.fortnightAnchor).toISOString()).toBe(
            "2026-09-28T00:00:00.000Z"
        );
    });

    it("every default is inside the bounds its own key declares", () => {
        for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
            if (spec.kind !== "number") continue;
            const value = DEFAULT_CONFIG[key as keyof StaffBotConfig] as number;
            if (spec.min !== undefined) expect(value, `${key} below its minimum`).toBeGreaterThanOrEqual(spec.min);
            if (spec.max !== undefined) expect(value, `${key} above its maximum`).toBeLessThanOrEqual(spec.max);
        }
    });
});

describe("the configuration viewer", () => {
    /**
     * Locate a container by what it says rather than by where it sits.
     *
     * The card grew a warnings block between the status and the settings, and
     * every test here indexed the containers positionally, so a card that got
     * one container longer failed three assertions about content that had not
     * moved. Position is not what any of these tests are about.
     */
    const containerSaying = (
        card: { components: { toJSON(): unknown }[] },
        needle: string
    ): { components: { type: number }[] } => {
        const found = card.components
            .map((component) => component.toJSON() as { components: { type: number }[] })
            .find((json) => JSON.stringify(json).includes(needle));
        if (!found) throw new Error(`No container mentions ${needle}`);
        return found;
    };

    it("puts a divider between every heading instead of blank lines", async () => {
        const { configViewCard } = await import("../src/render/configCards.js");
        const card = configViewCard(DEFAULT_CONFIG, NAMES, "/config set");

        // Servers, Roles, Channels in one container; Targets, Timings, Calendar
        // in the next. Three headings each means two dividers between them.
        for (const heading of ["### Servers", "### Targets"]) {
            const json = containerSaying(card, heading);
            const headings = json.components.filter((child) => child.type === 10);
            expect(headings).toHaveLength(3);

            // Count only the dividers that sit between two headings, so the one
            // introducing the transfer buttons at the foot of the second
            // container is not mistaken for a heading separator.
            const betweenHeadings = json.components.filter(
                (child, position) =>
                    child.type === 14 &&
                    json.components.slice(position + 1).some((later) => later.type === 10)
            );
            expect(betweenHeadings).toHaveLength(2);
        }
    });

    it("offers export and import at the foot of the card, after the settings", async () => {
        const { configViewCard } = await import("../src/render/configCards.js");
        const card = configViewCard(DEFAULT_CONFIG, NAMES, "/config set");
        const policy = containerSaying(card, "### Targets");
        const json = JSON.stringify(policy);

        expect(json).toContain("config:export:now");
        expect(json).toContain("config:import:open");
        // Below the settings, not above them: somebody reading down the card
        // has seen what is configured before reaching a control that replaces
        // all of it.
        const lastHeading = policy.components.map((child) => child.type).lastIndexOf(10);
        const actionRow = policy.components.map((child) => child.type).indexOf(1);
        expect(actionRow).toBeGreaterThan(lastHeading);
    });

    it("never separates two headings with a bare blank line", async () => {
        const { configViewCard } = await import("../src/render/configCards.js");
        const json = JSON.stringify(configViewCard(DEFAULT_CONFIG, NAMES, "/config set"));
        expect(json).not.toContain("\\n\\n### ");
    });
});

describe("splitting the old review channel in two", () => {
    // reviewChannelId carried leave requests and fortnight report cards
    // together. Deployments configured before the split must not go quiet.
    it("seeds both new keys from the old one", () => {
        const merged = adoptLegacyReviewChannel(config(), "42");
        expect(merged.leaveChannelId).toBe("42");
        expect(merged.reportChannelId).toBe("42");
    });

    it("never overwrites a channel someone has already chosen", () => {
        const merged = adoptLegacyReviewChannel(
            config({ leaveChannelId: "11", reportChannelId: "22" }),
            "42"
        );
        expect(merged.leaveChannelId).toBe("11");
        expect(merged.reportChannelId).toBe("22");
    });

    it("fills only the half that is still empty", () => {
        const merged = adoptLegacyReviewChannel(config({ leaveChannelId: "11" }), "42");
        expect(merged.leaveChannelId).toBe("11");
        expect(merged.reportChannelId).toBe("42");
    });

    it("does nothing for an install that never had the old key", () => {
        for (const legacy of [undefined, null, "", 0]) {
            const merged = adoptLegacyReviewChannel(config(), legacy);
            expect(merged.leaveChannelId).toBe("");
            expect(merged.reportChannelId).toBe("");
        }
    });

    it("counts both halves as required, so neither is forgotten in setup", () => {
        expect(CONFIG_KEYS.leaveChannelId.importance).toBe("required");
        expect(CONFIG_KEYS.reportChannelId.importance).toBe("required");
        const status = setupStatus(config({ leaveChannelId: "1" }));
        expect(status.missingRequired).toContain("reportChannelId");
        expect(status.missingRequired).not.toContain("leaveChannelId");
    });
});
