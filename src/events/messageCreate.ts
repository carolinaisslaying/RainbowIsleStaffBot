import { Events, type Client, type Message } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { recordDemand } from "../domain/demand.js";
import { creditMinute } from "../domain/activity.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { getOpenShift, openPauseOf } from "../domain/shifts.js";
import { comeBack, markSeen } from "../services/shiftService.js";
import { maybeRingClosure } from "../services/notifications.js";
import { log } from "../log.js";

/**
 * The bot never reads message text. Without the MessageContent intent this
 * event still carries author, channel and timestamp, which is everything the
 * minute accounting needs.
 *
 * A message does three things: it counts toward server demand if the channel is
 * tracked, it brings the sender back from Away, and it credits one activity
 * minute if the sender is Available and the channel is tracked.
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
            if (!shift) return;

            // Returning from Away is automatic and requires nothing from them.
            if (openPauseOf(shift)) {
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
