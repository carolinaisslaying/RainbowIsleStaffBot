import { Events } from "discord.js";
import { assertEnvironment, env } from "./config/env.js";
import { connectDatabase, closeDatabase } from "./db/client.js";
import { ensureConfigDocument, loadConfig } from "./config/guildConfig.js";
import { assertRoleHierarchy, createClient } from "./discord/client.js";
import { cacheGuildNames } from "./discord/guildNames.js";
import { registerCommands } from "./commands/index.js";
import { registerInteractionHandler } from "./events/interactionCreate.js";
import { registerMessageHandler } from "./events/messageCreate.js";
import { registerPresenceHandler } from "./events/presenceUpdate.js";
import { reconcileOnBoot } from "./jobs/reconcile.js";
import { registerJobs } from "./jobs/index.js";
import { stopScheduler } from "./jobs/scheduler.js";
import { startApiServer } from "./api/server.js";
import { warmTimezoneIndexes } from "./time/timezones.js";
import { log } from "./log.js";

async function main(): Promise<void> {
    assertEnvironment();

    // Built once at startup so no member pays for it inside an autocomplete.
    warmTimezoneIndexes();

    await connectDatabase();
    await ensureConfigDocument();
    const config = await loadConfig();

    const client = createClient();

    registerInteractionHandler(client);
    registerMessageHandler(client);
    registerPresenceHandler(client);

    client.once(Events.ClientReady, async (ready) => {
        log.info(`Logged in as ${ready.user.tag}`);

        // Resolve both server names up front so every card and DM calls them
        // whatever they are actually called.
        await cacheGuildNames(client, config);

        // Register commands FIRST, before anything that can fail.
        //
        // The hierarchy check below can fail for reasons that are only fixable
        // with /config set, such as a mistyped or deleted role ID. If a
        // failure there stopped registration, the operator would be left with a
        // bot that has no commands and no way to correct the config that broke
        // it. Registration must not depend on the guild being correct.
        await registerCommands(config);

        // The bot's highest role must sit above every role it manages, or role
        // changes fail silently at exactly the wrong moment. The spec asks for a
        // fatal error logged at startup, which is what this is: loud, repeated
        // in the logs, and leaving the bot running so /config remains reachable
        // to fix it. Role writes already fail safe and are logged individually.
        const hierarchyOk = await assertRoleHierarchy(client, config);
        if (!hierarchyOk) {
            log.error(
                "FATAL: role hierarchy or permissions are wrong in the public guild. " +
                    "Role changes WILL fail until this is fixed. Move the bot's role above " +
                    "every managed role, or correct the role IDs with /config set. " +
                    "The bot is still running so that /config is reachable."
            );
        }

        // Mandatory, and before the schedulers start touching anything.
        await reconcileOnBoot(client, config);

        await registerJobs(client);
        startApiServer();

        log.info("Rainbow Isle staff bot is ready.");
    });

    client.on(Events.Error, (error) => log.error("Discord client error", error));
    client.on(Events.Warn, (warning) => log.warn(`Discord warning: ${warning}`));

    await client.login(env.discordToken);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            log.info(`Received ${signal}, shutting down.`);
            void shutdown(client);
        });
    }
}

async function shutdown(client: ReturnType<typeof createClient>): Promise<void> {
    stopScheduler();
    try {
        await client.destroy();
    } catch (error) {
        log.debug("Error destroying client", error);
    }
    await closeDatabase();
    process.exit(process.exitCode ?? 0);
}

process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", reason);
});

main().catch((error) => {
    log.error("Fatal startup error", error);
    process.exit(1);
});
