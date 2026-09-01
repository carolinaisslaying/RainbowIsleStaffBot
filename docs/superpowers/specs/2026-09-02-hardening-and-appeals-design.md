# Hardening, configuration guards, and the right to answer back

2026-09-02. Twelve findings from an audit of the whole bot, plus three pieces of
new work. Everything here was chosen by the Executive who owns the deployment;
the open question at the end is the one thing left to settle.

The work lands on one branch in four stages. Each stage stands on its own and
the branch is reviewable after any of them.

---

## Stage one: five bugs

These are ordered by what they cost when they fire, not by size.

### 1. A warning card claims a delivery it never checked

`events/reviewModals.ts`, in `applyDecision`:

```js
if (notify && subject && (await mayNotify(client, config, rehearsal, subject.discordId))) {
    messaged = true;                                   // before the attempt
    await tryDm(client, subject.discordId, {...});     // returns a boolean, discarded
}
```

`messaged` records **permission to notify**, not delivery. `tryDm` already
returns false on a closed DM and logs at debug. So an Executive who warns a
member with DMs closed reads "They have been messaged." — and the
`"They could not be messaged."` branch below it is unreachable outside a
rehearsal.

The same discard is in `services/notifications.ts`:

```js
export async function sendFortnightOutcome(client, discordId, body, colour) {
    await tryDm(client, discordId, {...});             // boolean discarded
}
```

**Fix.** Take `tryDm`'s return value in both places. `messaged` becomes the
result of the attempt. `sendFortnightOutcome` returns the boolean so
`runFortnightAssessment` can count what failed. This is also the input stage
four needs, so it lands here rather than being invented twice.

### 2. A failed write silently burns an activity minute

`domain/activity.ts`, in `creditMinute`:

```js
const day = await loadDay(staffId, date);
if (isMinuteSet(day.bitmap, minute)) return false;
setMinute(day.bitmap, minute);                         // mutates the CACHED buffer
await collections.activityDays().updateOne(...);       // if this throws…
```

`day.bitmap` is the object held in `hotDays`. If the write throws, the bit is
set in memory and the document never received it. Every later call for that
minute returns false, so the credit is lost until the cache is pruned — an hour,
or forever if the day stays hot. `recomputeCounts` won't recover it either: it
rebuilds `count` from the stored bitmap, which never had the bit.

**Fix.** Set the bit on a copy, write, and only then commit the copy into the
cache entry. The lock already serialises the read-modify-write, so there is no
window between the successful write and the cache update.

Test: a `creditMinute` whose `updateOne` rejects leaves the minute uncredited,
and a retry credits it.

### 3. Every restart marks the on-shift team Away

`services/shiftService.ts` holds `lastSeen` as an in-process `Map`. It is never
persisted, and `jobs/reconcile.ts` never seeds it. The sweep does:

```js
const seen = lastSeenAt(shift.staffId) ?? shift.startedAt.getTime();
if (now.getTime() - seen > awayMs) { …goAway… }
```

After a redeploy the map is empty, so every surviving open shift falls back to
`startedAt`. Any shift older than `awayAfterMinutes` is marked Away on the first
minute tick, and auto-ended `autoEndAfterAwayMinutes` later. A deploy at 8pm
ends the evening shift for everyone who was working it.

**Fix.** `reconcileOnBoot` seeds `lastSeen` with `now` for every open shift it
decides to keep. Reconciliation already enumerates exactly that set, so this is
one call inside a loop that exists.

The trade is stated deliberately: a member who genuinely went quiet ten minutes
before the restart gets one extra `awayAfterMinutes` of grace. That is the right
direction to be wrong in — the alternative ends a shift somebody is working.

### 4. Week close reads a config it captured at boot

`jobs/index.ts`:

```js
schedule("week-close", nextWeekClose(config), …)       // config from boot
```

Every other job calls `await loadConfig()` inside its body. This one closes over
the config object, so `accountingTimezone` and `weekStartDay` changed through
`/config set` do not move the boundary until someone restarts the container. The
job body reloads the config, so the rollup itself uses the new zone while the
schedule that fires it uses the old one — the two disagree.

This is CLAUDE.md's own rule ("Handlers call `loadConfig()` rather than closing
over a config") and the only place in the codebase that breaks it.

**Fix.** `nextWeekClose` takes no config and reads `cachedConfig()` when it is
asked for the next boundary. `invalidateConfigCache` already runs on every
`/config set`, and the scheduler re-arms after every fire, so the next boundary
is computed against whatever the config says at that moment.

### 5. The purge error card can tell a false story

`events/scrubButtons.ts` wraps three steps in one `try`, and the `catch` says:

> "The audit row could not be written, so nothing was deleted."

That is true only if `recordScrubIntent` was what failed. A failure inside
`deleteScrubbed` — between the `deleteMany` on warnings and the `deleteMany` on
assessments — leaves warnings gone and assessments present, and tells the
operator nothing happened.

**Fix.** Narrow the claim to what is known. The audit call keeps its own `try`
and its own message. A failure after the receipt exists says so plainly: the
audit row landed, some records may be gone, and the audit row is what to read.
`deleteScrubbed` already refuses a target that changed after auditing; this is
the reporting half of that same care.

---

## Stage two: configuration that pushes back

Three guards. None of them refuses a write — policy is the Executive's call, and
a bot that argues with its owner gets worked around. They say what a setting
will do, on the card, at the moment it is set.

### The anchor that has not happened yet

`fortnightAnchor` defaults to `2026-09-28T00:00:00Z`. `fortnightIndexFor` floors
an unbounded division, so today every index is negative, and
`isAssessableFortnight` correctly refuses all of them. A deployment stood up
today assesses nobody, warns nobody, and explains itself only in a debug log.

The guards are right. Their silence is not.

**`/config view` gains a line** when the anchor is in the future: the anchor
date, and the date the first assessable fortnight closes. Nothing else changes —
the refusal itself is already correct.

### Settings that cannot be met

`fortnightRequiredMinutes` above `weeklyTargetMinutes × 2` is a requirement
nobody can reach by hitting their weekly target twice. `autoEndAfterAwayMinutes`
below `awayAfterMinutes` ends a shift before the member is even marked Away.

Both get a warning on the `/config set` result card, naming the other key and
what the combination means in practice. Written as pure functions over a config
object beside `parseConfigValue`, so they are testable and so `/config view` can
show the same warnings for a document that was already in that state.

### Settings that rewrite history

`weekStartDay` and `accountingTimezone` decide where every week and fortnight
boundary falls, for every record ever written. Changing either silently
reindexes the lot: stored `weeklyStats` and `fortnightAssessments` describe
windows that no longer exist, and a member's past verdicts move.

These two take a second click. The confirmation says how many weekly rollups and
assessments are already stored, that their windows will no longer match the
calendar, and that `/admin recompute` is what reconciles them. Same shape as the
leave-purge confirmation, which exists for the same reason.

---

## Stage three: four cleanups

**Bootstrap-admin log spam.** `resolveTier` logs a warning every time a seeded
admin runs anything. On a deployment where the admin is also the working
Executive, that is a warning per interaction, burying the ones that matter.
Log once per user per process, in a `Set`.

**API hardening.** `/api/assessments` takes a `limit` (default 500, max 2000)
and reports whether it truncated. A `NaN` `API_PORT` fails
`assertEnvironment()` rather than binding a random port. The server handle is
kept and closed in `shutdown()`. `/api/webhooks/test` is deleted — it echoes a
timestamp, nothing calls it, and a stub endpoint on an authenticated surface is
a thing to explain later.

**A staff-lookup cache on the hot path.** `messageCreate` calls
`findStaffByDiscordId` for every message in a 110,000-member guild, before it
knows the author is staff at all. Almost every one of those is a miss. A bounded
LRU over Discord ID → `StaffDoc | null`, invalidated in `ensureStaff`,
`relinkStaff` and `setStaffActive`. `LruCache` already exists and is used for
ring PNGs. Negative results are cached with a short TTL so a newly-seen member
is picked up without a restart.

**The dead `tick` parameter.** `tick(finished)` is always called `false` and
always renders `finished: false`; the real final card is a separate `respond`.
The parameter goes. The comment claiming "first and last always sent" is
corrected to describe what the code does — the first tick and a final card that
is not a tick.

---

## Stage four: three features

### `/dev status` — the operator surface

`seededOnly`, like the rest of `/dev`. It names jobs, an environment switch and
database state, which is operator detail; CLAUDE.md keeps that out of anything a
Moderator reads, and `/dev` is already the documented exception because the only
person who can see it is the person who would act on it.

One card:

```
[Bot status]
  Uptime 4d 2h · gateway 48ms · Mongo reachable

  Jobs        shift-sweep      ran 34s ago, next in 26s
              leave-transitions ran 34s ago, next in 26s
              recaps            ran 22m ago, next in 38m
              week-close        ran 3d ago,  next Mon 00:05 NZST
              count-recompute   ran 7h ago,  next 03:20 UTC
              review-reminders  ran 22m ago, next in 38m

  Config      2 required keys unset: recapChannelId, leadRoles
              Fortnight anchor reached; fortnight 4 closes 12 Oct

  Deployment  Dangerous commands: ON — /dev purge can delete real records
```

The scheduler grows a `jobStatus()` returning name, last run, last outcome and
next fire for each job. It already holds all of it except the last run, which is
one field set in `fire`.

### Undeliverable DMs, on the row

Stage one made `tryDm`'s answer available. This records it.

`WarningDoc` gains `deliveredAt: Date | null` and `deliveryFailedAt: Date | null`.
`reviewRowFor` — still the only thing that draws a row — reads them where it
currently draws the acknowledgement line:

| State | Line |
| --- | --- |
| Delivered, acknowledged | `Acknowledged 2 Sep` |
| Delivered, not acknowledged | `Not yet acknowledged` |
| Delivery failed | `⚠️ Not delivered — their DMs are closed` |

No new messages, no retries, no channel fallback. A warning is private between
the bot and the member, and announcing in the staff room that one is waiting
makes its existence public — which is the thing the DM was for.

The failure is also written to `auditLog`, because "the member was never told"
is a fact about a decision that outlives the card.

### Appeals

A member can answer back. Today the only path is replying to an Executive
out-of-band, and nothing records that they did.

**The button.** Beside "I have read this" on the warning DM. It opens a modal
with one required field. On submit:

- the text is stored on the warning as `appeal: { text, filedAt }`
- the review row redraws amber, in an `under appeal` state, quoting the text
- the queue headline counts it: `3 decided, 1 under appeal`
- an audit row is written

The Executives then use the buttons that already exist. Reopen already deletes
the warning and DMs the member that the decision was withdrawn, so upholding an
appeal needs nothing new. Declining one is a second decision on a row that is
already decided — the appeal state clears, the outcome stands, and the member is
DMed the reason, using the same modal-and-reason machinery every other outcome
uses.

**One appeal per warning, inside `appealWindowDays`** — a new config key,
defaulting to 14. Past the window the button refuses with a card saying when it
closed. The check is re-derived on the click, not carried from where the button
was drawn: the DM sits in the member's inbox indefinitely, and a guard only
enforced at render time is not a guard. That is `/dev purge`'s rule and it
applies here for the same reason.

**Where the text is readable.** The review row, the audit log, and
`/mydata export`. It is the member's own words about their own conduct; an
access request that returned everything except what they wrote in their own
defence would be a strange kind of complete.

**Passive notification, by choice.** The row turns amber and the header counts
it. No ping, and no change to the reminder job. The queue is the log; an
Executive who opens it sees the appeal the same way they see everything else.

The cost is stated: an appeal filed against a queue whose rows are all decided
sits until somebody looks. Extending `reminderDue` to treat an open appeal as
unworked would close that gap and is the obvious follow-up if it turns out to
matter — but it changes when the whole team gets chased, so it is not something
to add on a guess.

---

## What is not changing

The `$bit` deviation, the hand-formatted zone confirmation, the single-process
assumption behind `withLock`, and the absence of a linter all stay as documented.
None of them came up as a defect; they came up as decisions with reasons written
down, which is what they should be.

`postReviewQueue` still sends one message per member serially. It is slow on a
long queue and it is also correct, idempotent, and the thing that makes each row
its own editable card. Parallelising it trades that for a rate-limit risk on the
one surface that must not half-post.

---

## The one open question

`appealWindowDays` runs from **when the warning was delivered**, falling back to
`issuedAt` where delivery is unknown — not from when it was issued.

The two come apart exactly where it matters. A member whose DMs are closed never
receives the warning; if the window ran from issue, it could expire before they
ever saw the thing they are entitled to contest. Running it from delivery means
an undelivered warning has no live appeal window at all, which is honest: there
is nothing yet to appeal.

Stated here rather than decided quietly, because it is a policy choice wearing an
implementation's clothes.

---

## Verification

`npm run typecheck` and `npm test` after every stage. New tests, all against
pure functions, per the existing rule that domain logic is factored out before
it is tested:

- `creditMinute` loses nothing when the write fails (stage one)
- boot reconciliation seeds `lastSeen` for kept shifts (stage one)
- the config sanity checks, as pure functions over a config object (stage two)
- the anchor-in-the-future line, at and either side of the boundary (stage two)
- appeal window open, closed, and against an undelivered warning (stage four)
- the row's delivery line in all three states (stage four)
- the headline's count with an appeal open (stage four)

Dated tests freeze `now` and pass `Pacific/Auckland`, as the rest of the suite
does.
