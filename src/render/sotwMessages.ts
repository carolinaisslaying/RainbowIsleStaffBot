/**
 * What the new holder is told. One warm, generic message for now; the owner
 * replaces and extends this list, and the bot picks one at random.
 */
export const SOTW_CONGRATULATIONS: readonly string[] = [
    "Congratulations — you're Staff of the Week! Thank you for everything you do for the " +
        "island. The role is yours until the week turns over."
];

export function pickCongratulation(rng: () => number): string {
    const index = Math.min(SOTW_CONGRATULATIONS.length - 1, Math.floor(rng() * SOTW_CONGRATULATIONS.length));
    return SOTW_CONGRATULATIONS[index];
}
