import type { ObjectId } from "mongodb";
import type { ConductTier } from "../db/types.js";
import type { Tier } from "./permissions.js";

/**
 * Who may be warned for conduct, and by whom.
 *
 * Pure, and taking every fact as an argument, so the cases can be enumerated
 * without a guild or a database. The rules are narrower than for an activity
 * warning, and deliberately so: an activity warning is issued off a figure the
 * bot computed, and this one is issued off somebody's judgement about a
 * colleague.
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
                "Issuing a warning is Executive only. Leads can read the record and the " +
                "warning history, and that is the whole of it."
        };
    }

    if (options.issuerStaffId.equals(options.subjectStaffId)) {
        return {
            ok: false,
            reason:
                "You cannot warn yourself. A self-issued warning is either theatre or a way " +
                "to pre-empt somebody else's, and neither belongs on a record."
        };
    }

    // An Executive is not warnable through this bot at all. Conduct at that
    // level is not something one peer should be able to put on another's
    // permanent record unilaterally, and there is no second signature here to
    // make that safe. It is handled outside the bot, on purpose.
    if (options.subjectTier === "executive") {
        return {
            ok: false,
            reason:
                "Executives cannot be warned through this bot. That is deliberate: a warning " +
                "here is one person's decision, with no second signature, and it would go on " +
                "a peer's permanent record. Handle it outside the bot."
        };
    }

    if (options.subjectTier === "none") {
        return {
            ok: false,
            reason:
                "They are not Moderation staff, so there is no record to warn against and " +
                "nothing this bot can serve on them."
        };
    }

    if (options.subjectDeparted) {
        return {
            ok: false,
            reason:
                "They have left the team, so there is nobody to serve a warning on. Their " +
                "record is kept as it stands."
        };
    }

    return { ok: true };
}

/**
 * Whether a string names a rung.
 *
 * The tier arrives from a modal, which is to say from the network, so it is
 * checked rather than cast.
 */
export function isConductTier(value: string | null): value is ConductTier {
    return value === "caution" || value === "misconduct" || value === "seriousMisconduct";
}
