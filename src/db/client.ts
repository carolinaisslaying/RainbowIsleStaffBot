import { MongoClient, type Db, type Collection } from "mongodb";
import { env } from "../config/env.js";
import { log } from "../log.js";
import type {
    ActivityDayDoc,
    AuditLogDoc,
    DeliveryDoc,
    DemandBucketDoc,
    FortnightAssessmentDoc,
    FortnightReviewDoc,
    GuildConfigDoc,
    LeaveDoc,
    ShiftDoc,
    StaffDoc,
    WarningDoc,
    WeeklyStatsDoc
} from "./types.js";

let client: MongoClient | null = null;
let database: Db | null = null;

export async function connectDatabase(): Promise<Db> {
    if (database) return database;
    client = new MongoClient(env.mongoUrl, {
        // Standalone MongoDB, no replica set. Every write is a single atomic
        // document operation, so there are no transactions to worry about.
        retryWrites: false,
        ignoreUndefined: true
    });
    await client.connect();
    database = client.db(env.mongoDb);
    await ensureIndexes(database);
    log.info(`Connected to MongoDB database ${env.mongoDb}`);
    return database;
}

export function db(): Db {
    if (!database) throw new Error("Database not connected. Call connectDatabase() first.");
    return database;
}

export async function closeDatabase(): Promise<void> {
    await client?.close();
    client = null;
    database = null;
}

export const collections = {
    staff: () => db().collection<StaffDoc>("staff"),
    activityDays: () => db().collection<ActivityDayDoc>("activityDays"),
    shifts: () => db().collection<ShiftDoc>("shifts"),
    weeklyStats: () => db().collection<WeeklyStatsDoc>("weeklyStats"),
    fortnightAssessments: () =>
        db().collection<FortnightAssessmentDoc>("fortnightAssessments"),
    warnings: () => db().collection<WarningDoc>("warnings"),
    leave: () => db().collection<LeaveDoc>("leave"),
    demandBuckets: () => db().collection<DemandBucketDoc>("demandBuckets"),
    guildConfig: () => db().collection<GuildConfigDoc>("guildConfig"),
    auditLog: () => db().collection<AuditLogDoc>("auditLog"),
    deliveries: () => db().collection<DeliveryDoc>("deliveries"),
    fortnightReviews: () => db().collection<FortnightReviewDoc>("fortnightReviews")
};

async function ensureIndexes(target: Db): Promise<void> {
    const staff = target.collection<StaffDoc>("staff");
    await staff.createIndex({ discordId: 1 }, { unique: true });
    await staff.createIndex({ active: 1 });

    const activityDays = target.collection<ActivityDayDoc>("activityDays");
    await activityDays.createIndex({ staffId: 1, date: 1 }, { unique: true });
    await activityDays.createIndex({ date: 1 });

    const shifts = target.collection<ShiftDoc>("shifts");
    await shifts.createIndex({ staffId: 1, startedAt: -1 });
    await shifts.createIndex(
        { endedAt: 1 },
        { partialFilterExpression: { endedAt: null } }
    );
    await shifts.createIndex({ startedAt: 1 });

    const weeklyStats = target.collection<WeeklyStatsDoc>("weeklyStats");
    await weeklyStats.createIndex({ staffId: 1, weekStart: 1 }, { unique: true });
    await weeklyStats.createIndex({ weekStart: 1 });

    const assessments = target.collection<FortnightAssessmentDoc>("fortnightAssessments");
    await assessments.createIndex(
        { staffId: 1, fortnightIndex: 1 },
        { unique: true }
    );
    await assessments.createIndex({ fortnightIndex: 1 });
    await assessments.createIndex({ windowStart: 1 });

    const warnings = target.collection<WarningDoc>("warnings");
    await warnings.createIndex({ staffId: 1, issuedAt: -1 });

    const leave = target.collection<LeaveDoc>("leave");
    await leave.createIndex({ staffId: 1, startDate: -1 });
    await leave.createIndex({ status: 1, startDate: 1 });

    const demand = target.collection<DemandBucketDoc>("demandBuckets");
    await demand.createIndex({ channelId: 1, hourStart: 1 }, { unique: true });
    await demand.createIndex({ hourStart: 1 });

    const deliveries = target.collection<DeliveryDoc>("deliveries");
    await deliveries.createIndex({ at: -1 });

    // Keyed by the fortnight index itself, so no unique index is needed: the
    // _id is the key, and posting a queue twice upserts rather than duplicates.
    const reviews = target.collection<FortnightReviewDoc>("fortnightReviews");
    await reviews.createIndex({ postedAt: -1 });

    const audit = target.collection<AuditLogDoc>("auditLog");
    await audit.createIndex({ at: -1 });
    await audit.createIndex({ targetStaffId: 1, at: -1 });
}
