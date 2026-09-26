# Staff of the Week — design

Status: **draft, awaiting review.** Nothing here is implemented. Branch: `feature/staff-of-the-week`
(never pushed to `main` until reviewed and merged deliberately).

## Purpose

Each accounting week one moderator holds **Staff of the Week**: a role in the public server whose
colour they may customise while they hold it. The Executive team discusses the choice in their own
group chat; one of them then records it with `/sotw set`. The bot's job is to remind them, give them
the facts they need (who is barred, who did well), hand the role over at the week boundary, and pick
fairly at random if nobody decided.

Success means: the role always changes hands at the week boundary without anyone touching Discord
settings; nobody holds it twice within three weeks; a forgotten week still gets a deserving holder; and
the holder can make the role theirs in a way that feels like Discord's own colour menu.

## Terms

- **Week** — an accounting week: starts at `weekStartDay` 00:00 in `accountingTimezone`
  (currently Monday 00:00 UTC, i.e. 13:00 NZDT). Every time in this spec is relative to it; nothing is
  a fixed wall-clock time.
- **Week W** — the week being assigned. **W-1, W-2** — the two weeks before it.
- **Closed week** — the week that has just ended at the moment of handoff (W-1 at W's start).
- **Holder** — whoever holds the role for a week, at any point in it.

## Config (`StaffBotConfig`, all applied immediately)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `staffOfWeekRole` | role (public guild) | `""` | The role. **Empty switches the whole feature off**: no reminder, no handoff, no draw; `/sotw` and `/settings sotw-colour` explain that it is not set up. Shown in `/config view` and `/dev status` as *optional*, never as missing. |
| `staffOfWeekReminderOffsetMinutes` | integer ≥ 0, < one week | `7560` | Reminder time after week start. 7560 = 5 d 6 h = **Saturday 06:00 UTC** under current settings. Moves with `accountingTimezone`/`weekStartDay`. |
| `staffOfWeekColourPickerUrl` | URL | `""` | The hosted colour picker page (custom domain, see below). Empty hides the picker link; codes and raw hex still work. |

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
    handedOffAt: Date | null;
    events: StaffOfWeekEvent[];            // append-only history
    createdAt: Date;
    updatedAt: Date;
}

interface StaffOfWeekEvent {
    kind: "set" | "replaced" | "skipped" | "removed" | "drawn" | "empty" | "handoff" | "colour"
        | "colourCleared";
    at: Date;
    actorId: string | null;                // Discord id; null for the bot
    staffId: ObjectId | null;
    reason: string | null;
    detail: Record<string, unknown> | null; // e.g. draw pool, colour code
}
```

- `status: "pending"` exists only before handoff (a pick recorded for a future week). At handoff it
  becomes `picked`, `random`, `skipped` or `empty`.
- **Nothing deletes these documents.** Removal is an event, not a delete; `DELETION.md` gains a line
  (the collection holds staff ids and is in scope for a deletion request).
- Receipts in `deliveries`: `sotw-reminder:<weekStartMs>`, `sotw-handoff:<weekStartMs>`.

## Eligibility (one pure function in `domain/staffOfWeek.ts`)

`eligibilityFor(candidate, week, context) → { eligible: true } | { eligible: false, reason }`.
Used by `/sotw set`, the random draw, the reminder's list and `/sotw view`, so they cannot disagree.
Refusals in this order, each worded for the Executive reading it:

1. Not an active staff record.
2. Public-guild member does not resolve to Staff or Lead tier (covers departed members and anyone
   outside moderation).
3. Resolves to **Executive** — Executives are never eligible.
4. **Held the role in W-1 or W-2** — by week slot: every id in those weeks' `holders[]`, including
   someone removed mid-week and their replacement. A skipped or empty week bars nobody.
5. **Leave exempts week W** — the existing `domain/leaveDays.ts` rule (≥ `minimumLeaveDays` of
   approved/active leave inside the week). A shorter absence does not disqualify.

Hidden-from-leaderboard members are eligible, including in the draw.

## `/sotw` (Executive only)

Command tier is Executive for every subcommand; `seededOnly` is not set. Added to
`test/commandRequirements.test.ts` coverage.

### `/sotw set user:<member> [reason]`

- Targets **week W+1** (next week) and may be run any number of times until handoff; a later run
  replaces the earlier (`replaced` event; last write wins; both audited).
- **Exception:** if the *current* week has no holder — removed, skipped, or empty because the draw
  found nobody or the feature was switched on mid-week — the reply is a card asking **[Rest of this week] [Next week]**. Rest of this week grants the role immediately for the
  remainder of the week, subject to the same eligibility (against the current week).
- Runs `eligibilityFor`; refusal names the reason.
- Shows the member's minutes in the closed week against `weeklyTargetMinutes` **for information only**
  — meeting the target is not required for a human pick.
- All Executives are DMed who set whom, for which week (the actor included, so the group has one
  record).

### `/sotw skip [reason]`

Marks next week `skipped`: no holder, **no random draw**. Reversible before handoff by `/sotw set`.
Executives DMed.

### `/sotw remove`

Removes the **current** holder mid-week (e.g. resignation). Opens a modal requiring a reason (the bot's
rule: an action that undoes a decision asks why). Removes the role immediately, resets its colour to
none, sets the week `empty` with a `removed` event; the removed member stays in `holders[]`.
Executives DMed. `/sotw set` then offers the rest of the week.

### `/sotw view`

Current holder (and how: picked by X / drawn at random / skipped / empty), next week's pending
decision and who made it, the last few weeks, and who is eligible right now with their closed-week
minutes. Executive only, so a pending pick is never revealed early.

## Reminder

New scheduled job `sotw-reminder`, next run = current week start + `staffOfWeekReminderOffsetMinutes`
(computed at re-arm time from `cachedConfig()`, like `nextWeekClose`, so config changes move it).

- Skipped entirely while `staffOfWeekRole` is empty.
- Claims `sotw-reminder:<weekStart>` before sending (built first, then claimed — the recap rule).
- Recipients: every member of any `executiveRoles` role in the public guild (cached role members;
  `GuildMembers` intent is on), plus `BOOTSTRAP_ADMIN_IDS`, de-duplicated.
- **Always sent**, even if next week is already decided. Card shows:
  - next week's status: *not decided yet* / *picked: X, by Y* / *skipped, by Y*;
  - the last two holders, stated as barred from next week;
  - this week's top eligible members so far (live minutes), as a starting point for the discussion;
  - a `cmd()` mention of `/sotw set`.
- A failed DM is logged; no retry.

## Handoff (inside `week-close`, after the rollup)

Runs at 00:05 accounting time in `closeWeek`, after `rebuildWeekForAll`, because the draw reads the
closed week's frozen rollup. Guarded by `sotw-handoff:<weekStart>`; wrapped in its own try/catch so it
can never stop the assessment that follows.

1. Load week W's document.
   - `pending` with a pick → `picked`. Granted even if late leave has since arrived (Executives were
     already told).
   - `skipped` → nobody.
   - none/undecided → **random draw** (below).
2. **The bot owns the role:** remove it from every cached member who is not the new holder
   (including anyone given it by hand). Set its colour to **none** (`primaryColor: 0`, no secondary or
   tertiary). Grant it to the new holder.
3. DM the holder a congratulation chosen at random from `SOTW_CONGRATULATIONS`
   (`render/sotwMessages.ts`): an array with one generic, warm message for now; the owner will
   replace and extend it.
4. DM every Executive: who holds it and how (picked by X / drawn from these three / skipped / empty
   because nobody qualified).
5. Append `handoff` event, set `handedOffAt`.

### Random draw (pure: `drawPool(standings, eligibility) → candidates`, `draw(pool, rng)`)

- Closed week's standings by `activityMinutes`, descending (from `weeklyStats`, the same numbers as the
  leaderboard log).
- Keep only members who **met `weeklyTargetMinutes`** in the closed week and pass `eligibilityFor`.
- Take the first three; draw one uniformly at random. Fewer than three qualifying → draw from however
  many there are. **None → week `empty`**, Executives DMed.
- The pool and the draw are recorded in the `drawn` event's `detail`.
- `rng` is injected so tests are deterministic.

### Downtime and cold start

- `catchUpMissedWeeks` runs the handoff for the **current** week only if its receipt is unclaimed (a
  missed week in the past cannot usefully be handed off).
- **Cold start** (no rollups, or the feature just switched on mid-week): record the current week as
  `empty` without a draw and claim the receipt; the first real handoff is the next week boundary.
- Boot also re-asserts role ownership (remove from anyone who is not the current holder), idempotently.

## Late changes (never automatic)

The bot never ends a holder's week on its own. Executives are DMed, and may `/sotw remove`, when:

- leave is approved/extended such that it exempts the current holder's week or next week's pending
  pick (hook in `reassessAfterLeaveChange`);
- the holder is deactivated, loses Staff tier, or becomes an Executive (checked at the handoff and on
  the leave/staff paths that already observe these).

One DM per subject per week (keyed receipt), so a flapping change does not spam.

## Colour customisation

### `/settings sotw-colour`

A subcommand of the existing `/settings` (Staff tier), so `/sotw` stays wholly Executive. The handler
refuses anyone who is not the **current holder** (re-derived on every press, never carried). Ephemeral
card, edited in place.

Buttons:

- **Open colour picker ↗** — link button to `staffOfWeekColourPickerUrl`, built fresh per press, with
  a `#fragment` (never sent to the host) carrying: public-guild nickname, badge (role id + icon hash,
  or the unicode emoji), avatar (user id + guild or global avatar hash), current colours, and whether
  the server has `ENHANCED_ROLE_COLORS`. Kept under Discord's 512-character URL limit by encoding ids
  and hashes, not URLs. Hidden while the config key is empty.
- **Enter code** — one-field modal.
- **Clear colour** — stages "no colour".

After a code or Clear, the card redraws with the **bot's image preview** and **Apply / Edit / Cancel**.
The staged choice lives in memory for 10 minutes, applicable only by the person who staged it
(the config-import rule).

**Apply**: re-check holder; enforce a **30-second cooldown** per holder (card says how long remains);
`role.setColors(...)`; audit row; `colour`/`colourCleared` event. Gradient and holographic are refused
with an explanation when the public guild lacks `ENHANCED_ROLE_COLORS`.

### Colour code (pure parser, `domain/sotwColour.ts`)

```
SOTW1-S-RRGGBB             solid
SOTW1-G-RRGGBB-RRGGBB      gradient (primary, secondary)
SOTW1-H                    holographic (Discord's fixed HolographicStyle constants)
#RRGGBB / RRGGBB / #RGB    bare hex = solid
```

Case-insensitive, surrounding whitespace ignored. Versioned prefix so the format can change. No
guardrails on the colour itself: any hex is accepted, and only the preview is shown.

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

One self-contained static file, no build step, hosted with GitHub Pages from this repo behind a
**custom domain** (so no user-facing link names the repository). Its only external requests are
Discord CDN images.

- Emulates Discord's role colour menu: **Solid / Gradient / Holographic** style tiles (gradient and
  holographic greyed out when the fragment says the server lacks the feature), Discord's preset swatch
  row, a saturation/brightness square with hue slider, hex field, and two swappable gradient stops.
- **Personal live preview**: the holder's nickname, badge and avatar from the fragment, rendered as a
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

- Colour and emoji come from `COLOUR`/`render/emoji.ts`; a new `COLOUR.staffOfWeek` (and its one mark)
  is added for the feature's cards. Not amber (the fortnight review's), not red.
- ⚠️ is never used; inline alerts use ❗.
- No card names a file, repository or environment variable (except the existing `/dev` exceptions).
- Command mentions via `cmd()`.

## Testing (pure functions only)

- `eligibilityFor` — each refusal and its order; hidden members eligible; Executive refused.
- Week-slot exclusion — skipped and empty weeks bar nobody; removed holder and replacement both barred.
- `drawPool` / `draw` — target filter, top-three cut, thin week (1–2), empty week, deterministic rng.
- Reminder next-run — `Pacific/Auckland` DST boundary and a changed `weekStartDay`.
- `/sotw set` target-week rule (next vs rest-of-this-week offer).
- Colour code parser — every form, case, whitespace, invalid input.
- Available styles vs guild features.
- Highest-icon-role selection.
- `sotwPreviewSvg` markup — gradient stops, holographic stops, badge omitted when absent.
- Cooldown rule.
- `staffOfWeekRoleOrder` guard.
- Page ↔ parser format agreement.
- `commandRequirements` covers `/sotw` and `/settings sotw-colour`.

## Out of scope

- Any public announcement channel for the holder (role + DMs only).
- Executive override of the holder's colour.
- Appeals or nominations through the bot.
- A bot-hosted or Discord Activity colour picker.

## Documentation

`CLAUDE.md` gains a Staff of the Week section (config, handoff timing, role ownership, the nickname
exception, the page/parser coupling); `DELETION.md` gains the `staffOfWeek` collection.
