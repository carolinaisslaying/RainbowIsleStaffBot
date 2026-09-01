# Rainbow Isle staff bot: implementation specification

Version 1.0. Handoff document for the implementing agent.

This bot replaces the previous staff bot. It manages moderator shifts, tracks participation in minutes, displays that participation as Apple Watch style activity rings, and assesses compliance against a fortnightly minimum. It is scoped to the Moderation Department only.

Build this exactly as specified. Where the spec says "configurable", it means a key in the guild configuration document with the stated default, not a hardcoded constant.

## 1. Stack and runtime

- Node 26, ES modules, `"type": "module"`.
- TypeScript, strict mode, `NodeNext` module resolution.
- discord.js 14.27.0 or later.
- MongoDB via the official `mongodb` driver. Do not add Mongoose.
- `@resvg/resvg-js` for rasterising SVG to PNG.
- Dev only: `typescript`, `vitest`.

No other runtime dependencies without asking. No date library, no scheduling library, no ORM, no image library beyond resvg.

Code style: 4 space indentation, double quotes, NZ English in all user-facing strings and comments.

### Intents

`Guilds`, `GuildMembers`, `GuildMessages`, `GuildPresences`.

Do not request `MessageContent`. The bot never reads message text. `messageCreate` fires with author, channel and timestamp without it, which is all the minute accounting needs. This is a deliberate privacy decision, not an oversight.

### Guild topology

The bot runs in two guilds:

- `publicGuildId`: the 110,000 member community server. Roles live here, tracked channels live here, message events are counted here.
- `staffGuildId`: the staff server. Review cards, leave approvals, Executive reports and the assessment feed post here.

All role resolution and permission checks run against the public guild. Command registration is guild-scoped so Executive commands never appear in the public server.

The bot's highest role must sit above every role it manages in the public guild hierarchy. Check this at startup and log a fatal error if it does not hold.

## 2. Time model

### Canonical accounting time is UTC

Weeks run Monday 00:00:00 UTC to Sunday 23:59:59 UTC. Fortnights pair consecutive weeks from the anchor. Every stored aggregate, leaderboard, ring, assessment and warning binds to this, identically for every member.

- `weekStartDay`: 1 (Monday), configurable.
- `accountingTimezone`: `"UTC"`, configurable to any IANA identifier.
- `fortnightAnchor`: `"2026-09-28T00:00:00Z"`, configurable. Fortnight index is `floor((weekStart - anchor) / 14 days)`.

Compute week and fortnight boundaries with `Intl.DateTimeFormat` parts against `accountingTimezone`. Do not assume UTC arithmetic in the boundary code even though UTC is the default, because someone will change that key later. Unit tests must cover a DST transition in a non-UTC accounting timezone in both directions.

### Member timezones are display only

Every staff member holds an IANA timezone identifier, validated against `Intl.supportedValuesOf("timeZone")`. Reject fixed offsets like `UTC+13`.

Timezone affects three things and nothing else:

1. Which timezone a heatmap or report renders in by default.
2. The local equivalent appended when the bot states a window in prose, for example "the week closes Monday 00:00 UTC, which is 1:00 PM Monday your time".
3. Delivery timing of the weekly recap DM, held until the recipient's local 09:00.

It never affects totals, ring state, leaderboard position, or assessment outcome.

### Onboarding gate

Any command from a member holding the Moderation Department role who has no timezone set returns a setup card and refuses the original action. The card explains why and offers the command.

`/timezone set zone:<autocomplete>` autocompletes over the IANA list filtered by substring. On selection, reply with a confirmation card showing the current time as `<t:unix:F>` and their selected zone name, with buttons to confirm or reselect. If the rendered time does not match their clock, they picked wrong, and they will see that immediately.

`/timezone view [user]` shows a member's zone and current local time. Self always permitted; other members require Lead or Executive.

### Rendering instants

Every instant the bot prints uses Discord timestamp markup: `<t:unix:t>`, `<t:unix:F>`, `<t:unix:R>` as appropriate. No hand-formatted absolute dates anywhere in user-facing output. Add an ESLint rule or a code review note enforcing this.

Durations, window labels and axis labels have no Discord primitive and are formatted manually. Format those in the viewer's timezone.

## 3. Data model

Database `staffbot`. Standalone MongoDB, no replica set required. Every write must be an atomic single-document operation. Do not use transactions.

All collections key on `staffId` (ObjectId), never on Discord ID. That is what makes account migration a one-field update.

### `staff`

```
{
    _id: ObjectId,
    discordId: string,              // current account, indexed unique
    previousDiscordIds: string[],   // appended on relink
    timezone: string | null,        // IANA, null until set
    timezoneSetAt: Date | null,
    joinedTeamAt: Date,
    active: boolean,                // false when they leave the team; record retained
    leaderboardOptOut: boolean,     // default false
    createdAt: Date,
    updatedAt: Date
}
```

### `activityDays`

One document per staff member per UTC day. This is the raw store.

```
{
    _id: ObjectId,
    staffId: ObjectId,
    date: string,                   // "2026-09-28", UTC day
    minutes: Binary,                // 180 byte buffer, 1440 bits, bit N = minute N of the UTC day
    count: number                   // popcount cache, maintained on write
}
```

Unique compound index on `{ staffId: 1, date: 1 }`.

Crediting a minute is a single upsert using `$bit` with an `or` mask on the relevant byte, plus `$inc` on `count` only when the bit was previously unset. Read the document first to determine that, or maintain `count` in a nightly recompute job and treat it as advisory. Prefer the nightly recompute: it keeps the hot path to one write with no read.

Storage cost: 180 bytes per staff member per active day. A year of daily activity for 40 moderators is under 3 MB. Nothing is ever deleted.

### `shifts`

```
{
    _id: ObjectId,
    staffId: ObjectId,
    startedAt: Date,
    endedAt: Date | null,
    endReason: "manual" | "max_duration" | "auto_ended_away" | "leave_started" | "reconciled" | null,
    pauses: [{ from: Date, to: Date | null, cause: "presence" | "inactivity" }],
    availableMs: number,            // computed on close: total minus paused
    activityMinutes: number         // computed on close, minutes credited during this shift
}
```

Index `{ staffId: 1, startedAt: -1 }` and a partial index on `{ endedAt: null }` for open shifts.

### `weeklyStats`

Materialised rollup. Never the source of truth; recomputable from `activityDays` and `shifts` at any time.

```
{
    _id: ObjectId,
    staffId: ObjectId,
    weekStart: Date,                // canonical UTC week start
    activityMinutes: number,
    shiftMs: number,
    activeDays: number,
    onLeave: boolean,               // true if any part of the week was covered by approved leave
    ringState: "green" | "amber" | "red" | "leave"
}
```

Unique index `{ staffId: 1, weekStart: 1 }`.

Rebuild the closing week at Monday 00:05 UTC, and support a manual `/admin recompute` that rebuilds any range from raw data.

### `fortnightAssessments`

```
{
    _id: ObjectId,
    staffId: ObjectId,
    fortnightIndex: number,
    windowStart: Date,
    windowEnd: Date,
    week1Minutes: number,
    week2Minutes: number,
    totalMinutes: number,
    requiredMinutes: number,        // snapshot of config at assessment time
    status: "met" | "below" | "exempt",
    reviewedBy: ObjectId | null,
    reviewOutcome: "warned" | "excused" | "dismissed" | null,
    reviewedAt: Date | null,
    reviewNote: string | null
}
```

Snapshot `requiredMinutes` rather than reading current config when displaying a historical assessment. Changing the target must not retroactively rewrite past outcomes.

### `warnings`

```
{
    _id: ObjectId,
    staffId: ObjectId,
    assessmentId: ObjectId,
    issuedBy: ObjectId,
    issuedAt: Date,
    note: string,
    acknowledgedAt: Date | null
}
```

### `leave`

```
{
    _id: ObjectId,
    staffId: ObjectId,
    requestedAt: Date,
    startDate: Date,
    endDate: Date | null,           // null = open-ended
    reason: string,
    status: "pending" | "approved" | "declined" | "active" | "ended",
    decidedBy: ObjectId | null,
    decidedAt: Date | null,
    removedRoles: string[],         // snapshot of role IDs removed on activation
    rolesRestoredAt: Date | null,
    restoreErrors: string[]         // role IDs that no longer exist on return
}
```

### `demandBuckets`

Server load, for the heatmap. No identity attached.

```
{
    _id: ObjectId,
    channelId: string,
    hourStart: Date,                // UTC hour
    messages: number
}
```

Unique index `{ channelId: 1, hourStart: 1 }`. Increment with `$inc` on every message in a tracked channel from any member, staff or not. No user IDs, no content.

### `guildConfig`

Single document. See section 11 for the full key list.

### `auditLog`

Every role change, leave decision, warning, config change, relink and manual recompute. `{ actorId, action, targetStaffId, detail, at }`.

## 4. Minute accounting

A staff member earns one activity minute for a given UTC clock minute if, during that minute, all of the following held:

1. They had an open shift.
2. The shift was in the Available state, not paused.
3. They sent at least one message in a channel on the `trackedChannels` whitelist in the public guild.

Multiple messages in the same minute earn nothing extra. This is the levelling-bot cooldown bucket with the bucket boundary on the wall clock, which makes crediting idempotent: setting an already-set bit is a no-op.

`trackedChannels` is an explicit array of channel IDs in the public guild. Nothing in the staff guild ever counts. Threads count if their parent channel is whitelisted.

Shift minutes and activity minutes are different numbers and must never be conflated in code or in output. Shift minutes measure clocked availability. Activity minutes measure participation. The compliance target is activity minutes.

## 5. Shift lifecycle

Three states: Available, Away, Ended.

### Starting

`/shift start` adds `availabilityRole`, opens a `shifts` document, sets state Available, replies with a Components V2 card showing current ring state and the week's progress.

Refuse if the member already has an open shift, is on active leave, or has no timezone set.

### Away, entered automatically

The bot moves a shift to Away when either condition holds:

- The member's presence in the public guild goes `idle`, `dnd` is treated as available, or `offline`.
- No message from them in any public guild channel for `awayAfterMinutes` (default 20).

On entering Away: remove `availabilityRole`, append a `pauses` entry, stop crediting minutes, pause the shift clock. Send the member a DM stating they have been marked away and how to come back. Log nothing as a fault. Notify nobody else.

Discord's own idle status already reflects roughly ten minutes of client-side inactivity, so presence does most of this work for free.

### Returning, automatic

Restore Available the moment the member sends a message in a public guild channel or their presence returns to `online`. Re-add `availabilityRole`, close the open `pauses` entry, resume crediting. One short DM confirming the role is back.

No confirmation is required from the member. No word to repeat, no deadline, no failure state. The old DM activity check is deliberately not reimplemented.

### Ending

- `/shift end`, reason `manual`.
- Continuously Away for `autoEndAfterAwayMinutes` (default 30), reason `auto_ended_away`.
- Shift open longer than `maxShiftHours` (default 12), reason `max_duration`.
- Leave activation, reason `leave_started`.

On close, compute `availableMs` and `activityMinutes`, remove the role, and reply or DM with a shift summary card: duration, paused time, minutes earned, updated ring.

### Reconciliation on boot

Mandatory. On every startup:

1. Fetch all members in the public guild holding `availabilityRole`. Any without an open shift: remove the role and log.
2. Fetch all open shift documents. Any whose member no longer holds the role, or who has left the guild: close with reason `reconciled`.
3. Any open shift older than `maxShiftHours`: close with reason `max_duration`.
4. Recompute `weeklyStats` for any completed week missing a rollup.

## 6. Leave

`/leave request start:<date> end:<date?> reason:<text>` creates a pending record and posts an approval card to the staff guild review channel with approve and decline buttons. Executive only may decide.

On approval, at the start date (or immediately if the start date has passed):

1. Read the member's current roles in the public guild.
2. Remove `moderationDepartmentRole` and every role in `staffRankRoles` that they hold. Snapshot exactly what was removed into `removedRoles`.
3. Add `onLeaveRole`.
4. Close any open shift with reason `leave_started`.
5. Set status `active`.

On return, either at the end date or via `/leave end`:

1. Restore exactly the roles in `removedRoles`. Skip any that no longer exist and record them in `restoreErrors`.
2. Remove `onLeaveRole`.
3. Set status `ended`, stamp `rolesRestoredAt`.
4. If `restoreErrors` is non-empty, post to the review channel naming the member and the missing roles.

`/leave extend` pushes the end date. `/leave list` shows current and upcoming leave, Lead and Executive only.

Effects while on leave:

- No fortnight assessment. Assessment status is `exempt`.
- Weekly rings render in a neutral grey "on leave" state, never red.
- Streaks freeze. The counter is untouched, and leave weeks are skipped when computing consecutive weeks, so a four week streak into three weeks of leave resumes at four.
- Hidden from the public leaderboard, still visible in Lead and Executive views.

## 7. Rings

Three concentric rings in the Apple Watch arrangement, authored as SVG in code and rasterised with resvg at 2x, attached to Components V2 messages as a `MediaGallery` item or a `Section` thumbnail.

- Outer: activity minutes this week against `weeklyTargetMinutes` (default 120). The only ring with compliance meaning.
- Middle: shift hours this week against `weeklyShiftTargetHours` (default 4). Soft.
- Inner: active days this week against `weeklyActiveDaysTarget` (default 3). Soft.

The two soft rings can be disabled by config, in which case render the outer alone at the same overall diameter.

### Colour and state

- Green at or above 100 percent of the outer target.
- Amber from `amberThresholdPercent` (default 75) to 99.
- Red below that.
- Grey for on leave.

Thresholds configurable. Colour never carries meaning alone: every card that shows a ring also states the numbers in text, for example "104 / 120 minutes, on track". Around one in twelve people cannot reliably separate your amber from your green.

Overachievement wraps past 360 degrees with a lighter overlay arc, matching the Watch behaviour. Cap the visible overlay at one extra revolution.

### Rendering

Pure function: `renderRings(state) -> Buffer`. No Discord types inside it. Cache the PNG in memory keyed by `staffId`, `weekStart` and the three numerator values, so refreshing a 40 row leaderboard does not rasterise 40 images.

## 8. Compliance

Weekly figures are display only and trigger nothing.

The enforcement unit is a fortnight. At Monday 00:05 UTC, when the closing week completes a fortnight, assess every active staff member:

- `totalMinutes` = week 1 plus week 2.
- Met if `totalMinutes >= fortnightRequiredMinutes` (default 240, configurable).
- Exempt if any part of the fortnight was covered by approved leave.

A member may record 0 minutes in week 1 and 240 in week 2 and pass. That is intended.

The bot never issues a warning by itself. It posts one Components V2 review card to the staff guild listing every member below threshold, each row showing the two weekly figures, the total, the shortfall, and their previous assessment outcomes. Buttons per row: issue warning, excuse, dismiss. Executive only. Every decision writes to `fortnightAssessments` and `auditLog`, and issuing a warning also writes a `warnings` document and DMs the member.

## 9. Leaderboard, recaps and progression

- `/leaderboard [week|fortnight|alltime] [page]`. Ring first, ordered by activity minutes, the viewer's own row pinned at the bottom regardless of position. Members with `leaderboardOptOut` are hidden from public listings but still counted in Lead and Executive views. Opt-out is a display preference only; tracking and assessment remain mandatory.
- `/rings [user]` renders the current week's card. Self always permitted, others per section 10.
- Ring closure DM fires the moment the outer ring reaches 100 percent, showing the card and the current streak.
- Weekly recap DM, held until the recipient's local 09:00 Monday: their rings, rank movement, streak, and the team's collective minutes for the week.
- Fortnight close card, sent after assessment, showing the outcome.
- Milestones: first ring closed, 4 week streak, 12 week streak. Keep this list short and do not add more without asking.

## 10. Permissions

Three tiers, resolved against roles in the public guild. All three role lists configurable.

Any staff member: own rings, own shift commands, own data export, leaderboard, own timezone, own leave requests.

Lead Moderator, additionally: current week and fortnight totals for all Moderation staff, shift history for all Moderation staff, leave list. Not historical fortnight assessments, not warnings, not leave reasons.

Executive, additionally: everything. Assessments, warnings, leave decisions, coverage heatmap, configuration, relink, recompute.

Use `setDefaultMemberPermissions` as a first filter, then check roles explicitly in the handler. Never rely on the Discord permission gate alone.

## 11. Configuration

Single `guildConfig` document, edited through `/config set key:<autocomplete> value:<string>`, Executive only, every change audited. `/config view` renders the current document.

```
publicGuildId, staffGuildId
availabilityRole, moderationDepartmentRole, onLeaveRole
staffRankRoles[]                      // individual ranks, removed on leave
leadRoles[], executiveRoles[]
trackedChannels[]                     // whitelist, public guild only
leaveChannelId, reportChannelId       // staff guild
recapChannelId                        // staff guild
accountingTimezone       = "UTC"
weekStartDay             = 1
fortnightAnchor          = "2026-09-28T00:00:00Z"
weeklyTargetMinutes      = 120
fortnightRequiredMinutes = 240
weeklyShiftTargetHours   = 4
weeklyActiveDaysTarget   = 3
amberThresholdPercent    = 75
softRingsEnabled         = true
awayAfterMinutes         = 20
autoEndAfterAwayMinutes  = 30
maxShiftHours            = 12
heatmapLookbackWeeks     = 8
```

## 12. Coverage heatmap

`/coverage heatmap [tz:<zone>] [weeks:<n>]`, Executive only. A 7 by 24 grid rendered as SVG and rasterised through the same pipeline as the rings. Defaults to the requester's timezone, falling back to UTC. Lookback defaults to `heatmapLookbackWeeks`.

Two layers:

- Coverage: mean number of staff in the Available state during each hour bucket, derived from `shifts` and their pause windows.
- Demand: mean messages per hour in tracked channels, from `demandBuckets`.

Cell colour plots demand divided by coverage, not either alone. A quiet hour with one moderator is fine. A peak hour with one moderator is the gap. Render both raw numbers in the cell tooltip equivalent, which for a static image means a legend plus a companion text block listing the five worst buckets.

Because the raw store is UTC bitmaps and UTC shift records, re-bucketing into any timezone is a display transform with no loss.

`/coverage gaps [tz:<zone>]` ranks the worst demand-to-coverage hours and, for each, lists IANA zones whose local 18:00 to 23:00 falls inside that window. That turns a coverage gap into a recruitment brief.

## 13. Account changes, exports and deletion

`/staff relink old:<user> new:<user>`, Executive only. Sets `discordId` on the staff document to the new account, appends the old ID to `previousDiscordIds`, re-applies current roles to the new account, and audits. All history follows, because nothing keys on Discord ID.

`/mydata export`, any staff member, self only, ephemeral. Returns a JSON file via `FileBuilder` containing everything held on the requester: profile, timezone, every shift with pauses, per-day minute totals, weekly and fortnightly aggregates, assessments, warnings, leave records. Build this in phase one. It answers the Privacy Act 2020 IPP 6 access question without anyone having to think about it.

No command deletes anything. Ship `DELETION.md` in the repository root with `mongosh` commands for a full or partial purge of one staff member, in dependency order so rollups do not resurrect deleted rows: `warnings`, `fortnightAssessments`, `leave`, `weeklyStats`, `shifts`, `activityDays`, then `staff`. Include a note that `demandBuckets` holds no personal data and is never in scope.

## 14. Components V2 conventions

Every message sets `MessageFlags.IsComponentsV2`. With that flag, `content`, `embeds`, `poll` and `stickers` are unavailable, and a message is capped at 40 components.

Build one shared render module. Command handlers call render functions and never construct builders inline. Standard shapes:

- Status card: `Container` with accent colour matching ring state, a `Section` pairing a text block with the ring PNG as thumbnail, a `Separator`, then a text block of figures.
- Review card: `Container` per member, `ActionRow` of decision buttons, custom IDs routed as `review:<assessmentId>:<action>`.
- Leaderboard: one `Container`, `TextDisplay` rows, `ActionRow` for pagination. Watch the 40 component ceiling and page at 10 rows.

Attach images as `attachment://name.png` referencing an `AttachmentBuilder`.

## 15. Internal HTTP API

StaffLearn runs Postgres and Drizzle, so it will never share this database. Ship a small `node:http` server bound to the compose network only, bearer token from env, three endpoints:

- `GET /api/staff/:discordId/summary`
- `GET /api/assessments?from=&to=`
- `POST /api/webhooks/test`

Shape them around read models, not collections. The later platform merge then happens at the API contract rather than as a schema migration.

## 16. Deployment

`node:26-bookworm-slim`, not Alpine. resvg's musl builds are the flakier path and the image size difference does not matter for a single bot.

Multi-stage Dockerfile: build stage compiles TypeScript, runtime stage copies `dist` and production `node_modules`, runs as a non-root user.

`docker-compose.yml` with two services, `bot` and `mongo` (`mongo:8`), a named volume for data, healthchecks on both, `restart: unless-stopped`, and an internal network with no published Mongo port. Secrets via `.env`, with `.env.example` committed.

Scheduling is internal: one `setTimeout` loop that computes the next boundary against `accountingTimezone` and reschedules after firing. Do not add a cron dependency. Every scheduled job must be idempotent and must reconcile missed runs on boot, since the container will restart.

## 17. Testing

Vitest. Required coverage:

- Week and fortnight boundary maths, including a DST transition in both directions in a non-UTC accounting timezone.
- Fortnight index derivation from the anchor.
- Bitmap set, popcount, and cross-day window summation.
- Idempotency: crediting the same minute twice changes nothing.
- Shift state machine: every transition, including pause spanning a UTC day boundary.
- Leave role snapshot and restore, including a role deleted while the member was away.
- Ring state thresholds at the boundaries, 74, 75, 99, 100, and over 100.
- Reconciliation against a seeded database with orphaned roles and orphaned shifts.

## 18. Build order

1. Config, database, staff registration, timezone gate, reconciliation skeleton.
2. Shift lifecycle with Available and Away detection, role management.
3. Minute accounting and `activityDays`.
4. Ring rendering and `/rings`.
5. Weekly rollups, leaderboard, recaps, streaks.
6. Fortnight assessment, review card, warnings.
7. Leave.
8. Demand counters, coverage heatmap, gaps.
9. Data export, relink, `DELETION.md`.
10. Internal HTTP API.

Phases 1 to 4 are a usable bot. Do not start phase 5 until the reconciliation tests pass.
