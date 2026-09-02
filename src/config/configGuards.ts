import { fortnightIndexFor, fortnightWindow, weekStartFor } from "../time/calendar.js";
import { fortnightAnchorDate, type StaffBotConfig } from "./guildConfig.js";

/**
 * Configuration that parses, validates, and still will not do what its author
 * expects.
 *
 * `parseConfigValue` answers "is this a number in range". These answer "is this
 * a policy that can be met, and does the deployment behave the way the person
 * setting it thinks". Nothing here refuses a write: policy belongs to the
 * Executive, and a bot that argues with its owner gets worked around. They say
 * what the setting will do, on the card, at the moment it is set.
 *
 * Pure functions over a config object so `/config set` and `/config view` show
 * the same warnings, and so a document that was already in a bad state is
 * flagged without anybody having to set the key again.
 */

export interface ConfigWarning {
    /** The key the reader should look at. */
    key: keyof StaffBotConfig;
    /** One sentence, in the terms of the thing it breaks, not the code. */
    text: string;
}

/**
 * Whether the cycle has started at all.
 *
 * `fortnightIndexFor` floors an unbounded division, so every week before the
 * anchor is a negative index and `isAssessableFortnight` refuses all of them.
 * That guard is right — a fortnight before the anchor would measure members
 * over days the deployment did not exist for — but it is silent, and a
 * deployment whose anchor has not arrived assesses nobody, warns nobody, and
 * explains itself only in a debug log. The default anchor ships in the future,
 * so this is the state a fresh install is in.
 */
export function anchorStatus(
    config: StaffBotConfig,
    now: Date
): { reached: boolean; anchor: Date; firstAssessableCloses: Date } {
    const anchor = fortnightAnchorDate(config);
    const week = weekStartFor(now, config.accountingTimezone, config.weekStartDay);
    const index = fortnightIndexFor(week, anchor);

    // Fortnight 0 is the first the cycle counts. Its window closes at the end
    // of its second week, which is the first moment anything can be assessed.
    const first = fortnightWindow(
        0,
        anchor,
        config.accountingTimezone,
        config.weekStartDay
    );

    return {
        reached: index >= 0,
        anchor,
        firstAssessableCloses: first.end
    };
}

/**
 * A requirement nobody can reach by meeting their weekly target twice.
 *
 * A fortnight is two weeks. If `fortnightRequiredMinutes` exceeds
 * `weeklyTargetMinutes` doubled, a member who closes both weekly rings still
 * lands below the requirement and arrives in the review queue — so the rings
 * say one thing and the assessment says another, and neither is wrong.
 */
export function requirementIsReachable(config: StaffBotConfig): boolean {
    return config.fortnightRequiredMinutes <= config.weeklyTargetMinutes * 2;
}

/**
 * A shift that ends before the member is even marked Away.
 *
 * `autoEndAfterAwayMinutes` counts from the moment a shift goes Away, so it is
 * not directly comparable to `awayAfterMinutes` — but a value below it means a
 * member goes Away and is auto-ended sooner than the bot waited to decide they
 * were absent in the first place, which is almost never what somebody means to
 * configure.
 */
export function autoEndIsGenerous(config: StaffBotConfig): boolean {
    return config.autoEndAfterAwayMinutes >= config.awayAfterMinutes;
}

/**
 * Every sanity warning a config document earns, in the order a reader wants
 * them: what stops the bot working, then what makes it behave oddly.
 */
export function configWarnings(config: StaffBotConfig, now: Date): ConfigWarning[] {
    const warnings: ConfigWarning[] = [];

    const anchor = anchorStatus(config, now);
    if (!anchor.reached) {
        warnings.push({
            key: "fortnightAnchor",
            text:
                "The fortnight cycle has not started yet, so **nobody is being assessed and no " +
                "warning can be issued**. The first fortnight this cycle counts closes " +
                `<t:${Math.floor(anchor.firstAssessableCloses.getTime() / 1000)}:D>. ` +
                "Move the anchor back if assessment should already be running."
        });
    }

    if (!requirementIsReachable(config)) {
        warnings.push({
            key: "fortnightRequiredMinutes",
            text:
                `**${config.fortnightRequiredMinutes} minutes cannot be reached.** A fortnight ` +
                `is two weeks and the weekly target is ${config.weeklyTargetMinutes}, so a ` +
                `member who closes both weekly rings still finishes on ` +
                `${config.weeklyTargetMinutes * 2} and lands in the review queue.`
        });
    }

    if (!autoEndIsGenerous(config)) {
        warnings.push({
            key: "autoEndAfterAwayMinutes",
            text:
                `A shift ends ${config.autoEndAfterAwayMinutes} minutes after going Away, but ` +
                `the bot waits ${config.awayAfterMinutes} minutes of silence before deciding ` +
                "somebody is Away at all. Ending sooner than that gives them less time to come " +
                "back than it took to notice they had gone."
        });
    }

    return warnings;
}

/**
 * The two keys that rewrite history.
 *
 * `weekStartDay` and `accountingTimezone` decide where every week and fortnight
 * boundary falls, for every record ever written. Changing either reindexes the
 * lot: stored `weeklyStats` and `fortnightAssessments` describe windows that no
 * longer exist, and a member's past verdicts move under them. Neither is a
 * setting anybody should be able to change without being told that.
 */
export const HISTORY_REWRITING_KEYS: readonly (keyof StaffBotConfig)[] = [
    "weekStartDay",
    "accountingTimezone"
];

export function rewritesHistory(key: keyof StaffBotConfig): boolean {
    return HISTORY_REWRITING_KEYS.includes(key);
}

/**
 * What the confirmation for one of those keys says, given how much is stored.
 *
 * Takes the counts rather than fetching them, so the wording is testable and so
 * the caller decides what a query costs.
 */
export function historyChangeWarning(options: {
    key: keyof StaffBotConfig;
    currentValue: string;
    newValue: string;
    weeklyStats: number;
    assessments: number;
}): string {
    const stored =
        options.weeklyStats === 0 && options.assessments === 0
            ? "Nothing is stored yet, so this is free to change."
            : `**${options.weeklyStats} weekly rollup${options.weeklyStats === 1 ? "" : "s"}** and ` +
              `**${options.assessments} fortnight assessment${
                  options.assessments === 1 ? "" : "s"
              }** are already stored against the old boundaries. They will not match the ` +
              "calendar any more, and past verdicts can move.";

    return (
        `Changing **${String(options.key)}** from \`${options.currentValue}\` to ` +
        `\`${options.newValue}\` moves where every week and fortnight begins — not just ` +
        `from now on, but for every record ever written.\n\n${stored}\n\n` +
        "Run a recompute afterwards to rebuild the rollups against the new boundaries."
    );
}
