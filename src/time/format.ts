import { wallClockIn } from "./calendar.js";

/**
 * Instants use Discord timestamp markup so every viewer sees their own clock.
 * Durations, window labels and axis labels have no Discord primitive, so they
 * are formatted here, in the viewer's timezone.
 */

export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/** <t:unix:style>. The only way this bot ever prints an instant. */
export function ts(instant: Date | number, style: TimestampStyle = "f"): string {
    const seconds = Math.floor(
        (instant instanceof Date ? instant.getTime() : instant) / 1000
    );
    return `<t:${seconds}:${style}>`;
}

/** "3 h 24 min", "48 min", "0 min". Durations are not instants. */
export function formatDuration(ms: number): string {
    const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} h`;
    return `${hours} h ${minutes} min`;
}

/**
 * "4 days", "1 day", "less than a day". For spans measured in days rather than
 * in shift hours: `formatDuration` renders a fortnight of leave as "336 h",
 * which is accurate and unreadable.
 */
export function formatDays(ms: number): string {
    const days = Math.round(ms / 86_400_000);
    if (days < 1) return "less than a day";
    return `${days} ${days === 1 ? "day" : "days"}`;
}

/** "120 minutes" / "1 minute". Activity minutes are always spelled out. */
export function formatMinutes(minutes: number): string {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Axis and window label only. Never used for an instant in prose. */
export function labelDate(instant: Date, timeZone: string): string {
    const wall = wallClockIn(instant, timeZone);
    return `${wall.day} ${MONTHS[wall.month - 1]}`;
}

export function labelWeekday(instant: Date, timeZone: string): string {
    return WEEKDAYS[wallClockIn(instant, timeZone).weekday];
}

/** "29 Sep to 12 Oct" for a fortnight window. Exclusive end is stepped back. */
export function labelWindow(start: Date, endExclusive: Date, timeZone: string): string {
    const lastDay = new Date(endExclusive.getTime() - 1);
    return `${labelDate(start, timeZone)} to ${labelDate(lastDay, timeZone)}`;
}

export function percent(value: number, target: number): number {
    if (target <= 0) return value > 0 ? 100 : 0;
    return Math.round((value / target) * 100);
}
