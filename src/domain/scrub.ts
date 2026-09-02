import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type { FortnightAssessmentDoc, WarningDoc } from "../db/types.js";

/**
 * Removing assessment records that should never have existed.
 *
 * Two kinds accumulated before the guards were in place. Fortnights before the
 * anchor were assessed by a boot against an empty database, so members carry
 * shortfalls for windows that closed before the deployment did anything. And
 * decisions taken on a rehearsal card were written as real records, because the
 * rehearsal flag reached the header and not the rows; those predate
 * `rehearsal: true` and so no query filters them.
 *
 * This is the second delete in the codebase after `purgeLeaveRecord`, and it
 * follows the same rule: the audit row is written first and the delete is
 * abandoned if that write fails, so nothing disappears without a trace of what
 * it was. `DELETION.md` carries the procedure.
 */

export interface ScrubTarget {
    assessments: FortnightAssessmentDoc[];
    warnings: WarningDoc[];
}

/**
 * Split a target into what a rehearsal wrote and what is real.
 *
 * Pure, and the only place the distinction is drawn, so the command that shows
 * the confirmation and the button that acts on it cannot disagree about which
 * records are protected. Warnings follow their assessment rather than their own
 * flag: a warning issued from a real assessment is real whatever else is true,
 * and one issued from a rehearsal was never anything.
 */
export function partitionByRealness(target: ScrubTarget): {
    rehearsal: ScrubTarget;
    real: ScrubTarget;
} {
    const rehearsalIds = new Set(
        target.assessments
            .filter((entry) => entry.rehearsal === true)
            .map((entry) => entry._id.toHexString())
    );

    // A conduct warning has no assessment, so it belongs to no rehearsal and to
    // no fortnight. It can never be a purge's leftovers, and it is never in
    // scope for one: `real` is where it lands, and `real` is what a purge
    // refuses to touch without the deployment switch.
    const belongsToRehearsal = (warning: WarningDoc): boolean =>
        warning.assessmentId !== null &&
        rehearsalIds.has(warning.assessmentId.toHexString());

    return {
        rehearsal: {
            assessments: target.assessments.filter((entry) => entry.rehearsal === true),
            warnings: target.warnings.filter(belongsToRehearsal)
        },
        real: {
            assessments: target.assessments.filter((entry) => entry.rehearsal !== true),
            warnings: target.warnings.filter((warning) => !belongsToRehearsal(warning))
        }
    };
}

/**
 * What this deployment is actually allowed to delete.
 *
 * With the dangerous-operations switch off, a purge is narrowed to the records
 * a rehearsal wrote. Those were never real, so removing them costs nothing and
 * clearing up after a dry run stays a one-click job. Everything else is
 * somebody's assessment history and stays put.
 */
export function permittedScrub(
    target: ScrubTarget,
    dangerousAllowed: boolean
): { allowed: ScrubTarget; refused: ScrubTarget } {
    const split = partitionByRealness(target);
    return dangerousAllowed
        ? { allowed: target, refused: { assessments: [], warnings: [] } }
        : { allowed: split.rehearsal, refused: split.real };
}

/** What a scrub would remove, without removing any of it. */
export async function scrubPreview(fortnightIndex: number | null): Promise<ScrubTarget> {
    // A null index means every fortnight before the anchor, which is the whole
    // of the flood and nothing else.
    const filter =
        fortnightIndex === null ? { fortnightIndex: { $lt: 0 } } : { fortnightIndex };

    const assessments = await collections.fortnightAssessments().find(filter).toArray();
    const ids = assessments.map((entry) => entry._id);
    const warnings =
        ids.length === 0
            ? []
            : await collections
                  .warnings()
                  .find({ assessmentId: { $in: ids } })
                  .toArray();

    return { assessments, warnings };
}

export interface ScrubResult {
    assessments: number;
    warnings: number;
}

/**
 * Write down what is about to go, before any of it goes.
 *
 * Split from the deleting so a caller can interleave work between the two: the
 * review's cards in the channel have to be removed while the documents that
 * know where they are still exist, and they must not be removed before the
 * audit row lands either. Audit, then the channel, then the documents.
 *
 * The write is not wrapped in `audit()`, which deliberately swallows its own
 * failures: here a failed audit has to stop the delete, exactly as it does on
 * the leave purge path.
 */
export async function recordScrubIntent(
    target: ScrubTarget,
    actorId: string,
    reason: string
): Promise<ScrubReceipt> {
    if (target.assessments.length === 0) return { auditedAt: new Date(), records: 0 };

    await collections.auditLog().insertOne({
        _id: new ObjectId(),
        actorId,
        action: "assessment.scrub",
        targetStaffId: null,
        at: new Date(),
        detail: {
            reason,
            assessments: target.assessments.map((entry) => ({
                id: entry._id.toHexString(),
                staffId: entry.staffId.toHexString(),
                fortnightIndex: entry.fortnightIndex,
                totalMinutes: entry.totalMinutes,
                requiredMinutes: entry.requiredMinutes,
                status: entry.status,
                reviewOutcome: entry.reviewOutcome,
                reviewNote: entry.reviewNote,
                rehearsal: entry.rehearsal === true,
                reviewChannelId: entry.reviewChannelId ?? null,
                reviewMessageId: entry.reviewMessageId ?? null
            })),
            warnings: target.warnings.map((entry) => ({
                id: entry._id.toHexString(),
                staffId: entry.staffId.toHexString(),
                issuedAt: entry.issuedAt,
                note: entry.note,
                rehearsal: entry.rehearsal === true
            }))
        }
    });

    return { auditedAt: new Date(), records: target.assessments.length };
}

/**
 * Proof that the audit row landed.
 *
 * `deleteScrubbed` demands one, so the ordering is a type error to get wrong
 * rather than a comment somebody has to notice. The leave purge learned the
 * same lesson by writing the audit row before deleting and aborting if it
 * failed; this makes the sequence unskippable instead of conventional.
 */
export interface ScrubReceipt {
    auditedAt: Date;
    records: number;
}

export interface ScrubResult {
    assessments: number;
    warnings: number;
}

/**
 * Remove them. The receipt is the point: it can only come from a successful
 * audit write, so there is no way to reach this function without one.
 */
export async function deleteScrubbed(
    target: ScrubTarget,
    receipt: ScrubReceipt
): Promise<ScrubResult> {
    if (target.assessments.length === 0) return { assessments: 0, warnings: 0 };

    // The audit row describes a set of records; deleting a different set would
    // leave the log describing something that did not happen.
    if (receipt.records !== target.assessments.length) {
        throw new Error(
            "Scrub target changed after it was audited; nothing was deleted."
        );
    }

    const warnings = await collections
        .warnings()
        .deleteMany({ _id: { $in: target.warnings.map((entry) => entry._id) } });
    const assessments = await collections
        .fortnightAssessments()
        .deleteMany({ _id: { $in: target.assessments.map((entry) => entry._id) } });

    return {
        assessments: assessments.deletedCount,
        warnings: warnings.deletedCount
    };
}
