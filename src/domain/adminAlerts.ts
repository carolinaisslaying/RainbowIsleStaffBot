/**
 * When a failing job may DM the deployment's administrators again. Six hours,
 * because `shift-sweep` runs every minute: a fault that outlasts one run would
 * otherwise send one person a message a minute until somebody fixed it. The job
 * stays red on `/dev status` in between.
 */
export const JOB_ALERT_INTERVAL_MS = 6 * 3_600_000;

export function jobAlertDue(lastAlertAt: number | undefined, now: number): boolean {
    return lastAlertAt === undefined || now - lastAlertAt >= JOB_ALERT_INTERVAL_MS;
}
