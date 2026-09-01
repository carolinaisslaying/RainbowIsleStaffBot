# Fortnight review as a queue and a log

2026-09-02

## Problem

The fortnight review posts one message holding a header and up to twelve row
containers. A decision on any row is recorded in `fortnightAssessments`, but the
message is never edited: the card an Executive clicked stays showing the buttons
it had before the click. To see the current state of the queue somebody re-runs
the assessment, which posts a **new** message with the decided rows dropped.

Three things follow, and all three are the reported complaint:

1. The card in the channel disagrees with the database the moment anyone clicks
   it, so the buttons look expired even though they work. Discord custom IDs do
   not expire and `routeButton` is stateless; nothing about the buttons is
   temporary. What is temporary is the card's accuracy.
2. There is no log. A decided row is dropped from the next posting, so the
   channel records that a decision was made only for as long as nobody re-runs
   the assessment.
3. `MAX_ROWS = 12` caps a posting because of the forty-component ceiling, and
   paging past it means re-running the assessment, which until today also
   re-DMed the entire roster.

Separately, there is no way to look up what warnings a member holds.
`warningsFor` is read by `/mydata` alone, and `acknowledgeWarning` is written
but never called from anywhere.

## Shape

**One message per member.** The header stays as the queue summary. Each
below-threshold assessment gets its own message, and that message is edited in
place for the rest of its life, from awaiting a decision through to the outcome.
This is the pattern `leaveCardFor` already establishes for leave: one record,
one card, colour is the state, and one function draws it so the colour, the
buttons and the record cannot disagree.

The queue and the log are then the same object at two points in its life, which
is what makes the channel readable top to bottom: undecided cards are red and
carry buttons, decided cards carry the outcome and carry none.

```
#fortnight-review

  [Fortnight 4 review]              header, edited as decisions land
     6 Jul to 19 Jul
     3 below the requirement, 1 decided

  [Carolina]        red             awaiting a decision
     Issue warning | Excuse | Dismiss

  [Ashley]          amber           warned
     Warned by @You, 2 Sep. "Third fortnight running."
     Acknowledged 2 Sep

  [Mateo]           green           excused
     Excused by @You, 2 Sep. "Exams, told me in advance."
```

## Data model

`FortnightAssessmentDoc` gains:

- `reviewChannelId: string | null`, `reviewMessageId: string | null` — where the
  row card lives, so every later state edits that one message. Same role as
  `logChannelId`/`logMessageId` on `LeaveDoc`.

New collection `fortnightReviews`, one document per fortnight:

- `_id: number` — the fortnight index
- `headerChannelId`, `headerMessageId`
- `postedAt: Date`

The header needs a home for its message id and there is no fortnight-level
document today. Keyed by index rather than by ObjectId so posting a queue twice
is an upsert rather than a duplicate. This does not replace the
`fortnight-announced:<index>` delivery receipt: the receipt governs whether
members are **DMed**, this governs where the card **is**.

`WarningDoc` already carries `note`, `issuedBy`, `issuedAt` and
`acknowledgedAt`. No change.

## Posting and re-running

`postReviewCard` becomes `postReviewQueue`:

1. Upsert the header, editing it if `fortnightReviews` already holds its ids.
2. For each below-threshold assessment: edit its row card if
   `reviewMessageId` is set and the message still exists, otherwise post one and
   store the ids.
3. Decided rows are **not** dropped. They are rendered in their outcome state.

`MAX_ROWS` goes. The forty-component ceiling was a property of batching every
row into one message; one message per row has no such limit. A queue of sixty is
sixty messages, which is what a queue of sixty should look like.

Re-running an assessment therefore converges on the correct channel state rather
than appending a fresh copy of it. That is the same property the rollups already
claim and is what makes `/admin recompute` safe to run at any time.

A row card whose message has been deleted by hand is reposted and its ids
updated. A channel the bot has lost access to is logged and skipped, best effort,
exactly as `updateLeaveCard` handles the same case.

## Deciding

All three buttons open a modal for the note before anything is written.

- **Issue warning** — note required. Writes the `WarningDoc`, records the review
  outcome, DMs the member with the note, edits the row card into its warned
  state.
- **Excuse** — note required. Records the outcome, DMs the member, edits the
  card. No `WarningDoc`.
- **Dismiss** — note required. Records the outcome, edits the card. No DM: a
  dismissal is a decision that nothing happened, and telling somebody they were
  considered and let off is worse than not raising it.

A warning nobody explained is a warning nobody can appeal, which is why the note
is required rather than offered. `showModal` cannot follow a defer, so the modal
is the button's first and only response and the writes happen on the modal
submission. Same shape as the leave decline modal.

The member's DM carries an **Acknowledge** button, which is what finally calls
the `acknowledgeWarning` that has been sitting unused. Acknowledgement is
recorded on the `WarningDoc` and shown on the row card and in the warnings view,
so an Executive can see whether the person has read it.

The already-decided guard stays: a second click is refused rather than
overwriting the first decision. Changing a recorded outcome is not in scope.

## Permissions

Deciding stays **Executive only**, unchanged.

Leads hold an audit capacity over this and no more. They read the queue and the
warnings view, they cannot issue, excuse or dismiss, and they are themselves
assessed against the same requirement and so appear in the queue like anybody
else. `listActiveStaff` already returns every active member regardless of tier,
so no change is needed to make that true.

## Viewing warnings

`/staff warnings [user]`:

- no target — the caller's own record, any tier
- a target — Lead and Executive only

Always ephemeral. The card lists each warning newest first: when, who issued it,
the note, whether it has been acknowledged, and the fortnight it came from. Below
that, a short assessment history so a run of shortfalls reads as a run rather
than as isolated rows.

A member with a clean record is told so plainly rather than shown an empty card.

`/mydata` keeps its own warnings section. This does not replace it; it is the
lookup that does not exist yet.

## Testing

`test/` covers pure functions only and there is no database or Discord fixture,
so the decisions come out as pure functions first:

- `reviewRowState(assessment, warning)` → the colour, the label and whether
  buttons are drawn. Every outcome, plus undecided, plus acknowledged.
- `reviewQueueCounts(assessments)` → the header's "3 below, 1 decided" line,
  including the all-decided and none-below cases.
- `warningsView(warnings, assessments, viewer)` → the ordering, the empty state
  and the permission split between viewing your own and viewing another's.

Card rendering is asserted the way `test/leaveCard.test.ts` already does it: on
the serialised container, for accent colour and button custom IDs.

## Out of scope

- Changing or revoking a recorded outcome.
- Removing the assessment documents for the pre-anchor fortnights the flood
  created. That is a deletion and `DELETION.md` governs it; it needs its own
  decision.
- Warnings for anything other than fortnight activity. `WarningDoc` is tied to
  an `assessmentId` and stays that way here.
