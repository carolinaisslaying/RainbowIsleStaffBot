/**
 * Who may see a rendered leaderboard, and therefore where it may be posted.
 *
 * The leaderboard is public by design: standings are more use in the channel
 * than in one person's ephemeral reply. But two copies of it are not public
 * documents. A Lead or Executive sees the members who marked themselves hidden,
 * flagged rather than removed, because the ranks they read have to be the real
 * ranks. And a member who marked themselves hidden still sees their own row.
 * Posting either copy in a channel publishes exactly what the setting exists to
 * withhold, to the people it was withheld from.
 *
 * So the card is private when the viewer's copy contains something the room may
 * not see, and public when it does not. It always says which, and why.
 * The card explaining itself every time is what makes a rule that changes with
 * the roster safe: nobody has to remember it, because it is on the card.
 */

export interface LeaderboardAudience {
    /** Lead or Executive: sees hidden members, flagged. */
    privileged: boolean;
    /** The viewer has hidden themselves, so their own row is a private row. */
    viewerHidden: boolean;
    /** How many members are currently hiding. */
    hiddenCount: number;
}

export interface LeaderboardVisibility {
    /** Send it where only the viewer can read it. */
    ephemeral: boolean;
    /** Said on the card, every time, whichever way it went. */
    note: string;
}

export function leaderboardVisibility(audience: LeaderboardAudience): LeaderboardVisibility {
    const seesHiddenOthers = audience.privileged && audience.hiddenCount > 0;

    if (seesHiddenOthers && audience.viewerHidden) {
        return {
            ephemeral: true,
            note:
                `Only you can see this. It shows ${audience.hiddenCount} member(s) who have ` +
                "hidden themselves, marked as hidden, and your own row, which is hidden from " +
                "other Moderators. Do not screenshot it into a shared channel."
        };
    }

    if (seesHiddenOthers) {
        return {
            ephemeral: true,
            note:
                `Only you can see this, because you are Lead or Executive and it shows ` +
                `${audience.hiddenCount} member(s) who have hidden themselves, marked as ` +
                "hidden. Other Moderators posting the leaderboard do not see those rows. Do " +
                "not screenshot it into a shared channel."
        };
    }

    if (audience.viewerHidden) {
        return {
            ephemeral: true,
            note:
                "Only you can see this, because you have hidden yourself from the leaderboard " +
                "and your own row is on it. Everyone else's copy leaves you out."
        };
    }

    // Nothing on this copy is withheld from anyone, so it can go in the channel.
    // A privileged viewer lands here too, whenever nobody is hiding.
    return {
        ephemeral: false,
        note: "Everyone in this channel can see this. Nobody is hidden from the leaderboard."
    };
}
