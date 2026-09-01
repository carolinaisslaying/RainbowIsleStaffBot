import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import { log } from "../log.js";

/**
 * Every role change, leave decision, warning, config change, relink and manual
 * recompute lands here. Append only; nothing ever edits or removes a row.
 */
export async function audit(
    action: string,
    options: {
        actorId?: string | null;
        targetStaffId?: ObjectId | null;
        detail?: Record<string, unknown>;
    } = {}
): Promise<void> {
    try {
        await collections.auditLog().insertOne({
            _id: new ObjectId(),
            actorId: options.actorId ?? null,
            action,
            targetStaffId: options.targetStaffId ?? null,
            detail: options.detail ?? {},
            at: new Date()
        });
    } catch (error) {
        // An audit failure must never take down the action it was recording.
        log.error(`Failed to write audit entry for ${action}`, error);
    }
}
