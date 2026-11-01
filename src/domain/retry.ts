const DEFAULT_DELAYS_MS = [2_000, 5_000];

/**
 * Ask again, after each delay, until the answer is one that can be trusted. The
 * last answer comes back either way, for the caller to treat as it must.
 */
export async function retrying<T>(
    attempt: () => Promise<T>,
    settled: (result: T) => boolean,
    delaysMs: readonly number[] = DEFAULT_DELAYS_MS,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<T> {
    let result = await attempt();
    for (const delay of delaysMs) {
        if (settled(result)) return result;
        await sleep(delay);
        result = await attempt();
    }
    return result;
}
