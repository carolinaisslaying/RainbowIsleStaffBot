import { log } from "../log.js";

/**
 * Scheduling is internal: one timer per job that computes its next boundary
 * against the accounting timezone and reschedules after firing. No cron
 * dependency, and nothing that assumes the process stayed up.
 *
 * Every job must be idempotent and must reconcile missed runs on boot, because
 * the container will restart.
 */

export type NextRun = (from: Date) => Date;

interface Job {
    name: string;
    next: NextRun;
    run: (at: Date) => Promise<void>;
    timer: NodeJS.Timeout | null;
}

const jobs: Job[] = [];
let running = false;

/** setTimeout saturates above ~24.8 days. Chain instead of firing immediately. */
const MAX_DELAY = 2_147_483_647;

export function schedule(name: string, next: NextRun, run: (at: Date) => Promise<void>): void {
    const job: Job = { name, next, run, timer: null };
    jobs.push(job);
    if (running) arm(job);
}

function arm(job: Job): void {
    const now = new Date();
    const target = job.next(now);
    const delay = Math.max(1000, target.getTime() - now.getTime());

    if (delay > MAX_DELAY) {
        job.timer = setTimeout(() => arm(job), MAX_DELAY);
        job.timer.unref?.();
        return;
    }

    log.debug(`Job ${job.name} next runs at ${target.toISOString()}`);
    job.timer = setTimeout(() => {
        void fire(job);
    }, delay);
    job.timer.unref?.();
}

async function fire(job: Job): Promise<void> {
    const at = new Date();
    try {
        await job.run(at);
        log.debug(`Job ${job.name} completed`);
    } catch (error) {
        // A failed job must not stop the schedule. The next run reconciles.
        log.error(`Job ${job.name} failed`, error);
    } finally {
        arm(job);
    }
}

export function startScheduler(): void {
    running = true;
    for (const job of jobs) arm(job);
    log.info(`Scheduler started with ${jobs.length} jobs`);
}

export function stopScheduler(): void {
    running = false;
    for (const job of jobs) {
        if (job.timer) clearTimeout(job.timer);
        job.timer = null;
    }
}

/** Next occurrence of a whole minute. */
export function everyMinute(from: Date): Date {
    return new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
}

/** Next occurrence of the top of an hour. */
export function everyHour(from: Date): Date {
    return new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
}
