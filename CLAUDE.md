# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- Node >= 26, TypeScript 5.9.3, ESM (`"type": "module"`, `module`/`moduleResolution: NodeNext`).
  Relative imports **must** carry the `.js` extension, including in `test/`.
- discord.js 14.27.0. Components V2 only (`MessageFlags.IsComponentsV2`). With that flag set,
  `content`, `embeds`, `poll` and `stickers` are unavailable on a message.
- mongodb 6.21.0 (driver, no ODM). MongoDB 8 in Docker.
- @resvg/resvg-js 2.6.2. SVG rasterised to PNG for rings and heatmaps.
- vitest 3.2.7. No linter or formatter is configured; `tsc` is the only static check.

## Commands

```bash
npm run typecheck              # tsc --noEmit
npm run build                  # tsc -> dist/
npm test                       # vitest run (all tests)
npm run test:watch
npm start                      # node dist/index.js (requires build + .env + reachable Mongo)
npm run dev                    # tsc --watch

npx vitest run test/rings.test.ts          # a single file
npx vitest run -t "ring state thresholds"  # a single test or describe block
```

Docker:

```bash
docker-compose up -d --build   # NOTE: the `docker compose` subcommand is not
                               # available on this machine; use the hyphenated binary
docker-compose logs -f bot
docker exec -it rainbowisle-staffbot-mongo-1 mongosh staffbot
```

`tsconfig.json` sets `rootDir: src` and excludes `test/`, so tests are type-checked by vitest only,
never by `npm run typecheck`.

## Layout and layering

```
src/
  index.ts        boot sequence (order matters, see below)
  commands/       slash command definitions + execute; index.ts registers them
  events/         interactionCreate (the router), plus button/modal handlers
  services/       orchestration that touches Discord AND the database
  domain/         pure-ish business rules over collections; no discord.js types
  render/         cards, modals, SVG -> PNG. Pure functions of their input
  time/           calendar maths, parsing, formatting, timezone search
  db/             client.ts (collections + index creation), types.ts (all doc shapes)
  config/         env.ts (process env), guildConfig.ts (the runtime config document)
  jobs/           scheduler and the four recurring jobs
  api/            internal HTTP server, never published outside the compose network
```

Dependencies flow `commands`/`events` → `services` → `domain` → `db`. `render/` and `time/` are
leaves and must not import from `services/` or `domain/`.

## Architecture

**Config is a database document, not constants.** `.env` supplies secrets and bootstraps
`guildConfig` on first run; from then on the `guildConfig` document is the source of truth and is
edited with `/config set`. Everything the spec calls configurable is a key on `StaffBotConfig`
(`src/config/guildConfig.ts`). Handlers call `loadConfig()` rather than closing over a config.

**Boot order in `src/index.ts` is deliberate.** Commands register *before* the role-hierarchy
check, because that check fails for reasons only fixable via `/config set`; a failure must not
leave the bot with no commands. `reconcileOnBoot` runs before any scheduler starts.

**Docker.** One `npm ci` for the whole build: the deps stage installs, the build stage compiles and
then `npm prune --omit=dev`, and the runtime stage copies that tree rather than resolving production
dependencies a second time. Every stage is the same base image on the same platform, which is what
makes copying `node_modules` (resvg's prebuilt native binary included) safe. The runtime installs
`fonts-inter`, `fonts-dejavu-core` and `curl` and **asserts the font paths with `test -d`**. That
assertion has already earned itself: it caught `fonts.ts` looking for Inter under `truetype/` when
Debian ships it under `opentype/`. No `fontconfig`: `FONT_OPTIONS` names its directories, so nothing ever
consults it. The healthcheck is curl, not `node -e`; the old one started a Node runtime every 30
seconds. Mongo's healthcheck runs `mongosh`, which is itself a Node program, so it polls every two
minutes with a `start_interval` keeping boot detection fast.

**`seededOnly` sits above the tier check.** `resolveTier` promotes a seeded admin (from
`BOOTSTRAP_ADMIN_IDS`) to Executive, so the tier lattice cannot say "Executive is not enough" and
`Command.seededOnly` does. It gates `/config` — configuration decides who counts as an Executive, so
an Executive who could change it could promote themselves — and all of `/dev`. **A deployment that
names no administrators falls back to the command's tier** (`seededGatePermits`), because locking
configuration to an empty list leaves the bot unconfigurable by anybody, including whoever is trying
to name the first administrator. Refusals never name the environment variable.

**`/dev` is rehearsals and cleanup; `/admin` is the real thing.** `/dev assess` is *always* a
rehearsal, so there is no flag to leave in the wrong position — a `rehearse:` option on the real
command is how a dry run once wrote real warnings. `/dev recap` previews either recap without
claiming a receipt. `/dev purge` deletes a fortnight's assessments, the warnings they issued **and
their cards in the review channel**, optionally rehearsing it again straight afterwards: a re-run
posted beside the last run's leftovers is read against them. It says on the confirmation how many of
the records came from a rehearsal and how many are real.

**Two guilds.** Roles live in the public guild; commands answer in the staff guild or in DMs.
`resolveTierAllowingLeave` in `interactionCreate.ts` re-grants Staff tier to members whose
department role was removed by active leave, or they could not run `/leave end`.

Consequently **permissions read the public guild and display names read the staff guild**, and the
two must not be confused. `fetchPublicMember` is for roles and tiers only. Every name the bot prints
goes through `staffDisplayName` (`src/discord/displayName.ts`), which prefers the staff guild's
nickname, falls back to the public guild's, then to a caller-supplied last resort. Never print
`member.displayName` from a member fetched for a permission check: that member came from the public
guild, and its name is the community nickname rather than the one the staff room uses. That was
the bug: one person appeared under two different names depending on which card they were on.

**The leaderboard is public unless somebody's copy is not.** `leaderboardVisibility`
(`domain/leaderboard.ts`) decides: a Lead or Executive sees hidden members flagged, and a hidden
member sees their own row, so either copy goes ephemeral. That only holds while somebody is
actually hidden; otherwise standings belong in the channel. The decision happens *before* the defer, because
ephemerality is fixed at defer time, which is why `countHiddenStaff` exists as a count rather than a
fetch. The card always states which way it went and why. Paging a card that is sitting in a channel
renders the everyone-view whoever presses it: the buttons edit that public message, so a Lead
pressing Next would otherwise publish every hidden row to the channel.

**Nothing user-facing names a file, a repository or an environment variable.** The cards are read by
Moderators. Operator detail belongs in `log.*`, which is where it now lives.

**Emoji come from the colour, not from the call site.** `render/emoji.ts` maps each `COLOUR` value
to one mark and `noticeCard` prefixes the title with it, so the forty-odd cards that already declare
their state by accent get the matching emoji for free and the two cannot drift. Two pairs of roles
share a value (green is `approved` and `onShift`, amber `pending` and `away`); the commoner meaning
wins the default and the shift cards pass `emoji:` themselves. One mark, leading the title, never in
body copy: these cards are read by Moderators deciding something.

**A card's claim and its own caveat live in one function.** `leaderboardVisibility` returns the whole
footnote. It used to return "Nobody is hidden from the leaderboard" without checking, while
`commands/leaderboard.ts` appended a count of the members it had just left out, so the card denied
and reported the same fact in consecutive sentences. Callers use `.note` as it comes.

**Config transfer.** `/config view` carries **Export as JSON** and **Import JSON**.
`config/configTransfer.ts` holds both, as pure functions over a config object. Import applies only
the keys the paste names, which makes a partial paste a feature (copy policy between deployments
without the ids) and works around the modal's 4000 character ceiling. Every value goes through
`parseConfigValue`, the same validator `/config set` uses, so no rule is written twice. An import is
all or nothing: one bad key fails the batch and the report names every problem at once. A paste is
staged in memory with a 10 minute TTL, shown as a before and after list, and applied only by the
person who pasted it. The `config` button namespace and the import modal are the one exception to
the staff-server-only surface rule, because they follow their command into the community server
recovery hatch.

**Interaction routing.** All buttons go through `routeButton` in `src/events/interactionCreate.ts`,
which splits `customId` on `:` into `namespace:first:second`. Namespaces in use: `config`
(`export`/`import`/`apply`/`discard`), `review`, `leave`
(`approve`/`decline`/`end`/`endConfirm`/`endCancel`), `leaveConfirm`, `leavePurge`, `tz`,
`leaderboard`. A pressed button edits its own message in place
(`interaction.update` / `deferUpdate` + `editReply`) rather than replying beneath it.

**Time.** Two clocks. `config.accountingTimezone` defines weeks and fortnights for everyone;
a member's `timezone` is display only. All zone maths goes through `src/time/calendar.ts`, which
uses `Intl.DateTimeFormat` parts and never assumes a 24-hour day (`zonedToUtc` converges in two
passes). `activityDays` is keyed by **UTC** day (`utcDayKey`), independent of both clocks.

**One assessment, one card, in its own message.** The fortnight review posts a header plus one
message per member below the requirement, and each row card is edited in place from awaiting a
decision through to its outcome: the queue and the log are the same object at two points in its
life. Rows are never dropped once decided. `reviewRowFor` in `services/assessmentService.ts` is the
only thing that draws a row, so colour, buttons and record cannot disagree. The old design batched
every row into one message, which meant a decision could only be shown by disabling buttons across
the whole message — deciding one member took everybody else's buttons with them and the queue could
not be finished. `domain/review.ts` holds the rules as pure functions (`rowButtons`,
`decisionPermitted`, `activeWarningCount`, `queueHeadline`, `reminderDue`), and `fortnightReviews`
keyed by index remembers where the header is.

**Every review outcome asks why.** Warn, excuse, dismiss, reopen and each bulk action open a modal
and require a reason; `showModal` cannot follow a defer, so the button only checks and opens, and
every write happens in `events/reviewModals.ts`. Dismiss tells the member nothing, and neither does reopening a
dismissal: announcing that one would raise the very issue the silence exists to avoid. **Reopen is
the only path that deletes a warning**, so a withdrawal is always a reviewed decision with an audit row
behind it. Warnings count and expire (`warningExpiryDays`) but the bot never escalates on its own,
the same way it never issues one. An Executive may excuse or dismiss their own row but never warn
themselves, and a departed member can be cleared but not warned.

**A rehearsal writes, and only Executives hear about it.** `assessmentDryRun` flags the records it
creates with `rehearsal: true` and **every read that feeds a real decision filters them out** —
`assessmentHistory` and `warningsFor` do it in the query, which is where it belongs: one missed
filter puts a rehearsal warning on somebody's real record. A rehearsal exercises the real write
path, because one that skips the writes tests nothing; notifications go only to members holding the
Executive role, and the card says when somebody was skipped.

**One leave record, one card.** A request's card in the leave channel is edited in place through
its whole life, from pending through approved or declined, active, back and purged. It is never
replaced, and never followed by a second message. `logChannelId`/`logMessageId` on the record are what make that possible, and
`leaveCardFor` in `services/leaveService.ts` is the only thing that draws it, so colour, buttons and
status cannot disagree. Colour is the state: amber waiting on a human, green approved, red declined,
blue running, grey finished. Buttons are the actions that state actually has, which is why a
declined record offers no way to end anything. An Executive can end active leave (or cancel approved
leave) from that card; it confirms first, because ending leave restores ranks, restarts assessment
and tells somebody who is not in the room that they are back. `endLeave` takes a `LeaveEndReason`
and returns the card it sent, so `/leave end` shows the member exactly what it DMed them.

**Leave input is parsed, not read.** `src/time/naturalDate.ts` turns a phrase into constraints
(`{weekday?, day?, month?, year?, hour, minute}`); `src/time/input.ts` resolves them by walking
forward from the member's own today. ISO forms bypass the search and are taken literally.
Because the parser interprets, a modal submission is **staged in memory** (`events/leaveConfirm.ts`,
15-minute TTL) and shown back for confirmation; nothing is written until the member agrees.

**Rollups are derived, never authoritative.** `weeklyStats` and `fortnightAssessments` are
recomputed from `activityDays`/`shifts`/`leave` by `/admin recompute`. Consequence: deleting raw
data silently changes historical verdicts: a purged leave record removes the exemption that made
a past fortnight `exempt` (`domain/assessments.ts` + `domain/leavePurge.ts`).

**Deletion.** `purgeLeaveRecord` is the only delete in the codebase, reachable only from the
**Purge this record** button on a decided leave card. It writes the audit row *before* deleting and
aborts if that write fails. `DELETION.md` is the procedure for everything else and must stay true.
Note `audit()` in `domain/audit.ts` deliberately swallows its own failures; the purge path
therefore writes to `collections.auditLog()` directly so a failure can abort.

**Ring faces.** A member picks one of four curated faces (`render/faces.ts`), stored as
`StaffDoc.ringFace`. A face sets **only the two soft rings**, shift time and active days, because
`rings.ts` says those carry no compliance meaning. The outer ring is red/amber/green/grey and is
never customisable: a member who could recolour it could hide the answer from themselves. Leave
overrides the face entirely, since grey is what "away" means. Two rules the tests enforce: **no face
may use a hue in the reserved bands** (0–60 red/amber, 90–165 green), or "on target" and "that is
just their shift ring" become the same glance; and a face's two hues must sit at least 35° apart.
Faces are curated, never free hex. The track renders at 0.19 alpha on near-black, and most
arbitrary colours read there as a fault. `light` and `overlay` are derived from one core hex by `lighten`,
which reproduces the original hand-picked values to within a couple of values per channel.
**`ringsCacheKey` includes the face**; without it, changing your face changes nothing you can see
until your minute count happens to move.

**Onboarding is two gates,** both in `interactionCreate.ts`: timezone (functional) then ring face
(not). `/timezone set` bypasses both. The timezone confirm button leads straight into the face
picker rather than saying "saved", so it reads as two choices instead of two refusals. Adding
`ringFace` means every existing member is asked once on their next command.

**The recap is two things.** Each member gets their own ring card by DM, held until **their own
local 09:00** on the week's first day, which is why the job ticks hourly rather than weekly;
`deliverDueRecaps` claims a receipt per member per week. Separately, `services/teamRecapService.ts`
posts **the team's week** to `recapChannelId` when the week closes: who closed their ring, the
total against last week's, and the spread chart. `recapChannelId` was configurable from the
beginning and nothing read it, so `/config view` offered a channel picker for a posting that did not
exist. Members on leave for the whole week are counted separately and excluded from every average,
or a week nobody was expected to work drags the team's figures down. The team recap claims its own
receipt (`claimTeamRecap`) for the same reason the fortnight announcement does, and a **cold start
spends the receipt without posting**, so a fresh deployment does not fill the channel with weeks
that closed before it existed. `/admin recap` rehearses either: `team: true` for the channel
posting, otherwise one member's DM. Neither claims a receipt, so the real ones still go out.

**Review charts.** `render/trend.ts` draws two, both pure string functions like the others.
`trendSvg` plots a member's last six fortnights as bars against a dashed requirement line, because
"0 of 240" reads identically whether somebody has always been at zero or fell off a cliff, and those
are opposite decisions. `spreadSvg` plots everybody's minutes for the fortnight, sorted, because
whether 120 is bad depends on what the rest of the team managed and the queue cannot say — it only
lists the people who fell short. **One hue (`#2e9fb8`), never a status palette**: the requirement
line carries met-versus-below geometrically, so colour never has to. That is deliberate — red
against green is ΔE 7.9 under deuteranopia, inside the band that is only legal with a second
encoding, and height against a labelled line is an encoding that survives greyscale. Below the line
is drawn as an absence rather than in red, because a red bar is a verdict the Executive has not
reached yet. The requirement is always included in the scale, so the line is never off the top of a
chart where everybody missed it. Exempt fortnights are drawn as a full-height absence labelled
"leave", never as a zero somebody earned.

**Images.** `ringsSvg` / `ringCardSvg` / `heatmapSvg` are pure string functions, exported separately
from the `render*` wrappers so tests assert on markup without invoking resvg. Ring elements carry
semantic classes (`ring-track`, `ring-progress`, `ring-overlay`), which is what the tests count.
PNGs are LRU-cached by `ringsCacheKey`. Every `new Resvg` must pass `font: FONT_OPTIONS`
(`render/fonts.ts`), or the default rebuilds a font database per image. Only Inter and DejaVu are
installed in the runtime image (see `Dockerfile`).

Three rules the renderers exist to obey, all learned by getting them wrong. **A ring is a track and
an arc, nothing else**. Decorative strokes multiply by three rings and turn the image into a
bullseye. **No `feGaussianBlur`**: it cost 20ms of a 27ms render; use flat fills and gradients.
**Glass is a property of the panel, never of a ring**: `render/panel.ts` is the only place that
draws it, as three layers (a near-black ground, a specular sheet over the upper 46%, and a rim
brighter along the top edge than the bottom), and both `ringCardSvg` and `heatmapSvg` call it.
Panels are near-black (`SURFACE` in `theme.ts`) so they read as an inset rather than as a box
inside Discord's ~#2b2d31 container. The one exception to the flat-ring rule is the legend marker
beside each row of the ring card: a lit bead inside a halo dimmed by `trackAlpha`, which is the
legend's echo of that row's track and arc.

Every margin on an image comes from one constant per file (`PANEL_PAD`, `PAD`), and derived
positions are computed from it rather than typed in: three legend rows are spaced so the block is
exactly as tall as the rings are wide, so both are inset by the same amount on all four sides.
`test/rings.test.ts` and `test/heatmap.test.ts` assert those margins, because the failure mode here
is a card that looks a few pixels off-centre and no one can say why. Preview against *sparse* data
(0%, 8%, an all-zero heatmap), not busy data. Every failure in this area has been an empty or
near-empty state.

**Jobs** (`src/jobs/index.ts`): `shift-sweep` and `leave-transitions` every minute, `recaps` hourly,
`week-close` at 00:05 in the accounting timezone. All are date-driven and idempotent, so a missed
run self-heals.

**Idempotent means the notifications too.** `fortnightAnchor` is the origin of the cycle, and
`fortnightIndexFor` floors an unbounded division, so weeks before the anchor come back as *negative*
indices. `isAssessableFortnight` (`domain/assessments.ts`) rejects them everywhere: at the close, at
`/admin assess`, and on the review buttons, because a live card for fortnight -6 can still issue a
real warning. A restart with a future anchor and an empty database once assessed fortnights -3 to -6
and DMed every member about each. Two other guards came from the same incident: a database with no
rollups at all is a **cold start**, not downtime (`hasNoWeeklyRollups` is asked *before* anything is
rebuilt, and `backfillPlan` seeds those fortnights' receipts without announcing them), and every
fortnight now claims a `deliveries` receipt (`claimFortnightAnnouncement`) before it DMs anyone, so
re-running an assessment refreshes the figures without re-notifying the roster. `assessmentDryRun`,
and `/admin assess rehearse: true`, post the card marked as a rehearsal, DM nobody and claim no
receipt, so a rehearsal is repeatable and never spends the one real announcement.

**Collections** (`src/db/client.ts`): `staff`, `activityDays`, `shifts`, `weeklyStats`,
`fortnightAssessments`, `warnings`, `leave`, `demandBuckets`, `guildConfig`, `auditLog`,
`deliveries`. Indexes are created in the same file. `demandBuckets` holds no user id and is never
in scope for a deletion request.

## Tests

`test/` covers pure functions only. There is no database or Discord fixture. Domain logic that
needs testing is factored into a pure function first (`coverageOf` beside `leaveCoverageFor`,
`transitionFor` in `presenceUpdate.ts`). Tests that involve dates freeze `now` and pass an explicit
timezone, usually `Pacific/Auckland`, because it has a DST rule that catches 24-hour-day
assumptions.
