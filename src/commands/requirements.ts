import type { Command } from "./types.js";
import { atLeast, type Tier } from "../domain/permissions.js";

export interface Requirements {
    /** The path to name in a refusal: `warnings issue`, or `config` alone. */
    path: string;
    tier: Tier;
    bypassOnboarding: boolean;
}

/**
 * What it takes to run one subcommand: the command's tier and the
 * subcommand's, whichever is stricter. A rule can raise the bar and never
 * lower it, because the command's tier is also what hides it from Discord's
 * picker, and a subcommand reachable below that would be one nobody can see.
 */
export function requirementsFor(
    command: Pick<Command, "tier" | "subcommands"> & { data: { name: string } },
    subcommand: string | null
): Requirements {
    const rule = subcommand ? command.subcommands?.[subcommand] : undefined;
    const tier = rule?.tier && atLeast(rule.tier, command.tier) ? rule.tier : command.tier;
    return {
        path: subcommand ? `${command.data.name} ${subcommand}` : command.data.name,
        tier,
        bypassOnboarding: rule?.bypassOnboarding === true
    };
}
