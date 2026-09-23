/**
 * What leave does, in the words every leave message uses.
 *
 * Two separate things happen during leave, and the messages used to blur them
 * with one phrase: roles were "set aside" and so were weeks, which read as if
 * a week with too little leave kept your roles from you. They are unrelated.
 * Roles follow the dates of the leave, always. Exemption follows how many days
 * of leave land in a week, and only changes what the fortnight asks for. So
 * each has its own word ("removed", "exempt") and its own paragraph, and the
 * old "streak" is named for what it is.
 */
export function leaveTermsText(minimumLeaveDays: number): string {
    return (
        "**Your staff roles** are removed when the leave starts and given back " +
        "automatically when it ends, whatever the dates.\n\n" +
        "**Your activity requirement** is separate. A week with at least " +
        `${minimumLeaveDays} days of this leave in it is exempt: its rings go grey and ` +
        "your fortnight asks for one weekly target fewer. A week with fewer days of leave " +
        "still counts in full, even on days your roles are removed.\n\n" +
        "-# Exempt weeks don't break your run of weeks in a row meeting the target, and " +
        "don't add to it."
    );
}
