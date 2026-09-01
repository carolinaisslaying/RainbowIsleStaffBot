import { Events, type Client, type Presence, type PresenceStatus } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { getOpenShift, openPauseOf } from "../domain/shifts.js";
import { comeBack, goAway, markSeen } from "../services/shiftService.js";
import { log } from "../log.js";

/**
 * Away detection from presence, driven by the TRANSITION rather than the status.
 *
 * Discord sets idle by itself after about ten minutes without client input, so
 * a move from online to idle is Discord telling us the member stopped touching
 * their computer, and that is worth acting on. The status idle on its own is
 * not: plenty of people run idle permanently, by preference or because their
 * client never reports otherwise, and treating that as absence marked them away
 * every time they so much as switched off do not disturb. It also never
 * recovered, because the return trip they made was idle to idle.
 *
 * So this handler reads the pair of statuses and nothing else:
 *
 *   online -> idle        away. Discord's own inactivity timer fired.
 *   anything -> offline   away. They closed Discord.
 *   offline -> anything   back. They opened it again.
 *
 * Every other pair, dnd to idle included, changes nothing at all. A member who
 * really does go quiet is still caught: the inactivity sweep in shiftService
 * marks them away after awayAfterMinutes of silence, which measures what they
 * did rather than what their client says.
 */

type Transition = "away" | "back" | "none";

export function transitionFor(
    before: PresenceStatus | null,
    after: PresenceStatus
): Transition {
    if (after === "offline") return before === "offline" ? "none" : "away";
    // Unknown previous status, which is what a cache miss or a fresh boot looks
    // like. There is no transition to read, so nothing is inferred.
    if (before === null) return "none";
    if (before === "offline") return "back";
    if (before === "online" && after === "idle") return "away";
    return "none";
}

export function registerPresenceHandler(client: Client): void {
    client.on(Events.PresenceUpdate, async (old: Presence | null, presence: Presence) => {
        try {
            const config = await loadConfig();
            if (presence.guild?.id !== config.publicGuildId) return;
            if (presence.user?.bot) return;

            const transition = transitionFor(old?.status ?? null, presence.status);
            if (transition === "none") return;

            const staff = await findStaffByDiscordId(presence.userId);
            if (!staff) return;

            const shift = await getOpenShift(staff._id);
            if (!shift) return;

            const paused = openPauseOf(shift);

            if (transition === "away" && !paused) {
                await goAway(client, config, staff, shift, "presence");
                return;
            }

            if (transition === "back" && paused) {
                markSeen(staff._id);
                await comeBack(client, config, staff, shift);
            }
        } catch (error) {
            log.error("presenceUpdate handler failed", error);
        }
    });
}
