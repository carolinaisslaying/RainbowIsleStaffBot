# Warnings that are not about attendance, and a log to keep them in

2026-09-02. Two things asked for together: a durable log of every warning, and
the ability for an Executive to issue one for conduct rather than for a shortfall.
They turn out to be one piece of work, because a conduct warning has nowhere to
appear today and the log is where it appears.

Every decision below was taken by the Executive who owns the deployment. Where a
decision changes existing behaviour, that is called out.

---

## What exists, and what it assumes

`WarningDoc.assessmentId` is **required**, and a lot leans on it:

- the acknowledgement button carries an assessment id, not a warning id
- `reviewRowFor` finds a warning by matching `assessmentId`
- `deleteWarningsFor(assessmentId)` is how reopen withdraws one
- `partitionByRealness` dereferences it unconditionally on the purge path
- `activeWarningCount` assumes one expiry, `config.warningExpiryDays`, for all

A conduct warning has no assessment, one expiry per tier, and no review row to be
reopened from. So this is not a new collection bolted alongside; it is the
existing record growing a second shape, and every one of those assumptions has to
be made explicit rather than left to a non-null field.

---

## The record

One `warnings` collection, as now. `WarningDoc` gains:

```ts
kind: "activity" | "conduct";
assessmentId: ObjectId | null;   // was required; null for conduct
tier: ConductTier | null;        // null for activity

withdrawnAt: Date | null;
withdrawnBy: ObjectId | null;
withdrawalReason: string | null;

logChannelId: string | null;     // where its card lives
logMessageId: string | null;
```

A document written before this change has none of them. `kind` is read as
`"activity"` when absent and `assessmentId` is present, which is true of every
warning that exists today, so nothing needs migrating.

### Tiers

Three rungs, ascending by the gravity of the conduct. Every one of them is a
formal written warning — informal correction happens in DMs and never reaches
this bot, so the ladder never uses "informal" or "minor" to mean "lesser".

| Tier | Config key | Default |
| --- | --- | --- |
| Caution | `cautionExpiryDays` | 90 |
| Misconduct | `misconductExpiryDays` | 180 |
| Serious Misconduct | `seriousMisconductExpiryDays` | 0, meaning never |

`0` means never expires, and `/config view` renders it as **never** rather than
as a zero. The bottom two are New Zealand employment terms, so they mean
something outside this bot as well.

Activity warnings keep `warningExpiryDays` (180) exactly as now.

**Severity is not weight.** Every warning counts as one, whatever its tier —
the tier decides only how long it counts for. The bot has never escalated on its
own and does not start here: nothing sums tiers into an action, and no card
suggests a next step.

---

## Counting

One total, across both kinds. `activeWarningCount` stops taking a single
`expiryDays` and starts taking the config, because each warning now expires on
its own clock:

```ts
warningIsSpent(warning, now, config)   // per-warning: kind, then tier
activeWarningCount(warnings, now, config)
```

**A withdrawn warning never counts**, whatever its clock says.

The review row's weight line gains a breakdown, because one number would lose
the distinction being drawn everywhere else:

> Would be their 3rd warning — 2 conduct, 1 activity currently count.

---

## Withdrawal

A single meaning across the whole record: a withdrawn warning is **kept, marked
withdrawn, and not counted**. Both reasons stay on it — why it was issued and
why it was taken back.

**This changes reopen.** Reopening a review row currently *deletes* the warning
it issued; it will mark it withdrawn instead. Consequences, stated plainly:

- `deleteWarningsFor` becomes `withdrawWarningsFor` and is no longer a delete.
- "Reopen is the only path that deletes a warning" stops being true — by there
  being no delete left at all, which is the stronger position. `DELETION.md` has
  to be updated to say so, and it is wrong the moment this lands otherwise.
- A member who was warned, then had it reopened, will now see a withdrawn entry
  on their own record where previously there was nothing. That is honest about
  what happened and it is a visible change for anybody it has already happened
  to.
- The row's "would be their Nth" count must skip withdrawn ones, or reopening a
  row would leave its own warning inflating the next decision about that member.

Any Executive may withdraw any warning, with a reason, through a button on its
log card. That matches how reopen already works — any Executive can reopen any
row — and means a mistake can be corrected while the person who made it is
asleep. The audit row records who did it.

---

## The log

A new config key, `warningChannelId`. Until it is set, warnings still issue
normally and only the channel copy is missing — the same way `recapChannelId`
behaves, and it is listed as recommended rather than required for that reason.

**One card per warning, edited in place** for its whole life, which is the
pattern `leaveCardFor` and `reviewRowFor` already follow. `logChannelId` and
`logMessageId` on the record are what make that possible, and one function —
`warningCardFor` — is the only thing that draws it, so colour, buttons and
record cannot disagree.

Both kinds go in it. An activity warning already has a review row, but that row
is a decision queue: organised by fortnight, not by member, and purgeable. The
log is the durable record.

Colour is the state, as everywhere else:

| State | Colour |
| --- | --- |
| Issued, not yet acknowledged | amber |
| Acknowledged | blue |
| Under appeal | amber |
| Withdrawn | grey |
| Delivery failed | red |

The card carries the member, the tier, the reason, who issued it, and the
delivery state. A withdrawal turns it grey and says so on the card itself — no
second message, because the card is the log and its colour is its state.

The one button on it is **Withdraw**, Executive-gated and asking for a reason.

---

## Issuing

`/admin warn user:` — Executive only, and the user is picked with Discord's own
picker. The command checks and opens a modal; nothing is written on the click,
because `showModal` cannot follow a defer. The modal carries:

- **Tier** — a radio group of the three rungs, each with a one-line description
- **Reason** — a paragraph box, required, 10–1500 characters

Links to messages or images go in the reason. There is no separate evidence
field: a second box would be a second thing to fill in and the reason box is
already long enough to hold a permalink.

### Who can be warned

| | |
| --- | --- |
| Moderation staff | **yes** |
| Leads | **yes** |
| Executives | **no** |
| Members who have left | **no** |
| Yourself | **no**, and unreachable anyway since Executives are not warnable |

Refusals say which rule they hit. Only Executives may issue, so an Executive
cannot be warned through this bot at all — conduct at that level is handled
outside it, deliberately.

### What the member receives

The same shape as an activity warning: a DM naming the tier and quoting the
reason, with **I have read this** and **Appeal this** beside each other.
Delivery is recorded, so the log card can say when a warning never arrived.

---

## Appeals

Unchanged: one appeal per warning, filed from the DM, inside `appealWindowDays`
counted from delivery. A conduct warning is appealable exactly as an activity
one is.

Upholding an appeal withdraws the warning — which, after this change, marks it
rather than deleting it. Declining leaves it standing and DMs the reason.

---

## The record view

`/staff warnings` gains a split, because activity and conduct are not the same
thing and a single list would say they were:

```
Warnings: Ashley
3 currently count, of 5 ever issued.

── Conduct ──────────────────────
Serious Misconduct · 12 Aug, by @You          permanent
> [reason]
Acknowledged

Caution · 3 Mar, by @Someone                  spent
> [reason]

── Activity ─────────────────────
14 Jun, by @You
> [reason]
Not acknowledged · withdrawn 20 Jun
> [withdrawal reason]

Recent fortnights: …
```

Conduct leads, because it is the more serious of the two. One total at the top.
Spent warnings are shown and marked, as now: the record stays true to the
member's own memory of it.

---

## Out of scope, deliberately

**No rehearsal.** Rehearsal exists because the fortnight assessment runs
automatically over everybody and a dry run is the only way to see what it would
do. A conduct warning is one deliberate act against one person; there is nothing
to rehearse and nothing to leave in the wrong position.

**`/dev purge` never touches a conduct warning.** It clears a fortnight's
records, and a conduct warning belongs to no fortnight. `partitionByRealness`
currently dereferences `assessmentId` unconditionally and will throw on a null
one, so it needs an explicit guard — a conduct warning is never a rehearsal's
leftovers and is never in scope for a purge.

**No evidence field, no uploads, no severity arithmetic.**

---

## Work, in order

Each stage leaves the tree green and is reviewable on its own.

**1. The record grows a shape.** `kind`, nullable `assessmentId`, `tier`,
withdrawal fields, log pointers. The three tier config keys. Pure functions for
per-warning expiry and the mixed-kind active count, with tests. Nothing user
visible yet.

**2. Withdrawal replaces deletion.** `deleteWarningsFor` becomes
`withdrawWarningsFor`; reopen marks rather than deletes; the review row's count
skips withdrawn ones; `partitionByRealness` guards the null; `DELETION.md` is
corrected. This stage changes existing behaviour and is the one to review
hardest.

**3. Issuing.** `/admin warn`, the tier modal, the eligibility rules, the DM with
acknowledge and appeal, delivery recorded. The acknowledgement button moves to
carrying a **warning** id, falling back to an assessment id so DMs already in
people's inboxes keep working.

**4. The log.** `warningChannelId`, `warningCardFor`, the card edited in place
through issued, acknowledged, appealed, withdrawn, undelivered. Activity
warnings start posting there too.

**5. The record view.** `/staff warnings` splits into Conduct and Activity with
one total; the review row's weight line gains its breakdown.

---

## Verification

`npm run typecheck` and `npm test` after every stage. New tests, all against pure
functions, per the existing rule that domain logic is factored out before it is
tested:

- each tier's expiry, including the permanent one, at and either side of its
  boundary
- the active count across a mixed record: two kinds, three tiers, one withdrawn
- a withdrawn warning counts nowhere and still appears on the record
- the review row's breakdown line at each combination of the two kinds
- eligibility: staff yes, lead yes, executive no, departed no, self no
- `partitionByRealness` with a conduct warning in the collection
- a legacy warning document with no `kind` reads as activity

Dated tests freeze `now` and pass `Pacific/Auckland`, as the rest of the suite
does.

---

## The one thing I would push back on

Making reopen mark rather than delete is right, and it has a consequence worth
being sure about: **members who have already had a warning reopened will see a
withdrawn entry appear on their record** where today they see nothing. The
records exist in `auditLog` either way, so this is a change in what is shown,
not in what is kept.

If that is unwelcome, the alternative is to mark only warnings withdrawn from
this point on and leave historical reopens as the deletions they already were —
which costs nothing to implement, and means the record has two eras. Say which
you would prefer before stage two.
