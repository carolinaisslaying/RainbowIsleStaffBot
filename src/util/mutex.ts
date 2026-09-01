/**
 * Per-key serialisation for read-modify-write sequences inside this process.
 * The bot is a single process by design, so a keyed promise chain is sufficient
 * to make a bitmap update atomic with respect to every other writer.
 */

const queues = new Map<string, Promise<void>>();

export function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    // The chain tracks completion only. Swallowing here keeps one caller's
    // rejection from poisoning every later waiter on the same key.
    const tail = result.then(
        () => undefined,
        () => undefined
    );
    queues.set(key, tail);
    void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
}

export function clearLocks(): void {
    queues.clear();
}
