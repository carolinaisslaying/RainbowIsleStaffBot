/**
 * A bot is never a member of staff, whatever roles it holds. A staff record
 * belonging to one is removed at boot, with everything stored against it.
 *
 * Pure, so the one rule that matters here is tested without Discord: a record
 * is removed only when Discord has said the account is a bot. An account that
 * could not be looked up is kept, because an outage or a deleted account is not
 * evidence of anything, and this is a delete.
 */

export type AccountLookup = { kind: "bot" } | { kind: "person" } | { kind: "unknown" };

export function botRecordAction(lookup: AccountLookup): "remove" | "keep" {
    return lookup.kind === "bot" ? "remove" : "keep";
}
