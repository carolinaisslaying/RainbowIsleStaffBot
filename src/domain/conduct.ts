import type { ObjectId } from "mongodb";
import type { ConductTier } from "../db/types.js";
import type { Tier } from "./permissions.js";

/**
 * Who may be warned for conduct, and by whom.
 *
 * Pure, and taking every fact as an argument, so a test can enumerate the cases
 * without a guild or a database. These rules run narrower than the ones for an
 * activity warning. The bot computes the figure behind an activity warning; an
 * Executive forms a judgement about a colleague behind this one.
 */

export type ConductRefusal = { ok: false; reason: string };
export type ConductPermitted = { ok: true };

export function conductWarningPermitted(options: {
    /** The tier of the person issuing, resolved against the public guild. */
    issuerTier: Tier;
    /** The tier of the person being warned. */
    subjectTier: Tier;
    issuerStaffId: ObjectId;
    subjectStaffId: ObjectId;
    /** Their staff record is inactive, or they are no longer in the guild. */
    subjectDeparted: boolean;
}): ConductPermitted | ConductRefusal {
    if (options.issuerTier !== "executive") {
        return {
            ok: false,
            reason:
                "Only an Executive can issue a warning. Leads can read the record and the " +
                "warning history."
        };
    }

    if (options.issuerStaffId.equals(options.subjectStaffId)) {
        return {
            ok: false,
            reason:
                "You cannot warn yourself. Ask another Executive to look at it."
        };
    }

    // Nobody can warn an Executive here. This bot takes one person's word and
    // writes it to a permanent record with no second signature, which is too
    // much power to hand one peer over another. That conversation happens
    // outside the bot.
    if (options.subjectTier === "executive") {
        return {
            ok: false,
            reason:
                "You cannot warn an Executive here. One person deciding this alone would put " +
                "it on a peer's permanent record with nobody signing off on it. Take it up " +
                "outside the bot."
        };
    }

    if (options.subjectTier === "none") {
        return {
            ok: false,
            reason:
                "They are not Moderation staff, so they have no record to warn against."
        };
    }

    if (options.subjectDeparted) {
        return {
            ok: false,
            reason:
                "They have left the team, so nobody can serve a warning on them. Their record " +
                "stays as it is."
        };
    }

    return { ok: true };
}

/**
 * Whether a string names a rung.
 *
 * The tier arrives from a modal, which means it arrives from the network. So we
 * check it instead of casting it.
 */
export function isConductTier(value: string | null): value is ConductTier {
    return value === "caution" || value === "misconduct" || value === "seriousMisconduct";
}
