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
 * Remove them, audit row first.
 *
 * The audit write is not wrapped in `audit()`, which deliberately swallows its
 * own failures: here a failed audit has to stop the delete, exactly as it does
 * on the leave purge path.
 */
export async function scrub(
    target: ScrubTarget,
    actorId: string,
    reason: string
): Promise<ScrubResult> {
    if (target.assessments.length === 0) return { assessments: 0, warnings: 0 };

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
                reviewNote: entry.reviewNote
            })),
            warnings: target.warnings.map((entry) => ({
                id: entry._id.toHexString(),
                staffId: entry.staffId.toHexString(),
                issuedAt: entry.issuedAt,
                note: entry.note
            }))
        }
    });

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
