import { Events, type Client, type Message } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { recordDemand } from "../domain/demand.js";
import { creditMinute } from "../domain/activity.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { getOpenShift, openPauseOf } from "../domain/shifts.js";
import { comeBack, endShiftIfStillInvisible, markSeen } from "../services/shiftService.js";
import { presenceStatusOf } from "../discord/presence.js";
import { messageEffect } from "../domain/presence.js";
import { maybeRingClosure } from "../services/notifications.js";
import { noteOffShiftMessage } from "../services/shiftReminderService.js";
import { log } from "../log.js";

/**
 * The bot never reads message text. Without the MessageContent intent this
 * event still carries author, channel and timestamp, which is everything the
 * minute accounting needs.
 *
 * A message does three things: it counts toward server demand if the channel is
 * tracked, it brings the sender back from Away, and it credits one activity
 * minute if the sender is Available and the channel is tracked.
 *
 * From somebody with no shift open, a message in a tracked channel counts
 * towards the reminder to start one (services/shiftReminderService.ts).
 *
 * The last two need the sender visible. A message from a member Discord shows
 * as offline, which is how invisible looks, credits nothing and ends their
 * shift (domain/presence.ts).
 */
export function registerMessageHandler(client: Client): void {
    client.on(Events.MessageCreate, async (message: Message) => {
        try {
            if (message.author.bot) return;

            const config = await loadConfig();
            if (message.guildId !== config.publicGuildId) return; // staff guild never counts

            // Threads count if their parent channel is whitelisted.
            const channelId = message.channel.isThread()
                ? (message.channel.parentId ?? message.channelId)
                : message.channelId;
            const tracked = config.trackedChannels.includes(channelId);

            // Demand is counted for every member, staff or not. No identity is
            // recorded: the bucket is a channel and an hour and a counter.
            if (tracked) await recordDemand(channelId, message.createdAt);

            const staff = await findStaffByDiscordId(message.author.id);
            if (!staff) return;

            // Any message in any public channel counts as presence for the
            // inactivity sweep, whether or not the channel is tracked.
            markSeen(staff._id, message.createdAt);

            const shift = await getOpenShift(staff._id);
            if (!shift) {
                // Activity without a shift earns nothing, so the bot DMs a
                // reminder once a member posts enough of it in a short window.
                if (tracked) await noteOffShiftMessage(client, config, staff, message.createdAt);
                return;
            }

            const status = presenceStatusOf(client, config.publicGuildId, message.author.id);
            const effect = messageEffect(status, openPauseOf(shift) !== null);
            if (effect === "end") {
                endShiftIfStillInvisible(client, config, staff, shift._id, message.createdAt);
                return;
            }
            // Unknown, which after a restart is nearly everybody: the message
            // counts, and Discord is asked in the background. Only its answer
            // can end the shift.
            if (status === null) {
                endShiftIfStillInvisible(client, config, staff, shift._id, message.createdAt);
            }

            // Returning from Away is automatic and requires nothing from them.
            if (effect === "resume") {
                await comeBack(client, config, staff, shift, message.createdAt);
                // The pause closed at this instant, so this minute is now
                // Available and may be credited below.
            }

            if (!tracked) return;

            const credited = await creditMinute(staff._id, message.createdAt);
            if (credited) {
                await maybeRingClosure(client, config, staff._id, message.createdAt);
            }
        } catch (error) {
            log.error("messageCreate handler failed", error);
        }
    });
}
