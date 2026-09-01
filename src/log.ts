/** Minimal levelled logger. No dependency, structured enough to grep. */

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold = levels[(process.env.LOG_LEVEL as Level) ?? "info"] ?? levels.info;

function emit(level: Level, message: string, detail?: unknown): void {
    if (levels[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (detail === undefined) {
        console[level === "debug" ? "log" : level](line);
    } else {
        console[level === "debug" ? "log" : level](line, detail);
    }
}

export const log = {
    debug: (message: string, detail?: unknown) => emit("debug", message, detail),
    info: (message: string, detail?: unknown) => emit("info", message, detail),
    warn: (message: string, detail?: unknown) => emit("warn", message, detail),
    error: (message: string, detail?: unknown) => emit("error", message, detail)
};
