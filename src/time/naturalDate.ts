/**
 * Reading a date out of ordinary English.
 *
 * The parser does not try to work out which day a phrase means. It works out
 * what the phrase *constrains*: a weekday, a day of the month, a month, an
 * hour. It hands that to a resolver which walks forward from the member's own
 * today until it finds the first date satisfying all of it. That split is what
 * makes "Tuesday the 6th" behave: the two facts are constraints on one date
 * rather than two competing answers, and a phrase whose constraints can never
 * agree fails honestly instead of silently picking one of them.
 *
 * Resolving forward also gives leave its future-only rule for nothing. A member
 * typing "Tuesday" in the leave form cannot mean the Tuesday that has gone.
 *
 * Everything here is pure and timezone-free. The zone belongs to the resolver
 * in input.ts, because "today" is a different day in Auckland than in London
 * and the parser has no business guessing which one it is standing in.
 */

const WEEKDAYS: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tues: 2, tue: 2,
    wednesday: 3, weds: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6
};

const MONTHS: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sept: 9, sep: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
};

/**
 * The hour a part of the day means, when no clock time was given.
 *
 * These are conventions rather than facts, so they are deliberately boring: a
 * member who cares about the exact hour types one, and a member who says
 * "Tuesday morning" gets a reasonable 9am they can see on the confirmation card
 * before anything is recorded.
 */
const DAYPARTS: Record<string, number> = {
    morning: 9,
    afternoon: 13,
    evening: 18,
    night: 21
};

/**
 * Words that carry no meaning but that people pad a date with. Anything left
 * over that is not in here means the phrase was only partly understood, and a
 * partly understood date is a guess, so the whole parse fails.
 */
const FILLER = new Set([
    "on", "the", "of", "this", "coming", "at", "from", "to", "till", "until",
    "starting", "start", "starts", "beginning", "back", "return", "returning",
    "due", "please", "and", "a", "an", "sometime", "around", "about", "leave",
    "off", "away", "im", "i'm", "be", "for", "next"
]);

export interface PhraseConstraints {
    year?: number;
    month?: number;
    day?: number;
    weekday?: number;
    /** Whole days added to today, for "tomorrow" and "in 3 days". */
    offsetDays?: number;
    /** Whole months added to today, for "next month". */
    offsetMonths?: number;
    /** "next Tuesday" means the one after today, even if today is Tuesday. */
    skipToday?: boolean;
    /** The phrase pins one calendar date. The resolver must not search past it. */
    exact?: boolean;
    hour: number;
    minute: number;
}

interface TimeReading {
    hour: number;
    minute: number;
}

/** A meridiem reading, or null when the hour it was attached to is impossible. */
function applyMeridiem(hour: number, meridiem: string | undefined): number | null {
    if (!meridiem) return hour <= 23 ? hour : null;
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.startsWith("p");
    if (pm) return hour === 12 ? 12 : hour + 12;
    return hour === 12 ? 0 : hour;
}

/**
 * Pull a clock time out of the phrase, returning the rest of it.
 *
 * `ok: false` is not the same as finding no time. An hour of 25 or a minute of
 * 75 means the member typed a time and got it wrong, and answering that with a
 * date at midnight would be worse than refusing.
 */
function extractTime(
    input: string
): { ok: false } | { ok: true; rest: string; time: TimeReading | null } {
    const patterns: Array<{ re: RegExp; read: (m: RegExpExecArray) => TimeReading | null }> = [
        // 10.16 pm, 10:16pm, 10.16p.m.
        {
            re: /\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/,
            read: (m) => {
                const hour = applyMeridiem(Number(m[1]), m[3].replace(/\./g, ""));
                const minute = Number(m[2]);
                return hour === null || minute > 59 ? null : { hour, minute };
            }
        },
        // 9am, 9 pm
        {
            re: /\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/,
            read: (m) => {
                const hour = applyMeridiem(Number(m[1]), m[2].replace(/\./g, ""));
                return hour === null ? null : { hour, minute: 0 };
            }
        },
        {
            re: /\b(noon|midday)\b/,
            read: () => ({ hour: 12, minute: 0 })
        },
        {
            re: /\bmidnight\b/,
            read: () => ({ hour: 0, minute: 0 })
        },
        // 22:16 always, 10.16 only when "at" marks it as a time rather than a date.
        {
            re: /\b(\d{1,2}):(\d{2})\b/,
            read: (m) => {
                const hour = Number(m[1]);
                const minute = Number(m[2]);
                return hour > 23 || minute > 59 ? null : { hour, minute };
            }
        },
        {
            re: /\bat\s+(\d{1,2})\.(\d{2})\b/,
            read: (m) => {
                const hour = Number(m[1]);
                const minute = Number(m[2]);
                return hour > 23 || minute > 59 ? null : { hour, minute };
            }
        },
        // "at 9", which is an hour and not a day of the month.
        {
            re: /\bat\s+(\d{1,2})\b(?!\s*(st|nd|rd|th))/,
            read: (m) => {
                const hour = Number(m[1]);
                return hour > 23 ? null : { hour, minute: 0 };
            }
        }
    ];

    for (const { re, read } of patterns) {
        const match = re.exec(input);
        if (!match) continue;
        const time = read(match);
        if (!time) return { ok: false };
        return {
            ok: true,
            rest: `${input.slice(0, match.index)} ${input.slice(match.index + match[0].length)}`,
            time
        };
    }

    return { ok: true, rest: input, time: null };
}

/** Remove the first match, leaving a space so words cannot fuse together. */
function cut(input: string, match: RegExpExecArray): string {
    return `${input.slice(0, match.index)} ${input.slice(match.index + match[0].length)}`;
}

const WEEKDAY_WORDS = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length);
const MONTH_WORDS = Object.keys(MONTHS).sort((a, b) => b.length - a.length);

/**
 * Read a phrase into the constraints it places on a date.
 *
 * Returns null when nothing was recognised, when two readings contradict each
 * other, or when anything is left over that the parser cannot account for.
 */
export function parsePhrase(raw: string): PhraseConstraints | null {
    let rest = raw
        .toLowerCase()
        .replace(/[,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (rest === "") return null;

    // A slash date reads as 6 October here and as 10 June to half the internet.
    // There is no reading of it that is safe to guess, so it is refused by name.
    if (rest.includes("/")) return null;

    const constraints: PhraseConstraints = { hour: 0, minute: 0 };

    const time = extractTime(rest);
    if (!time.ok) return null;
    rest = time.rest;
    if (time.time) {
        constraints.hour = time.time.hour;
        constraints.minute = time.time.minute;
    }

    // "tonight" is a day and an hour in one word.
    const tonight = /\btonight\b/.exec(rest);
    if (tonight) {
        rest = cut(rest, tonight);
        constraints.offsetDays = 0;
        constraints.exact = true;
        if (!time.time) constraints.hour = DAYPARTS.night;
    }

    if (!time.time && constraints.hour === 0 && constraints.minute === 0) {
        for (const [word, hour] of Object.entries(DAYPARTS)) {
            const match = new RegExp(`\\b${word}\\b`).exec(rest);
            if (match) {
                rest = cut(rest, match);
                constraints.hour = hour;
                break;
            }
        }
    }

    // Order matters: the longer phrase has to go before the word it contains.
    const dayAfter = /\bday after tomorrow\b/.exec(rest);
    if (dayAfter) {
        rest = cut(rest, dayAfter);
        constraints.offsetDays = 2;
        constraints.exact = true;
    }

    const tomorrow = /\b(tomorrow|tomorow|tmrw|tmr|tmw)\b/.exec(rest);
    if (tomorrow) {
        if (constraints.offsetDays !== undefined) return null;
        rest = cut(rest, tomorrow);
        constraints.offsetDays = 1;
        constraints.exact = true;
    }

    const today = /\btoday\b/.exec(rest);
    if (today) {
        if (constraints.offsetDays !== undefined) return null;
        rest = cut(rest, today);
        constraints.offsetDays = 0;
        constraints.exact = true;
    }

    const counted =
        /\bin (a|an|\d{1,3}) (day|week|fortnight|month)s?\b/.exec(rest) ??
        /\b(\d{1,3}) (day|week|fortnight|month)s? from now\b/.exec(rest);
    if (counted) {
        if (constraints.offsetDays !== undefined) return null;
        rest = cut(rest, counted);
        const count = /^\d+$/.test(counted[1]) ? Number(counted[1]) : 1;
        const unit = counted[2];
        if (unit === "month") constraints.offsetMonths = count;
        else if (unit === "week") constraints.offsetDays = count * 7;
        else if (unit === "fortnight") constraints.offsetDays = count * 14;
        else constraints.offsetDays = count;
        constraints.exact = true;
    }

    const nextUnit = /\bnext (week|fortnight|month)\b/.exec(rest);
    if (nextUnit) {
        if (constraints.offsetDays !== undefined || constraints.offsetMonths !== undefined) {
            return null;
        }
        rest = cut(rest, nextUnit);
        if (nextUnit[1] === "month") constraints.offsetMonths = 1;
        else constraints.offsetDays = nextUnit[1] === "fortnight" ? 14 : 7;
        constraints.exact = true;
    }

    // "next tuesday" skips today. Read before the bare weekday, and note that
    // the word "next" itself stays in the string as filler.
    const nextWeekday = new RegExp(`\\bnext (${WEEKDAY_WORDS.join("|")})\\b`).exec(rest);
    if (nextWeekday) {
        rest = cut(rest, nextWeekday);
        constraints.weekday = WEEKDAYS[nextWeekday[1]];
        constraints.skipToday = true;
    }

    for (const word of WEEKDAY_WORDS) {
        const match = new RegExp(`\\b${word}\\b`).exec(rest);
        if (!match) continue;
        // A second, different weekday is a contradiction rather than a refinement.
        if (constraints.weekday !== undefined) return null;
        rest = cut(rest, match);
        constraints.weekday = WEEKDAYS[word];
    }

    for (const word of MONTH_WORDS) {
        const match = new RegExp(`\\b${word}\\b`).exec(rest);
        if (!match) continue;
        if (constraints.month !== undefined) return null;
        rest = cut(rest, match);
        constraints.month = MONTHS[word];
    }

    const year = /\b(\d{4})\b/.exec(rest);
    if (year) {
        rest = cut(rest, year);
        constraints.year = Number(year[1]);
    }

    const day = /\b(\d{1,2})(st|nd|rd|th)?\b/.exec(rest);
    if (day) {
        const value = Number(day[1]);
        if (value < 1 || value > 31) return null;
        rest = cut(rest, day);
        constraints.day = value;
    }

    // A second number, a stray word, anything the parser could not account for:
    // reading a date out of what is left would be guessing.
    const leftovers = rest.split(/\s+/).filter((word) => word !== "");
    if (leftovers.some((word) => !FILLER.has(word))) return null;

    const named =
        constraints.weekday !== undefined ||
        constraints.day !== undefined ||
        constraints.month !== undefined ||
        constraints.offsetDays !== undefined ||
        constraints.offsetMonths !== undefined;
    if (!named) return null;

    // A weekday alongside an offset is a search within the week the offset
    // lands in, not a fixed date, so the resolver has to keep looking.
    if (constraints.weekday !== undefined) constraints.exact = false;

    // A full calendar date needs no search either.
    if (
        constraints.year !== undefined &&
        constraints.month !== undefined &&
        constraints.day !== undefined
    ) {
        constraints.exact = true;
    }

    return constraints;
}
