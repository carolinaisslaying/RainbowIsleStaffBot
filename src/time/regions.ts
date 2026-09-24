import { wallClockIn } from "./calendar.js";

/**
 * Where to recruit for a coverage gap: the places having their evening while
 * it happens, so somebody recruited there covers the hole without working
 * through their own night.
 *
 * A curated list of places people live, not every IANA zone. Walking all ~400
 * zones alphabetically and stopping at eight filled the brief with Africa,
 * America, Antarctica and Asia before Europe or the Pacific came round, so it
 * read as favourites, named research stations and villages of a few hundred,
 * and printed identifiers nobody calls a place. One entry per population
 * centre, labelled the way a person would say it, each pinned to a zone that
 * carries its daylight saving rule.
 *
 * The server is English speaking, so the list is the places a moderator for it
 * is likely to come from: where English is the first language, an official
 * one, or the everyday language online. Fewer than that leaves hours of the day
 * with nobody in their evening; `test/regions.test.ts` fails if any UTC hour,
 * in either hemisphere's summer, has no region to suggest.
 */

export interface Region {
    label: string;
    zone: string;
}

export const RECRUITING_REGIONS: readonly Region[] = [
    { label: "Hawaii", zone: "Pacific/Honolulu" },
    { label: "Alaska", zone: "America/Anchorage" },
    { label: "US and Canada Pacific", zone: "America/Los_Angeles" },
    { label: "US and Canada Mountain", zone: "America/Denver" },
    { label: "US and Canada Central", zone: "America/Chicago" },
    { label: "US and Canada Eastern", zone: "America/New_York" },
    { label: "UK and Ireland", zone: "Europe/London" },
    { label: "West Africa", zone: "Africa/Lagos" },
    { label: "Central Europe", zone: "Europe/Berlin" },
    { label: "South Africa", zone: "Africa/Johannesburg" },
    { label: "Pakistan", zone: "Asia/Karachi" },
    { label: "India", zone: "Asia/Kolkata" },
    { label: "Singapore and the Philippines", zone: "Asia/Singapore" },
    { label: "Western Australia", zone: "Australia/Perth" },
    { label: "Eastern Australia", zone: "Australia/Sydney" },
    { label: "New Zealand", zone: "Pacific/Auckland" }
];

/** 18:00 inclusive to 23:00 exclusive, local: what the card calls the evening. */
export const EVENING_FROM_MINUTE = 18 * 60;
export const EVENING_TO_MINUTE = 23 * 60;
/** The middle of the evening, which the brief is ordered by closeness to. */
const MID_EVENING_MINUTE = (EVENING_FROM_MINUTE + EVENING_TO_MINUTE) / 2;

export interface EveningRegion {
    label: string;
    /** Local time at the instant asked about, "19:30". */
    localTime: string;
}

/**
 * The regions in their evening at `instant`, most sociable first: ordered by
 * how close the local time is to mid-evening, so a place at 20:30 comes before
 * one at 18:00 or 22:30. Ties keep the list's west-to-east order.
 */
export function regionsInEvening(
    instant: Date,
    regions: readonly Region[] = RECRUITING_REGIONS,
    limit = 5
): EveningRegion[] {
    return regions
        .map((region, index) => {
            const wall = wallClockIn(instant, region.zone);
            return { region, index, minute: wall.hour * 60 + wall.minute };
        })
        .filter(({ minute }) => minute >= EVENING_FROM_MINUTE && minute < EVENING_TO_MINUTE)
        .sort(
            (left, right) =>
                Math.abs(left.minute - MID_EVENING_MINUTE) -
                    Math.abs(right.minute - MID_EVENING_MINUTE) || left.index - right.index
        )
        .slice(0, limit)
        .map(({ region, minute }) => ({
            label: region.label,
            localTime:
                `${String(Math.floor(minute / 60)).padStart(2, "0")}:` +
                `${String(minute % 60).padStart(2, "0")}`
        }));
}
