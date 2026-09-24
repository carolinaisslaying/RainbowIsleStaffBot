import { describe, expect, it } from "vitest";
import { requirementsFor } from "../src/commands/requirements.js";
import type { SubcommandRule } from "../src/commands/types.js";
import type { Tier } from "../src/domain/permissions.js";

function command(tier: Tier, subcommands?: Record<string, SubcommandRule>) {
    return { tier, subcommands, data: { name: "warnings" } };
}

/**
 * One command per subject means permission varies inside a command. Discord's
 * picker filters on the command's tier alone, so a subcommand may raise the
 * bar and must never lower it.
 */
describe("per-subcommand requirements", () => {
    it("lets a subcommand raise the tier", () => {
        const required = requirementsFor(command("staff", { issue: { tier: "executive" } }), "issue");
        expect(required.tier).toBe("executive");
        expect(required.path).toBe("warnings issue");
    });

    it("inherits the command's tier where a subcommand has no rule", () => {
        expect(requirementsFor(command("staff", { issue: { tier: "executive" } }), "view").tier).toBe(
            "staff"
        );
    });

    it("never lets a subcommand lower the command's tier", () => {
        expect(requirementsFor(command("executive", { open: { tier: "staff" } }), "open").tier).toBe(
            "executive"
        );
    });

    it("bypasses onboarding for the named subcommand only", () => {
        const settings = command("staff", { timezone: { bypassOnboarding: true } });
        expect(requirementsFor(settings, "timezone").bypassOnboarding).toBe(true);
        expect(requirementsFor(settings, "face").bypassOnboarding).toBe(false);
    });

    it("names the bare command when there is no subcommand", () => {
        expect(requirementsFor(command("staff"), null)).toEqual({
            path: "warnings",
            tier: "staff",
            bypassOnboarding: false
        });
    });
});

describe("the registered layout", () => {
    it("gates issuing a warning to Executives and lets anyone set a timezone first", async () => {
        const { commandsByName } = await import("../src/commands/index.js");
        const warnings = commandsByName.get("warnings")!;
        expect(requirementsFor(warnings, "issue").tier).toBe("executive");
        expect(requirementsFor(warnings, "view").tier).toBe("staff");
        const shift = commandsByName.get("shift")!;
        expect(requirementsFor(shift, "terminate").tier).toBe("executive");
        expect(requirementsFor(shift, "end").tier).toBe("staff");
        expect(requirementsFor(commandsByName.get("settings")!, "timezone").bypassOnboarding).toBe(
            true
        );
    });

    it("registers exactly one command per subject", async () => {
        const { commands } = await import("../src/commands/index.js");
        expect(commands.map((entry) => entry.data.name).sort()).toEqual(
            ["admin", "config", "coverage", "dev", "leave", "settings", "shift", "stats", "warnings"]
        );
    });

    it("builds every command within Discord's limits", async () => {
        const { commands } = await import("../src/commands/index.js");
        type Node = { name: string; description?: string; options?: Node[] };
        const walk = (node: Node): void => {
            expect(node.description?.length ?? 0, node.name).toBeLessThanOrEqual(100);
            node.options?.forEach(walk);
        };
        for (const entry of commands) walk(entry.data.toJSON() as Node);
    });

    // A rule keyed by a misspelt subcommand does nothing, and for /warnings
    // issue "nothing" means every Moderator can open the warning modal.
    it("keys every subcommand rule by a subcommand that exists", async () => {
        const { commands } = await import("../src/commands/index.js");
        for (const entry of commands) {
            const json = entry.data.toJSON() as { options?: { name: string }[] };
            const names = new Set((json.options ?? []).map((option) => option.name));
            for (const key of Object.keys(entry.subcommands ?? {})) {
                expect(names.has(key), `${entry.data.name} ${key}`).toBe(true);
            }
        }
    });
});
