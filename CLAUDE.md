# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- Node >= 26, TypeScript 5.9.3, ESM (`"type": "module"`, `module`/`moduleResolution: NodeNext`).
  Relative imports **must** carry the `.js` extension, including in `test/`.
- discord.js 14.27.0 — Components V2 only (`MessageFlags.IsComponentsV2`). With that flag set,
  `content`, `embeds`, `poll` and `stickers` are unavailable on a message.
- mongodb 6.21.0 (driver, no ODM). MongoDB 8 in Docker.
- @resvg/resvg-js 2.6.2 — SVG rasterised to PNG for rings and heatmaps.
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

**Two guilds.** Roles live in the public guild; commands answer in the staff guild or in DMs.
`resolveTierAllowingLeave` in `interactionCreate.ts` re-grants Staff tier to members whose
department role was removed by active leave, or they could not run `/leave end`.

**Interaction routing.** All buttons go through `routeButton` in `src/events/interactionCreate.ts`,
which splits `customId` on `:` into `namespace:first:second`. Namespaces in use: `review`, `leave`,
`leaveConfirm`, `leavePurge`, `tz`, `leaderboard`. A pressed button edits its own message in place
(`interaction.update` / `deferUpdate` + `editReply`) rather than replying beneath it.

**Time.** Two clocks. `config.accountingTimezone` defines weeks and fortnights for everyone;
a member's `timezone` is display only. All zone maths goes through `src/time/calendar.ts`, which
uses `Intl.DateTimeFormat` parts and never assumes a 24-hour day (`zonedToUtc` converges in two
passes). `activityDays` is keyed by **UTC** day (`utcDayKey`), independent of both clocks.

**Leave input is parsed, not read.** `src/time/naturalDate.ts` turns a phrase into constraints
(`{weekday?, day?, month?, year?, hour, minute}`); `src/time/input.ts` resolves them by walking
forward from the member's own today. ISO forms bypass the search and are taken literally.
Because the parser interprets, a modal submission is **staged in memory** (`events/leaveConfirm.ts`,
15-minute TTL) and shown back for confirmation; nothing is written until the member agrees.

**Rollups are derived, never authoritative.** `weeklyStats` and `fortnightAssessments` are
recomputed from `activityDays`/`shifts`/`leave` by `/admin recompute`. Consequence: deleting raw
data silently changes historical verdicts — a purged leave record removes the exemption that made
a past fortnight `exempt` (`domain/assessments.ts` + `domain/leavePurge.ts`).

**Deletion.** `purgeLeaveRecord` is the only delete in the codebase, reachable only from the
**Purge this record** button on a decided leave card. It writes the audit row *before* deleting and
aborts if that write fails. `DELETION.md` is the procedure for everything else and must stay true.
Note `audit()` in `domain/audit.ts` deliberately swallows its own failures; the purge path
therefore writes to `collections.auditLog()` directly so a failure can abort.

**Images.** `ringsSvg` / `ringCardSvg` / `heatmapSvg` are pure string functions, exported separately
from the `render*` wrappers so tests assert on markup without invoking resvg. Ring elements carry
semantic classes (`ring-track`, `ring-progress`, `ring-overlay`), which is what the tests count.
PNGs are LRU-cached by `ringsCacheKey`. Every `new Resvg` must pass `font: FONT_OPTIONS`
(`render/fonts.ts`) — the default rebuilds a font database per image. Only Inter and DejaVu are
installed in the runtime image (see `Dockerfile`).

Two rules the renderers exist to obey, both learned by getting them wrong. **A ring is a track and
an arc, nothing else** — decorative strokes multiply by three rings and turn the image into a
bullseye. **No `feGaussianBlur`**: it cost 20ms of a 27ms render; use flat fills and gradients.
Panels are near-black (`SURFACE` in `theme.ts`) so they read as an inset rather than as a box
inside Discord's ~#2b2d31 container. Preview against *sparse* data (0%, 8%, an all-zero heatmap),
not busy data — every failure in this area has been an empty or near-empty state.

**Jobs** (`src/jobs/index.ts`): `shift-sweep` and `leave-transitions` every minute, `recaps` hourly,
`week-close` at 00:05 in the accounting timezone. All are date-driven and idempotent, so a missed
run self-heals.

**Collections** (`src/db/client.ts`): `staff`, `activityDays`, `shifts`, `weeklyStats`,
`fortnightAssessments`, `warnings`, `leave`, `demandBuckets`, `guildConfig`, `auditLog`,
`deliveries`. Indexes are created in the same file. `demandBuckets` holds no user id and is never
in scope for a deletion request.

## Tests

`test/` covers pure functions only — there is no database or Discord fixture. Domain logic that
needs testing is factored into a pure function first (`coverageOf` beside `leaveCoverageFor`,
`transitionFor` in `presenceUpdate.ts`). Tests that involve dates freeze `now` and pass an explicit
timezone, usually `Pacific/Auckland`, because it has a DST rule that catches 24-hour-day
assumptions.
