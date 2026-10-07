# Staff of the Week — design

Status: **approved 2026-09-28**, implementation planned in
`docs/superpowers/plans/2026-09-28-staff-of-the-week.md`. Branch: `feature/staff-of-the-week`
(never pushed to `main` until reviewed and merged deliberately).

## Purpose

Each accounting week one moderator holds **Staff of the Week**: a role in the public server that
wears **the holder's own saved colour**. Every member keeps a personal Staff of the Week colour on
their staff record, set whenever they like; the role takes it on at handoff, and changes with it while
they hold it. The Executive team discusses the choice in their own group chat; one of them then
records it with `/sotw set`. The bot's job is to remind them, give them the facts they need (who is
barred, who did well), hand the role over at the week boundary, pick fairly at random if nobody
decided, and name the holder where the team already looks.

Success means: the role always changes hands at the week boundary without anyone touching Discord
settings; nobody holds it twice within three weeks; a forgotten week still gets a deserving holder;
the role is theirs in a way that feels like Discord's own colour menu; and somebody who picks a colour
once gets it back every time they win, without doing anything.

## Terms

- **Week** — an accounting week: starts at `weekStartDay` 00:00 in `accountingTimezone`
  (currently Monday 00:00 UTC, i.e. 13:00 NZDT). Every time in this spec is relative to it; nothing is
  a fixed wall-clock time.
- **Week W** — the week being assigned. **W-1, W-2** — the two weeks before it.
- **Closed week** — the week that has just ended at the moment of handoff (W-1 at W's start).
- **Holder** — whoever holds the role for a week, at any point in it.
- **Removed holder** — a holder taken off mid-week with `/sotw remove`. Recorded, but neither barred
  nor credited (see *Eligibility* and *Recognition*).
- **Handed off** — week W's handoff has run (its receipt is claimed). Before that, "the current week"
  for `/sotw` purposes is still W-1 (see *Target week*).

## Config (`StaffBotConfig`, all applied immediately)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `staffOfWeekRole` | role (public guild) | `""` | The role. **Empty switches the whole feature off**: no reminder, no handoff, no draw, no recognition; `/sotw` and `/settings sotw-colour` explain that it is not set up. Shown in `/config view` and `/dev status` as *optional*, never as missing. |
| `staffOfWeekChannelId` | channel (staff guild) | `""` | Where the feature's notices go (set, skip, remove, handoff, late changes). Empty means notices are only logged, as `recapChannelId` behaves. |
| `staffOfWeekReminderOffsetMinutes` | integer ≥ 0, < one week | `7560` | Reminder time after week start. 7560 = 5 d 6 h = **Saturday 06:00 UTC** under current settings. Moves with `accountingTimezone`/`weekStartDay`. |
| `staffOfWeekColourPickerUrl` | URL | `""` | The hosted colour picker page. The owner hosts it themselves (see *Colour picker page*); the bot only links to whatever this says. Empty hides the picker link; codes and raw hex still work. |

Neither timezone key gains new retroactive behaviour from this feature; `weekStartDay`'s existing
two-click confirmation is unchanged.

### Config guard (advisory, `config/configGuards.ts`)

`staffOfWeekRoleOrder` — pure, reported in `/config view` and `/dev status`, never refuses:

- the role sits **above the bot's highest role** → the bot cannot grant, remove or recolour it;
- a **coloured role held by staff sits above it** → the holder's chosen colour will be hidden, because
  Discord colours a name by the highest coloured role.

## Data

New collection `staffOfWeek`, one document per week, unique index on `weekStart`.

```ts
interface StaffOfWeekDoc {
    _id: ObjectId;
    weekStart: Date;                       // unique
    status: "pending" | "picked" | "random" | "skipped" | "empty";
    staffId: ObjectId | null;              // current holder (or pending pick), null if none
    decidedBy: string | null;              // Discord id of the Executive, null for random/empty
    decidedAt: Date | null;
    holders: ObjectId[];                   // everyone who held it at any point in the week
    removedHolders: ObjectId[];            // subset of holders taken off with /sotw remove
    handedOffAt: Date | null;
    events: StaffOfWeekEvent[];            // append-only history
    createdAt: Date;
    updatedAt: Date;
}

interface StaffOfWeekEvent {
    kind: "set" | "replaced" | "skipped" | "removed" | "drawn" | "pickFailed" | "empty"
        | "handoff" | "colour" | "colourCleared";
    at: Date;
    actorId: string | null;                // Discord id; null for the bot
    staffId: ObjectId | null;
    reason: string | null;
    detail: Record<string, unknown> | null; // e.g. draw pool, applied colours, why a pick failed
}
```

- `status: "pending"` exists only before handoff (a pick recorded for a future week). At handoff it
  becomes `picked`, `random`, `skipped` or `empty`.
- **Credited holders** of a week are `holders` minus `removedHolders`. Every rule that bars or
  recognises somebody reads that one derived list (`creditedHolders(doc)`, pure), never `holders`
  directly.
- **Nothing deletes these documents.** Removal is an event, not a delete; `DELETION.md` gains a line
  (the collection holds staff ids and is in scope for a deletion request).
- Receipts in `deliveries`: `sotw-reminder:<weekStartMs>`, `sotw-handoff:<weekStartMs>`, and the
  late-change notices' keys (see *Late changes*).

### The personal colour (`StaffDoc`)

```ts
type SotwColour =
    | { style: "solid"; primary: number }
    | { style: "gradient"; primary: number; secondary: number }
    | { style: "holographic" };

// on StaffDoc
sotwColour?: SotwColour | null;           // absent or null = no preference: the role has no colour
sotwColourUpdatedAt?: Date | null;
```

- A **preference, not a role setting.** It is the member's, lives on their record whatever happens to
  the role, and is never cleared by a handoff, a removal, a skip or losing eligibility. Only the member
  changes it (or a deletion request, which removes the staff record and the field with it —
  `DELETION.md` notes it).
- Absent reads as "no preference", so every existing record is valid without a migration.
- Stored as what the member chose, never downgraded to what the server can show (see *Applying*).
- `staffOfWeek.events` records what was **put on the role** (`colour`/`colourCleared`, with the applied
  colours in `detail`); changes to the preference itself are audit rows, because they happen whether
  or not anybody holds the role.
- `/settings export` includes the saved colour and the member's own Staff of the Week history (the
  weeks they held it, how, and any removal), because that command promises everything held about them.

## Eligibility (one pure function in `domain/staffOfWeek.ts`)

`eligibilityFor(candidate, week, context) → { eligible: true, flags } | { eligible: false, reason }`.
Used by `/sotw set`, the random draw, the reminder's list and `/sotw view`, so they cannot disagree.
Refusals in this order, each worded for the Executive reading it:

1. Not an active staff record.
2. Public-guild member does not resolve to Staff or Lead tier (covers departed members and anyone
   outside moderation).
3. Resolves to **Executive** — Executives are never eligible.
4. **A credited holder of W-1 or W-2** — by week slot. A removed holder is not barred; their
   replacement is. A skipped or empty week bars nobody.
5. **Leave exempts week W** — the existing `domain/leaveDays.ts` rule (≥ `minimumLeaveDays` of
   approved/active leave inside the week). A shorter absence does not disqualify.

`flags` carries information that never refuses:

- `pendingLeave` — leave awaiting a decision (a request or an extension) would exempt week W if
  approved. `/sotw set`, the reminder list and `/sotw view` show it (*"has leave awaiting a decision
  for that week"*); **the random draw skips them**, so the bot never hands the role to somebody who is
  probably away. An Executive may still pick them.

Not considered, deliberately: hiding from the leaderboard (hidden members are eligible, including in
the draw), conduct warnings (recognition and discipline are kept apart), and closed-week minutes for a
human pick.

## `/sotw` (Executive only)

Command tier is Executive for every subcommand; `seededOnly` is not set. Added to
`test/commandRequirements.test.ts` coverage.

### Target week

A pure `targetWeekFor(now, handedOff)`: before week W's handoff has run (the 00:00–00:05 gap, or
longer if the bot was down), `/sotw set` and `/sotw skip` still target W, the week about to be handed
off, and "the current week" is W-1. Otherwise a pick made at 00:02 would land on W+1 and leave W to
the random draw.

### `/sotw set user:<member> [reason]`

- Targets **next week** and may be run any number of times until handoff; a later run replaces the
  earlier (`replaced` event; last write wins; both audited).
- **Exception:** if the *current* week has no holder — removed, skipped, or empty because the draw
  found nobody or the feature was switched on mid-week — the reply is a card asking
  **[Rest of this week] [Next week]**. Rest of this week grants the role immediately for the remainder
  of the week, subject to the same eligibility (against the current week), applies that member's saved
  colour exactly as a handoff does, and sends them the same congratulation DM.
- Runs `eligibilityFor`; a refusal names the reason, and a `pendingLeave` flag is shown beside the
  confirmation.
- Shows the member's minutes in the closed week against `weeklyTargetMinutes` **for information only**
  — meeting the target is not required for a human pick.
- Posts a notice to `staffOfWeekChannelId`: who set whom, for which week, and the reason.

### `/sotw skip [reason]`

Marks next week `skipped`: no holder, **no random draw**. Reversible before handoff by `/sotw set`.
Notice posted.

### `/sotw remove`

Removes the **current** holder mid-week (e.g. resignation). Opens a modal requiring a reason (the bot's
rule: an action that undoes a decision asks why). Removes the role immediately, resets **the role's**
colour to none, sets the week `empty` with a `removed` event, and adds them to `removedHolders`: they
are **not barred** from the next two weeks and the week is **not credited** to them. Their saved
colour is untouched and comes back if they hold the role again. Notice posted; `/sotw set` then offers
the rest of the week.

### `/sotw view`

Current holder (and how: picked by X / drawn at random / skipped / empty), next week's pending
decision and who made it, the last few weeks, and who is eligible right now with their closed-week
minutes and any `pendingLeave` flag. Executive only, so a pending pick is never revealed early.

## Reminder (DM, not the channel)

New scheduled job `sotw-reminder`, next run = current week start + `staffOfWeekReminderOffsetMinutes`
(computed at re-arm time from `cachedConfig()`, like `nextWeekClose`, so config changes move it). One
reminder per week; there is no second nudge, because the random draw is the designed fallback.

- Skipped entirely while `staffOfWeekRole` is empty.
- Claims `sotw-reminder:<weekStart>` before sending (built first, then claimed — the recap rule).
- Recipients: every member of any `executiveRoles` role in the public guild (cached role members;
  `GuildMembers` intent is on), plus `BOOTSTRAP_ADMIN_IDS`, de-duplicated.
- **Always sent**, even if next week is already decided. Card shows:
  - next week's status: *not decided yet — it will be drawn at random* / *picked: X, by Y* /
    *skipped, by Y*;
  - the last two credited holders, stated as barred from next week;
  - this week's top eligible members so far (live minutes, `pendingLeave` flagged), as a starting
    point for the discussion;
  - a `cmd()` mention of `/sotw set`.
- A failed DM is logged; no retry.

## Handoff (inside `week-close`, after the rollup, before the team recap)

Runs at 00:05 accounting time in `closeWeek`, after `rebuildWeekForAll` (the draw reads the closed
week's frozen rollup) and **before `postTeamRecap`** (the recap names the new holder). Guarded by
`sotw-handoff:<weekStart>`; wrapped in its own try/catch so it can never stop the recap or the
assessment that follow.

1. Load week W's document.
   - `pending` with a pick → re-check the pick's **hard** refusals only (1–3: inactive, not Staff or
     Lead, Executive — which covers somebody who left the server). Passing → `picked`, granted even if
     late leave has since arrived (Executives were already told). Failing → `pickFailed` event with
     the reason, then the **random draw**, and the notice says the pick could not be honoured and why.
   - `skipped` → nobody.
   - none/undecided → **random draw** (below).
2. **The bot owns the role:** remove it from every cached member who is not the new holder
   (including anyone given it by hand). Set its colour through *Applying* — the new holder's saved
   colour, or none (`primaryColor: 0`, no secondary or tertiary) when they have none or nobody holds
   it. Grant it to the new holder. A failed colour write is logged and does not stop the grant; the
   `staffOfWeekRoleOrder` guard is where the cause shows.
3. DM the holder **straight away** (the role and the reason for it arrive together) a congratulation
   chosen at random from `SOTW_CONGRATULATIONS` (`render/sotwMessages.ts`): an array with one generic,
   warm message for now; the owner will replace and extend it. Beneath the message, one line generated
   by the bot: *"Your colour is on the role"* (with the preview image), or *"The role has no colour
   yet — choose one with `/settings sotw-colour` and it will be kept for next time"*, or the downgrade
   note from *Applying*. The holder is never told in advance; a pick can change until handoff.
4. Post a notice to `staffOfWeekChannelId`: who holds it and how (picked by X / pick could not be
   honoured, drawn from these / drawn from these / skipped / empty because nobody qualified).
5. Append `handoff` event, set `handedOffAt`.

### Random draw (pure: `drawPool(standings, eligibility) → candidates`, `draw(pool, rng)`)

- Closed week's standings by `activityMinutes`, descending (from `weeklyStats`, the same numbers as the
  leaderboard log).
- Keep only members who **met `weeklyTargetMinutes`** in the closed week, pass `eligibilityFor`, and
  carry no `pendingLeave` flag.
- Take the first three, **plus everybody tied with the third** on minutes, so a tie at the cut never
  decides who is in the pool. Draw one uniformly at random. Fewer than three qualifying → draw from
  however many there are. **None → week `empty`**, notice posted.
- The pool and the draw are recorded in the `drawn` event's `detail`, and the notice lists the pool.
- `rng` is injected so tests are deterministic.

### Downtime and cold start

- `catchUpMissedWeeks` runs the handoff for the **current** week only if its receipt is unclaimed (a
  missed week in the past cannot usefully be handed off).
- **Cold start** (no rollups, or the feature just switched on mid-week): record the current week as
  `empty` without a draw and claim the receipt; the first real handoff is the next week boundary.
- Boot also re-asserts role ownership (remove from anyone who is not the current holder) and the
  role's colour (the holder's saved colour, or none), idempotently: a colour edited by hand in
  Discord's settings is put back, because the preference is the source of truth.

## Leave and the role

Leave does not touch this role. Leave removes department roles only, so a holder who starts leave
mid-week keeps Staff of the Week, and leave ending never grants it.

## Late changes (never automatic)

The bot never ends a holder's week or changes the record on its own. A notice is posted to
`staffOfWeekChannelId`, and an Executive may `/sotw remove`, when:

- leave is approved/extended such that it exempts the current holder's week or next week's pending
  pick (hook in `reassessAfterLeaveChange`);
- the holder is deactivated, loses Staff tier, becomes an Executive, or leaves the public server
  (Discord drops the role itself; the record keeps saying they hold it until somebody runs
  `/sotw remove`). Checked on the leave/staff/member paths that already observe these.

One notice per subject per week (keyed receipt), so a flapping change does not repeat itself.

## Recognition

The holder is named in four places inside the bot, each marked 🏆 and nothing else:

- **`/leaderboard`** — 🏆 beside the current week's credited holder's row, in the same place as 🔒.
  It follows the row's visibility rules unchanged: a hidden holder's mark shows only where their row
  does.
- **Leaderboard log** — 🏆 beside the credited holder(s) of **that closed week**, because the log is
  frozen history.
- **Team recap** — one line naming **the new holder** (the week that has just begun), in the same
  message; the handoff runs first so it is known. Skipped or empty weeks omit the line. A recap posted
  during catch-up for an older week carries no line. There is no other announcement anywhere.
- **`/stats`** — the member's own card says how many weeks they have been credited with and the most
  recent. Removed weeks are not counted.

## Colour customisation

### `/settings sotw-colour`

A subcommand of the existing `/settings` (Staff tier), so `/sotw` stays wholly Executive. It edits
the member's **own saved colour**, and is open to **every member with a staff record at any time**,
holder or not — the point is to choose once, ahead of ever winning. Ephemeral card, edited in place.

The card opens on the member's saved colour: the bot's preview image of it (or "No colour saved —
the role would have no colour"), and one status line:

- holding the role now → *"You hold Staff of the Week — saving updates the role straight away."*
- not holding it → *"Saved for the next time you hold Staff of the Week."*
- an Executive → the same, plus that Executives are never eligible, so it will only apply if that
  changes. Saving is not refused: it harms nothing, and a refusal would be a second copy of the
  eligibility rule.

Buttons:

- **Open colour picker ↗** — link button to `staffOfWeekColourPickerUrl`, built fresh per press, with
  a `#fragment` (never sent to the host) carrying: public-guild nickname, badge (role id + icon hash,
  or the unicode emoji), avatar (user id + guild or global avatar hash), **the saved colour**, and
  whether the server has `ENHANCED_ROLE_COLORS`. Kept under Discord's 512-character URL limit by
  encoding ids and hashes, not URLs. Hidden while the config key is empty.
- **Enter code** — one-field modal.
- **Clear colour** — stages "no preference".

After a code or Clear, the card redraws with the **bot's image preview** of the staged choice and
**Save / Edit / Cancel**. The staged choice lives in memory for 10 minutes, savable only by the person
who staged it (the config-import rule).

**Save**: writes `sotwColour`/`sotwColourUpdatedAt` on the member's own staff record and an audit row.
Then, **re-derived at that moment** (never carried from the first click): if they are the current
holder, the role is updated through *Applying* and a `colour`/`colourCleared` event appended. The
card says which happened, and if the role write failed it says the colour is saved and will be put on
the role at the next boot or handoff.

**Cooldown**: 30 seconds per member, on **Save only while they hold the role**, because that is the
only save that writes to Discord. A non-holder saves freely. The card says how long remains; nothing
is lost, the staged choice stays until its TTL.

A saved gradient or holographic is **accepted even when the server lacks `ENHANCED_ROLE_COLORS`**,
because it is a preference that may outlive the server's current features; the card says how it
will show today.

### Applying a saved colour (pure: `roleColoursFor(pref, guildHasEnhanced)`)

The one function every role write goes through — handoff, rest-of-week grant, Save while holding, and
the boot re-assert — so they cannot disagree:

- `null`/absent → no colour.
- solid → `primaryColor`.
- gradient/holographic with `ENHANCED_ROLE_COLORS` → the full colours.
- gradient without it → **solid primary**; holographic without it → solid in holographic's primary
  constant. Returns `{ colours, downgraded: true }` so the card and the congratulation can say
  *"Your gradient shows as its first colour here, because the server does not support gradient
  roles."* The stored preference is never rewritten.

### Colour code (pure parser, `domain/sotwColour.ts`)

```
SOTW1-S-RRGGBB             solid
SOTW1-G-RRGGBB-RRGGBB      gradient (primary, secondary)
SOTW1-H                    holographic (Discord's fixed HolographicStyle constants)
#RRGGBB / RRGGBB / #RGB    bare hex = solid
```

Case-insensitive, surrounding whitespace ignored. Versioned prefix so the format can change. No
guardrails on the colour itself: any hex is accepted, no contrast note is added, and only the preview
is shown.

### Bot image preview (`render/sotwPreview.ts`)

Pure `sotwPreviewSvg(input)` plus a `render*` wrapper through resvg with `FONT_OPTIONS`, LRU-cached,
following the other renderers. Draws a mock Discord message twice (dark and light theme):

- real avatar (public-guild avatar, falling back to global);
- **public-guild nickname** in the chosen colour — solid fill, two-stop linear gradient, or the three
  holographic stops. A **documented exception** to the `staffDisplayName` rule: the colour is only
  visible in the public guild, so the name it colours is the one shown;
- the **role icon of the highest role that has one** (Discord's own rule): uploaded icons from the
  Discord CDN, unicode emoji via Twemoji PNG from jsDelivr; embedded as data URIs; cached; omitted if a
  fetch fails;
- a short sample line.

Fetching happens in the service, so the renderer stays a pure function. Known limit: Discord animates
gradients and holographic; a still image shows the colours, not the shimmer.

### Colour picker page (`site/sotw-colour/index.html`)

One self-contained static file, no build step, kept in this repo. **Hosting is the owner's, set up
manually and outside this feature** (the repo is private on a paid plan); nothing in the feature
publishes it, and the bot only links to `staffOfWeekColourPickerUrl`. No user-facing text names the
repository. Its only external requests are Discord CDN images.

- Emulates Discord's role colour menu: **Solid / Gradient / Holographic** style tiles (gradient and
  holographic greyed out when the fragment says the server lacks the feature), Discord's preset swatch
  row, a saturation/brightness square with hue slider, hex field, and two swappable gradient stops.
- Opens on the member's **saved colour** from the fragment.
- **Personal live preview**: the member's nickname, badge and avatar from the fragment, rendered as a
  Discord message on dark and light themes, updating on every drag, with CSS-animated gradient and
  holographic shimmer. Falls back to "Your name", a neutral avatar and no badge without a fragment.
- Generates the `SOTW1-…` code with a **Copy** button.
- A test here reads the page and asserts its format and version prefix match the parser, so the two
  cannot drift.

## `/dev sotw` (seededOnly; writes nothing, touches no roles, sends only to the caller)

- `reminder` — DMs the caller the reminder card as it would be sent now.
- `draw` — shows the candidate pool with figures and one sample draw.
- `congrats` — DMs the caller a congratulation from the array.

## Copy rules this feature follows

- **🏆 means Staff of the Week and nothing else.** `EMOJI.staffOfWeek` is 🏆, paired with a new
  `COLOUR.staffOfWeek` (mint, `0x66d4cf`: not amber, not red, not the standings or caution gold) for
  the feature's cards. The leaderboard's colour-derived mark (`COLOUR.standings`, currently an unused
  🏆 entry in `EMOJI_FOR_COLOUR`) becomes **📈**. A test in `test/tierPresentation.test.ts` style fails
  if 🏆 appears in any source file but `render/emoji.ts`, as the 📉 test does. The leaderboard card
  draws its title without an emoji and keeps its accent, and the Caution rung (which shares the gold)
  takes ⚠️ from `TIER_STYLE`, so neither changes visibly. Adding emoji to other headings is out of
  scope.
- ⚠️ is never used; inline alerts use ❗.
- No card names a file, repository or environment variable (except the existing `/dev` exceptions).
- Command mentions via `cmd()`.

## Testing (pure functions only)

- `eligibilityFor` — each refusal and its order; hidden members eligible; Executive refused; conduct
  warnings ignored; `pendingLeave` flagged, not refused.
- `creditedHolders` / week-slot exclusion — skipped and empty weeks bar nobody; a removed holder is
  neither barred nor credited; their replacement is both.
- `drawPool` / `draw` — target filter, pending-leave skip, top-three cut, ties at third included, thin
  week (1–2), empty week, deterministic rng.
- Handoff pick re-check — hard refusal falls back to the draw; late leave does not.
- `targetWeekFor` — before and after the handoff receipt, across the 00:00–00:05 gap.
- Reminder next-run — `Pacific/Auckland` DST boundary and a changed `weekStartDay`.
- `/sotw set` rest-of-this-week offer.
- Colour code parser — every form, case, whitespace, invalid input.
- Available styles vs guild features.
- `roleColoursFor` — none, solid, gradient and holographic, each with and without
  `ENHANCED_ROLE_COLORS`; downgrade flagged; preference never mutated.
- `/settings sotw-colour` status line — holder, non-holder, Executive, no saved colour.
- Cooldown applies to a holder's Save and not to a non-holder's.
- Highest-icon-role selection.
- `sotwPreviewSvg` markup — gradient stops, holographic stops, badge omitted when absent.
- Leaderboard row mark — holder marked, hidden holder's mark only where the row shows; log marks the
  closed week's credited holder.
- Recap line — new holder named; omitted for skipped/empty and for catch-up of older weeks.
- `/stats` count excludes removed weeks.
- 🏆 used only by Staff of the Week; standings mark is 📈.
- `staffOfWeekRoleOrder` guard.
- Page ↔ parser format agreement.
- `commandRequirements` covers `/sotw` and `/settings sotw-colour`.

## Out of scope

- Any announcement beyond the team recap line (no community post, no separate staff post).
- Telling a pick in advance, and a second reminder.
- An opt-out from being Staff of the Week.
- A default role colour when the holder has not chosen one.
- A contrast warning on chosen colours.
- Executive override of the holder's colour.
- Appeals or nominations through the bot.
- Hosting the picker page, and a bot-hosted or Discord Activity colour picker.

## Documentation

`CLAUDE.md` gains a Staff of the Week section (config, handoff timing and its place before the team
recap, role ownership, credited versus removed holders, the colour as a personal preference applied
through `roleColoursFor`, the nickname exception, the page/parser coupling, 🏆 and the standings mark
moving to 📈); `DELETION.md` gains the `staffOfWeek` collection and the `StaffDoc.sotwColour` field.
