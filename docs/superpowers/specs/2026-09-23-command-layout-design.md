# Command layout: one command per subject

## Why

The command list grew one feature at a time, and it shows. `/coverage` offered three views of the same
question under names that described the chart (`heatmap`, `activity`) rather than what it answers, and
one of the three (`gaps`) was the heatmap card's own "five worst hours" list with a recruiting hint
attached. `/staff` held an Executive account repair, two personal preferences and a disciplinary
record. A member's own settings lived under four commands. Warnings were issued from `/admin` and read
from `/staff`. `/admin assess` and `/dev assess` shared a verb across very different stakes. And
`/admin shifts` said "Lead and Executive" while `/admin` as a whole was gated to Executives, so no Lead
could ever reach it.

Nothing is in production yet, so there is nothing to grandfather: no aliases, no deprecation notices.

## The layout

```
/shift     start · end · status · history [user]
/leave     request · extend · end · list
/stats     rings [user] · leaderboard [scope] [page]
/warnings  view [user] · issue user
/settings  timezone zone · face · privacy hide-me · export
/coverage  server [channel] [tz] [weeks] · staff [tz] [weeks]
/admin     recompute weeks · assess [fortnight] · relink old new
/config    view · set · add · remove · reset              (unchanged)
/dev       rehearse [fortnight] · recap · purge · status
```

The organising rule is **one command per subject**. Permission varies inside a command where it has
to, rather than being the thing that decides which command a feature lives in.

| Was | Now |
|---|---|
| `/rings` | `/stats rings` |
| `/leaderboard` | `/stats leaderboard` |
| `/timezone set` | `/settings timezone` |
| `/timezone view` | removed; Discord timestamps already render in the reader's own zone |
| `/staff face` | `/settings face` |
| `/staff privacy` | `/settings privacy` |
| `/mydata export` | `/settings export` |
| `/staff warnings` | `/warnings view` |
| `/admin warn` | `/warnings issue` |
| `/staff relink` | `/admin relink` |
| `/admin shifts` | `/shift history [user]` |
| `/coverage activity` | `/coverage server` |
| `/coverage heatmap` | `/coverage staff` |
| `/coverage gaps` | removed, folded into `/coverage staff` |
| `/dev assess` | `/dev rehearse` |

### Coverage

Two views, named for what is plotted:

- **`/coverage server`**: how active the server is, hour by hour. Messages per hour, optionally one
  channel. Unchanged apart from its name.
- **`/coverage staff`**: server activity against moderators on shift. The heatmap of messages per
  available moderator, and its five worst hours underneath. Each of those hours now also carries the
  line `gaps` used to print, naming the timezones where that hour falls in the evening, because that
  is the recruiting hint and it was the only thing `gaps` added.

`HeatmapKind` (`"coverage" | "activity"`) is internal and keeps its names.

## Per-subcommand rules

`Command` gains an optional map of per-subcommand rules:

```ts
subcommands?: Record<string, { tier?: Tier; bypassOnboarding?: boolean }>;
```

A pure `requirementsFor(command, subcommand)` (`commands/requirements.ts`) folds the command's own
`tier` with the subcommand's: the stricter of the two wins, so a subcommand can only ever raise the
bar. `interactionCreate` calls it once and checks the result where it checked `command.tier` before.
The refusal names the subcommand: `**/warnings issue** is for executive and above.`

`command.tier` stays the minimum across the command and still drives visibility: the staff-server
permission gate and whether the command is offered in a DM. Discord cannot gate a single subcommand,
so `/warnings` is visible to every Moderator, and `issue` is refused in the handler. That is the same
position every "Lead and above for someone else" option is already in.

`bypassTimezoneGate` on `Command` is replaced by `bypassOnboarding` on the rule, because it now
belongs to one subcommand (`/settings timezone`) and not to `/settings` as a whole: `/settings face`
before a timezone is set should still be asked for the timezone first.

Rules applied:

| Command | Command tier | Subcommand rules |
|---|---|---|
| `/warnings` | staff | `issue`: executive |
| `/settings` | staff | `timezone`: bypassOnboarding |
| `/shift` | staff | none; `history` for someone else checks Lead in the handler, as `/stats rings` does |
| `/admin` | executive | none |

"Yours, or somebody else's if you are a Lead" stays a check inside the handler, because it depends
on an option value and not on the subcommand.

## Files

- `commands/stats.ts`: new. `rings` and `leaderboard` subcommands. `rings.ts` is removed and its
  body moves here. `leaderboard.ts` stays as the module that draws the leaderboard
  (`renderLeaderboard` is used by the paging buttons) and no longer defines a command.
- `commands/settings.ts`: new. Absorbs `timezone.ts` (set only), `staff face`, `staff privacy` and
  `mydata.ts`.
- `commands/warnings.ts`: new. `view` from `staff.ts`, `issue` from `admin.ts`, with `describeTier`.
- `commands/shift.ts`: gains `history`.
- `commands/admin.ts`: loses `warn` and `shifts`, gains `relink`.
- `commands/coverage.ts`: `server` and `staff`; `gaps` removed.
- `commands/dev.ts`: `assess` renamed `rehearse`.
- `staff.ts`, `timezone.ts`, `mydata.ts`, `rings.ts`: deleted.
- Every `cmd("…")` chip points at the new path. Audit action names (`mydata.export`, `dev.assess`,
  …) are unchanged: they are records, not interface.
- `CLAUDE.md`, `README.md`, `DELETION.md` and source comments are updated to the new names.

## Tests

- `requirementsFor`: the stricter tier wins, a subcommand without a rule inherits the command's,
  and `bypassOnboarding` is per subcommand.
- The existing registry test (`leaveCoverage.test.ts`) lists the new command names.
- Mention tests that use `timezone`/`staff face` as sample paths keep working as they are: they test
  `cmd()`, not the registry.

## Out of scope

Behaviour of any individual command beyond the `gaps` fold. Button namespaces and customIds are
unchanged.
