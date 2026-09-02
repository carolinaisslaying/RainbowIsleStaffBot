# Rainbow Isle staff bot

Moderator shift tracking, participation measured in minutes, Apple Watch style
activity rings, and fortnightly compliance assessment. Scoped to the Moderation
Department only.

Built to `rainbow-isle-staff-bot-spec.md` v1.0.

## The two servers

| Name | Config key | What lives there |
| --- | --- | --- |
| **Rainbow Isle** | `publicGuildId` | Roles, tracked channels, message events. All role resolution and permission checks run here. |
| **Rainbow Isle: Offices** | `staffGuildId` | Review cards, leave approvals, Executive reports, the assessment feed. |

The config keys keep the `public`/`staff` names the spec defines, since renaming
them would be a schema change for no functional gain. In anything a user reads,
each server is called by its **actual name, fetched from Discord at startup**,
so a rename is picked up on the next restart with no edit here. `Rainbow Isle`
and `Rainbow Isle: Offices` are the fallbacks used only if a name cannot be
fetched.

## Setting up

Configuration lives in two places, and only the first is a file.

**1. `.env`, the deployment wiring.** Token, application ID, the two guild IDs,
the Mongo URL, the API token. Copy `.env.example` and fill it in.

**2. The `guildConfig` document, everything else.** Roles, tracked channels,
review and recap channels, targets, thresholds and timings. There is no config
file for these: they are edited at runtime with `/config set`, Executive only,
and every change is audited. `/config view` prints the current document.

The reason for the split is that roles and channels change during the life of a
server, and rewriting a `.env` and restarting the bot to move a threshold is a
worse experience than a slash command.

### First run

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `PUBLIC_GUILD_ID`,
`STAFF_GUILD_ID`, `API_BEARER_TOKEN`, and, for the first setup only,
**`BOOTSTRAP_ADMIN_IDS` with your own Discord user ID**.

That last one matters. Executive tier is resolved from the `executiveRoles`
config key, which is empty on a fresh install, so with no escape hatch nobody
could run the `/config set` that populates it. `BOOTSTRAP_ADMIN_IDS` grants
Executive independently of the database, which also means it still works if
someone later deletes the Executive role and locks the team out. Keep it to one
or two people; every use of it is logged with a warning.

```bash
docker compose up -d --build
```

On first run the bot writes a `guildConfig` document seeded with the spec
defaults plus the two guild IDs from the environment. Everything else is unset.

### Reaching Mongo from your own machine, in development

The base compose file gives Mongo no `ports` section on purpose. In production
the database is reachable only from inside the compose network, which is the
right posture for a store holding activity minutes, warnings and leave reasons.

`docker-compose.dev.yml` is an overlay that publishes it to **localhost only**,
for pointing Compass, `mongosh` or an MCP server at a running stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
# then: mongodb://localhost:27017/staffbot
```

The published address is pinned to `127.0.0.1`. Compose reads a bare
`"27017:27017"` as `0.0.0.0`, which would put an unauthenticated database on
every interface the machine has, including whatever wifi it is on. That
distinction is the entire security model here, so do not shorten it.

Deploying names the base file alone, and stays closed:

```bash
docker compose up -d
```

`docker-compose.yml.backup` is a copy of the base file as it stood before the
overlay was added.

### Inviting the bot

The invite URL must carry **both** the `bot` and `applications.commands`
scopes. With `bot` alone the bot logs in normally and looks healthy, but every
slash command registration returns 403 and nothing appears in either server:

```
https://discord.com/api/oauth2/authorize
  ?client_id=<DISCORD_APPLICATION_ID>
  &permissions=268435456
  &scope=bot%20applications.commands
```

`268435456` is Manage Roles. Invite it to both guilds.

### Then, in Rainbow Isle: Offices

`/config` is registered in Rainbow Isle: Offices only, so Executive commands never
appear in Rainbow Isle.

Start with `/config view`. It shows a progress bar of how many essentials are
set, names what is still missing and what breaks while it stays missing, and
colours each key: 🟢 set, 🔴 required, 🟡 worth setting, ⚪ running on a default.

Then fill the gaps. The `key` option lists unset essentials first, and the
`value` option autocompletes by name against the right server, so you pick
`@Moderator` from a list rather than turning on Developer Mode to copy IDs:

```
/config set key:moderationDepartmentRole value:@Moderator
/config set key:availabilityRole         value:@Available
/config set key:leaveChannelId           value:#leave-requests
/config set key:reportChannelId          value:#fortnight-reports
```

List settings take one entry at a time, so you never retype a whole list to
change one item:

```
/config add    key:trackedChannels value:#general
/config add    key:trackedChannels value:#help
/config remove key:trackedChannels value:#help
/config add    key:executiveRoles  value:@Executive
```

`/config remove` offers only what the list currently holds. `/config reset`
returns a key to its shipped default.

Role and channel pickers cannot help here: Discord only ever lists the guild the
command was typed in, and the roles live in the other server. Autocomplete
crosses that gap by fetching from whichever server the key refers to.

### What must be set before the bot is useful

| Key | Without it |
| --- | --- |
| `moderationDepartmentRole` | Nobody resolves as staff; every command is refused |
| `executiveRoles` | No one can configure, decide leave, or review assessments |
| `availabilityRole` | Shifts open, but nothing shows who is available |
| `trackedChannels` | **No activity minutes are ever credited** |
| `leaveChannelId` | Leave requests have nowhere to post and nobody can approve one |
| `reportChannelId` | Fortnight report cards have nowhere to post |
| `leadRoles` | Lead tier is unreachable; only staff and Executive exist |
| `onLeaveRole` | Leave activates but the member is not visibly on leave |
| `staffRankRoles` | Leave removes the department role only, not ranks |
| `recapChannelId` | Recaps still DM; only the channel copy is missing |
| `warningChannelId` | Warnings still issue; there is just no durable log of them |

Everything else has a working default from the spec: targets, thresholds,
timings, `accountingTimezone`, `weekStartDay` and `fortnightAnchor`. All can be
left alone until you want to change policy.

`trackedChannels` deserves particular attention: it is the whitelist that
decides what counts as participation, it is Rainbow Isle only, and threads count
when their parent channel is on it. An empty whitelist means a member can work a
full shift and earn nothing.

### Where each command appears

| Surface | What is registered |
| --- | --- |
| Rainbow Isle: Offices | Every command, guild scoped, each behind the permission gate its tier maps to |
| A DM with the bot | Staff tier commands only, via a global registration limited to `contexts: [BotDM]` |
| Rainbow Isle | `/config` alone, hidden behind a permission gate of zero. Everything else is cleared on every boot. |

A command's `tier` decides its gate as well as its check. In the staff server,
Executive commands carry Manage Guild and Lead commands carry Moderate Members,
so a Moderator's picker does not list `/config`, `/admin` or `/coverage` at all.

A DM has no permission gate to carry, and Discord offers a global command to
everyone who can DM the bot: there is no per-user or per-role filter available
there. So the DM surface carries the Staff tier alone. Lead and Executive work
happens in the staff server, where the gate is real, or through the recovery
hatch below.

Moderators run `/shift start` and `/rings` either in the staff server or in a
direct message with the bot. The community server never sees a command, and the
bot refuses one typed there even if an old registration lingers: a moderator's
shift figures, warnings and leave are not the business of a 110,000 member
server, ephemeral or not.

The DM registration is global, which would normally mean it appears everywhere.
`contexts: [BotDM]` is what stops that: Discord offers those commands in a DM
with the bot and hides them from every guild picker.

### The configuration recovery hatch

`/config` is also registered in Rainbow Isle, with `default_member_permissions`
of `0`. Discord hides a command gated that way from everyone without
Administrator, and the handler then admits only an ID listed in
`BOOTSTRAP_ADMIN_IDS`. Anyone else who can see it gets a refusal.

This exists so a deployment stays recoverable. If `staffGuildId` is wrong, or
the bot was never added to the staff server, every other surface is unreachable
and nothing could correct the setting that caused it. Each use logs a warning
naming the user, so it is visible rather than quiet.

The hatch covers configuration alone. `/shift`, `/rings`, `/leave` and the rest
stay out of the community server whoever is asking.

### Visibility versus permission

Each command carries the permission gate its tier maps to, which keeps it out
of the pickers of everyone below that tier in the staff server. That is a
filter, not the check.

Discord cannot gate a command's visibility on a role held in a **different**
guild, and every role this bot cares about lives in Rainbow Isle. So a member
of the staff server who is not Moderation staff may still see some commands in
their picker. Running one gets them a refusal: `interactionCreate` resolves the
caller's tier against Rainbow Isle roles on every invocation, and that is the
authority.

### If commands do not appear

Registration failures are logged with a specific hint. `docker compose logs bot
| grep -i "registered\|FAILED to register"` shows what happened.

1. **Nothing logged at all** - the bot never reached ready. Check the token.
2. **`FAILED to register ... 403`.** Missing the `applications.commands`
   scope. Re-invite with the URL above; adding the bot with `bot` alone is the
   usual cause.
3. **`FAILED to register ... 404`.** `DISCORD_APPLICATION_ID` does not match
   the token's application, or the bot is not in that guild. The application ID
   is on the General Information page and is not always the bot user ID.
4. **Registered, but you cannot see them.** You are probably looking in the
   wrong guild for that command (see the table above), or you lack Manage Guild
   in the staff guild for the Executive ones.
5. **Registered, visible, but refused.** That is the permission tier talking,
   not registration. See `BOOTSTRAP_ADMIN_IDS` above.

Guild commands appear immediately; there is no one hour propagation delay,
though the client sometimes needs a `Ctrl+R`.

## What counts

A staff member earns one activity minute for a UTC clock minute when all three
held during that minute: they had an open shift, the shift was Available rather
than paused, and they sent at least one message in a whitelisted Rainbow Isle channel.
Extra messages in the same minute earn nothing.

**Shift minutes and activity minutes are different numbers.** Shift minutes
measure clocked availability. Activity minutes measure participation. Only
activity minutes count toward compliance. The code and the user-facing strings
both keep these apart deliberately; do not let them merge.

## Privacy

- The `MessageContent` intent is **not** requested and must not be added.
  `messageCreate` still delivers author, channel and timestamp, which is all
  the accounting needs.
- `demandBuckets` records a channel, a UTC hour and a count. No user IDs, no
  content, nothing attributable to a person.
- `/mydata export` returns everything held about the requester as JSON. That
  answers an IPP 6 access request under the Privacy Act 2020 without anyone
  needing to think about it. It ships whole warning documents, so a member's own
  appeal text comes back with them.
- No command deletes anything. See `DELETION.md`.

## Warnings, and answering one

The bot never issues a warning by itself. It assesses, posts a review card per
member below the requirement, and waits for an Executive to decide and say why.

A warning arrives by DM with two buttons. **I have read this** records that they
saw it, which is the difference between a warning somebody has ignored and one
they never received — and the review row now says which, because the bot records
whether the DM actually arrived rather than assuming it did.

An Executive can also issue a warning for conduct rather than for a shortfall,
with `/admin warn`. Three rungs, differing by the gravity of what happened and
not by how formal they are — everything issued through this bot is a formal
written warning, and informal correction happens in a DM and never reaches the
record:

| Rung | Counts for |
| --- | --- |
| Caution | 90 days |
| Misconduct | 180 days |
| Serious Misconduct | never stops counting |

Each is a config key, and `0` means permanent. Every warning still weighs one:
the rung decides how long it counts, never how much, and the bot never adds them
up into an action.

Executives issue them; staff and Leads receive them. An Executive cannot be
warned through this bot at all, because a warning here is one person's decision
with no second signature and it would go on a peer's permanent record.

Every warning of either kind gets a card in `warningChannelId`, edited in place
for its whole life — issued, delivered, acknowledged, appealed, withdrawn. That
channel is the durable record; the fortnight review row is a decision queue,
organised by fortnight and purgeable.

**Nothing deletes a warning.** Withdrawing one — by reopening a review row, by
the button on its card, or by upholding an appeal — marks it withdrawn and keeps
it, carrying both reasons. It then counts against nobody. See `DELETION.md`.

**Appeal this** gives them one reply, within `appealWindowDays` (14 by default).
The window is counted from the moment the warning **reached** them, not from when
it was issued: a member whose DMs are closed never received it, and a deadline
running from issue could expire before they had any chance to contest it.

An appeal turns their review row amber and adds it to the header's count, so it
is visible where the Executives are already working rather than as a new message.
Upholding it is the existing **Reopen** button, which deletes the warning
outright. Leaving it standing asks for a reason, which the member is sent —
they asked a question, and silence would be its own answer.

## Time

Accounting is UTC by default and identical for everyone: weeks run Monday
00:00:00 to Sunday 23:59:59, fortnights pair consecutive weeks from the anchor.

Members set their zone with `/timezone set`, which searches on the timezone
code (`NZST`, `EDT`), a UTC offset (`+12`), a region (`Pacific`) or a place
name, and shows each candidate's current local time so they can pick the one
whose clock matches theirs. The abbreviation is a search and display aid only:
`CST` is Central, China and Cuba Standard Time, `IST` is India, Ireland and
Israel, and all of them flip with daylight saving, so only the IANA identifier
is ever stored.

Member timezones are display only. They affect which clock a report renders in,
the local equivalent quoted beside a window, and when the Monday recap DM
arrives. They never affect totals, ring state, leaderboard position or an
assessment outcome.

`accountingTimezone` is configurable to any IANA zone, and the boundary code
never assumes UTC even though UTC is the default. Weeks are 167 or 169 hours
long across a DST transition, and the tests cover that in both directions.

Every instant printed to a user uses Discord timestamp markup (`<t:unix:F>` and
friends), so it renders in the reader's own clock. The single exception is the
zone confirmation card, which must show a time as seen from somewhere other than
where the reader is sitting, and so has no markup available to it. **There are no hand-formatted
absolute dates in user-facing output.** Durations and axis labels have no
Discord primitive and are formatted manually in `src/time/format.ts`; that file
is the only place such formatting belongs. Anything else added to the codebase
that prints a date should be treated as a review defect.

## Layout

```
src/
  time/        week and fortnight boundaries, timezone validation, formatting
  domain/      pure logic: bitmaps, shift state machine, ring thresholds,
               rollups, assessments, leave, reconciliation planning
  render/      SVG rings and heatmap, plus the one shared Components V2 module
  services/    orchestration: the effects that go with a domain transition
  commands/    slash command handlers
  events/      gateway handlers and button routing
  jobs/        the internal scheduler and its jobs
  api/         internal HTTP read models
```

The domain layer holds no Discord types and the render functions are pure, which
is why most of it is testable without a gateway connection or a database.

Command handlers never construct builders inline. They call `render/cards.ts`,
which is where the 40 component ceiling and the Components V2 constraints are
enforced in one place.

## Scheduling

Internal `setTimeout` loops that compute the next boundary against
`accountingTimezone` and rearm after firing. No cron dependency.

Every job is idempotent and reconciles missed runs on boot, because the
container will restart:

| Job | Cadence | What it reconciles |
| --- | --- | --- |
| `shift-sweep` | every minute | Away, auto end, the shift ceiling |
| `leave-transitions` | every minute | Leave carries a time of day, so the return has to land on it. Date driven, so a missed run self-heals |
| `recaps` | hourly | Held until each recipient's local 09:00 |
| `week-close` | weekly, 00:05 | Rebuilds the closed week, assesses a completed fortnight |
| `count-recompute` | nightly | Rebuilds the advisory popcount cache |
| `review-reminders` | hourly | Chases a review queue nobody has worked |

Boot reconciliation runs before any of them: orphaned availability roles are
stripped, orphaned shifts closed, missing weekly rollups rebuilt, and every
surviving open shift given a fresh inactivity grace period so a redeploy does
not sweep the whole on-shift team Away.

`/dev status` shows all of this at runtime — each job's last and next run,
gateway latency, whether Mongo answers a ping, which required config keys are
unset, and whether the dangerous-command switch is on. It is limited to the
deployment's seeded administrators.

## Three deviations from the spec, and why

**1. `activityDays.minutes` is not written with `$bit`.** Section 3 asks for a
single upsert using `$bit` with an `or` mask. MongoDB's `$bit` operator applies
to integer fields only and cannot address bits inside a `BinData` value, so that
is not expressible in MQL against the document shape the same section mandates.
The shape is kept exactly as specified. Crediting instead uses an in-process
per-day lock and a hot bitmap cache, so the overwhelming majority of credits are
a cache hit on an already set bit costing zero writes, and a genuinely new minute
costs exactly one write. The lock makes the read-modify-write atomic with respect
to this process, which is the only writer. `count` is maintained on that write
and rebuilt nightly, staying advisory as the spec intends. See the comment at the
top of `src/domain/activity.ts`.

This assumes a single bot process. **If this is ever scaled to more than one
instance, the crediting path must change**, most plausibly by storing the day as
an array of integer chunks so `$bit` becomes usable.

**2. The zone confirmation card hand-formats one absolute time.** Section 2
asks for the confirmation to show `<t:unix:F>`, and also says a member who
picked the wrong zone will see the mismatch immediately. Those two cannot both
hold: Discord renders timestamp markup in the *reader's* timezone, so it shows
the member their own correct local time whichever zone they chose, and the card
could never catch a mistake. The card now shows the instant as seen from the
chosen zone, hand formatted, beside the `<t:unix:F>` line their own client
renders. Matching lines mean the pick is right. This is the same exemption the
spec already grants durations and axis labels: there is no Discord primitive for
"render this instant in that zone", so there is nothing to use.

**3. The ESLint rule for timestamp markup is a review note, not a rule.** Section
2 offers either. Adding ESLint would mean adding dev dependencies beyond the
`typescript` and `vitest` that section 1 permits, so it is documented above
instead. Say the word and I will add the linter.

## Tests

```bash
npm test
```

578 tests covering what section 17 requires: week and fortnight boundary maths
including DST in both directions in a non-UTC zone, fortnight index derivation
from the anchor, bitmap set/popcount/cross-day window summation, crediting
idempotency, the shift state machine including a pause spanning a UTC day
boundary, leave role snapshot and restore including a role deleted while the
member was away, ring thresholds at 74/75/99/100/over, and reconciliation
against a seeded fixture with orphans in both directions.

Beyond the spec's list: the appeal window at and either side of its boundary and
against a warning that was never delivered, the three delivery states a review
row can draw, the configuration sanity guards, and the API's paging arguments.

Reconciliation, leave restoration and boot repair are tested through pure
planning functions (`src/domain/reconcile.ts`) that take a seeded state and
return a plan. That keeps the interesting logic testable without standing up
Mongo or a live guild, which matters because `mongodb-memory-server` would be a
dependency the spec does not allow.

## Local development

Requires Node 26 to match the runtime image. `npm run build` compiles to
`dist/`, `npm run typecheck` checks without emitting, `npm test` runs vitest.
