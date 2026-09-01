/**
 * Process environment. Everything here is deployment wiring, not policy.
 * Policy lives in the guildConfig document and is edited with /config set.
 *
 * Values are read lazily through getters rather than at import time. Importing
 * a module must never be what fails: startup validation is explicit, in
 * assertEnvironment(), and unit tests can import the domain layer without
 * inventing a Discord token.
 */

function required(key: string): string {
    const value = process.env[key];
    if (value === undefined || value === "") {
        throw new Error(`Missing required environment variable ${key}`);
    }
    return value;
}

function optional(key: string, fallback: string): string {
    const value = process.env[key];
    return value === undefined || value === "" ? fallback : value;
}

export const env = {
    get discordToken(): string {
        return required("DISCORD_TOKEN");
    },
    get applicationId(): string {
        return required("DISCORD_APPLICATION_ID");
    },
    get publicGuildId(): string {
        return required("PUBLIC_GUILD_ID");
    },
    get staffGuildId(): string {
        return required("STAFF_GUILD_ID");
    },
    get mongoUrl(): string {
        return optional("MONGO_URL", "mongodb://mongo:27017");
    },
    get mongoDb(): string {
        return optional("MONGO_DB", "staffbot");
    },
    get apiPort(): number {
        return Number.parseInt(optional("API_PORT", "8080"), 10);
    },
    get apiBearerToken(): string {
        return optional("API_BEARER_TOKEN", "");
    },
    get logLevel(): string {
        return optional("LOG_LEVEL", "info");
    },
    /**
     * Discord user IDs treated as Executive regardless of their roles.
     *
     * This exists to solve the bootstrap deadlock: Executive tier is resolved
     * from `executiveRoles`, which is empty on a fresh install, so without an
     * escape hatch nobody can run the `/config set` that would populate it.
     *
     * It stays honoured after setup on purpose, because the same deadlock
     * happens if someone deletes or mis-sets the Executive role later. Keep the
     * list to the one or two people who administer the deployment; every use of
     * it is logged and audited.
     */
    /**
     * Whether `/dev purge` may delete records that are not rehearsals.
     *
     * Off unless the file says exactly `true`. A rehearsal's records were never
     * real and deleting them costs nothing, so those go either way. Everything
     * else is somebody's actual assessment history, and the command that
     * removes it should require a deliberate act outside Discord: a
     * misremembered fortnight number is one keystroke, editing a deployment
     * file and restarting is not.
     */
    get devDangerousCommands(): boolean {
        return optional("DEV_DANGEROUS_COMMANDS", "").trim().toLowerCase() === "true";
    },

    get bootstrapAdminIds(): string[] {
        return optional("BOOTSTRAP_ADMIN_IDS", "")
            .split(/[\s,]+/)
            .map((id) => id.trim())
            .filter((id) => /^\d{15,25}$/.test(id));
    }
};

/** Called once at startup so a misconfigured deployment fails immediately. */
export function assertEnvironment(): void {
    const missing = [
        "DISCORD_TOKEN",
        "DISCORD_APPLICATION_ID",
        "PUBLIC_GUILD_ID",
        "STAFF_GUILD_ID"
    ].filter((key) => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // A malformed port parsed to NaN and `listen(NaN)` binds an arbitrary free
    // port, so the API came up somewhere nobody could guess and the operator
    // read "listening" in the log. Fail here instead: startup validation is
    // where a misconfigured deployment is supposed to stop.
    const port = env.apiPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
            `API_PORT must be a whole number from 1 to 65535, not ${JSON.stringify(
                process.env.API_PORT
            )}`
        );
    }

    // The two guilds are different servers by definition. Pointing both at one
    // makes every "is this the staff server" check answer yes, which quietly
    // publishes shift figures, warnings and leave into the community server.
    if (process.env.PUBLIC_GUILD_ID === process.env.STAFF_GUILD_ID) {
        throw new Error(
            "PUBLIC_GUILD_ID and STAFF_GUILD_ID are the same. They are two different servers; " +
                "with one id every staff-only surface answers in the community server."
        );
    }
}
