# Fortnight review as a queue and a log

2026-09-02. Supersedes the first draft of this file; every open question in it
has now been answered.

## What is broken

`handleReviewButton` maps `disableButtons` over `interaction.message.components`
— every container in the message — so deciding one member greys out the buttons
on every other member in that message. All rows live in one message, so a queue
is unfinishable after a single click.

Nothing is logged where anyone can see it. `audit()` writes a row to `auditLog`
and that is all; the card is never redrawn into its outcome, so a decided row
looks abandoned rather than settled. The stored note is generated
(`"warned by X"`); no reason is ever captured from the person deciding.

Rehearsal cards carry live buttons that write real records and DM real members,
directly under a header saying nothing has been recorded against anyone.

## Shape

One message per member. The header is its own message and is edited as the queue
is worked. Each row card is edited in place for the rest of its life: awaiting a
decision, decided, reopened, decided again. The card **is** the log; there is no
second message and no separate log channel.

This is `leaveCardFor`'s pattern: one record, one card, colour is the state, and
one function draws it so colour, buttons and record cannot disagree.

```
[Fortnight 4 review]        header, edited on every decision
   12 Oct to 25 Oct
   3 below the requirement, 1 decided, 2 to go
   Decide all remaining

[Carolina]      red         awaiting a decision
   0 of 240 minutes, short by 240
   Would be their 3rd warning
   Issue warning | Excuse | Dismiss

[Ashley]        amber       warned
   Warned by @You, 2 Sep. "Third fortnight running."
   Acknowledged 2 Sep
   Reopen

[Mateo]         grey        departed, dismissed
   No longer in the server
   Dismissed by @You, 2 Sep. "Left before the fortnight closed."
   Reopen
```

## Data model

`FortnightAssessmentDoc` gains `reviewChannelId`, `reviewMessageId` (where the
row card lives) and `rehearsal?: boolean`.

`WarningDoc` gains `rehearsal?: boolean`.

New collection `fortnightReviews`, keyed by fortnight index:
`{ _id: number, headerChannelId, headerMessageId, postedAt, remindedAt }`.
The header needs somewhere to keep its message id and there is no fortnight-level
document today. This does not replace the `fortnight-announced:<index>` delivery
receipt: the receipt decides whether members are **DMed**, this records where the
cards **are**.

New config: `warningExpiryDays` (default 180) and `reviewReminderDays`
(default 3).

## Rehearsal

A rehearsal exercises the real write path, because a rehearsal that skips the
writes tests nothing. Records are written to the same collections flagged
`rehearsal: true`, and **every read that feeds a real decision filters them out**:
prior outcomes, warning counts, the warnings view, `/mydata`, the fortnight
summary. One missed filter puts a rehearsal warning on somebody's real record,
so the filter belongs in one query helper rather than at each call site.

Notifications go only to members holding the Executive role. A non-Executive's
rehearsal outcome sends nothing and the row card says so, so the tester sees what
would have happened without anyone being told.

## Deciding

All five actions — warn, excuse, dismiss, reopen, and each bulk action — open a
modal and require a written reason. A record is only worth keeping if it says
why, and reopen and bulk are the two that most need explaining. `showModal`
cannot follow a defer, so the modal is the button's only response and every write
happens on the modal submission.

- **Issue warning** — writes the `WarningDoc`, records the outcome, DMs the
  member with the reason and an **Acknowledge** button. That button is what
  finally calls `acknowledgeWarning`, which is dead code today.
- **Excuse** — records the outcome, DMs the member. No `WarningDoc`.
- **Dismiss** — records the outcome, DMs nobody. A dismissal decides that nothing
  happened; telling somebody they were considered and let off raises an issue
  they never knew existed.
- **Reopen** — clears the outcome, **deletes** any warning it issued, DMs the
  member that it was withdrawn, returns the row to the queue. This is the only
  way a warning is ever removed, so every deletion goes through a reviewed
  decision with an audit row written first. `DELETION.md` gains this path.

Warnings **count but never act**. The row card says "would be their 3rd warning"
before the click and the warnings view shows the running total, but the bot
escalates nothing by itself — the same principle as it never issuing a warning.
A warning older than `warningExpiryDays` is **spent**: still on the record, still
readable, not counted.

**Bulk.** The header carries *Decide all remaining*, offering all three outcomes.
It confirms first on a card naming every member it would affect and requires a
reason, because it writes to several people's records at once. Self-warning is
refused inside a bulk exactly as it is on a single row, and those rows are listed
as skipped rather than silently dropped.

## Permissions

Deciding is **Executive only**.

An Executive may excuse or dismiss their own row but **not warn themselves**.
Executives outrank the requirement in practice, so their assessment carries no
weight, but they are still measured and still appear in the queue: the monitoring
is the point, not the enforcement.

Leads hold an audit capacity and nothing more. They read the queue and the
warnings view; they cannot issue, excuse, dismiss or reopen. They are assessed
against the same requirement as any Moderator and appear in the queue like one.

## Queue behaviour

Only members **below** the requirement get a card; met and exempt need no
decision and still hear their outcome by DM. Ordered by **worst shortfall
first**, so the decision that most needs a human is at the top and a queue worked
halfway is worked on the right half.

A member who has left, or whose staff record is inactive, still gets a card
marked as departed. It can be excused or dismissed so the queue can be closed
out; **Issue warning is refused**, because there is nobody to serve it on.

Re-running an assessment **refreshes figures and never touches a decision**. The
card is redrawn with corrected minutes and keeps its outcome, reason and decider.
A recompute that lifts somebody from below to met is noted on the card and left
for a human to reopen if they want to.

`MAX_ROWS = 12` goes. The cap existed because forty components had to fit in one
message; one message per row has no such ceiling.

**One reminder.** `reviewReminderDays` after the queue is posted, if rows are
still undecided, one message names the count. Once, recorded on `remindedAt`,
never repeated.

## Viewing warnings

`/staff warnings [user]` — no target shows your own record at any tier; a target
is Lead and Executive only. Always ephemeral. Newest first: when, who, the
reason, whether acknowledged, whether spent, and the fortnight it came from,
followed by a short assessment history so a run of shortfalls reads as a run.
A clean record is said plainly rather than shown as an empty card.

## Testing

Pure functions first, as the repo requires, with no database or Discord fixture:

- `reviewRowState` — colour, label and which buttons are drawn, across
  undecided, each outcome, departed, rehearsal and acknowledged.
- `queueCounts` — the header line, including all-decided and none-below.
- `warningIsSpent` / `activeWarningCount` — the expiry boundary, frozen `now`.
- `decisionPermitted` — self-warning refused, self-excuse allowed, Lead refused,
  warning a departed member refused.
- `reminderDue` — fires once, not before the delay, never twice.

Cards are asserted on the serialised container for accent colour and button
custom IDs, as `test/leaveCard.test.ts` already does.

## Out of scope

- Removing the pre-anchor assessment documents the earlier flood created.
- Warnings for anything other than fortnight activity.
