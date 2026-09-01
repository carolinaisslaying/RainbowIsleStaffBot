# Deletion procedure

The bot deletes in three places, all of them Executive-only, all of them
confirmed, and all of them writing the audit row before anything goes: **Purge
this record** on a leave card, **Reopen** on a fortnight review row, and
`/dev purge`. Everything else is removed by hand, with `mongosh`, by someone
who has decided to do it.

That one exception exists because removing a leave record was the only routine
removal, and asking an Executive to open a database shell for it meant either
the shell became routine or the removal never happened. A button that refuses
the unsafe cases and writes an audit row first is more accountable than either.

This document is the procedure for everything else, and the record of what the
buttons will and will not do.

## Reopening a review

**Reopen**, on a decided row in the fortnight review channel.

- Executive only, and it asks for a reason like every other review outcome.
- Deletes the `warnings` documents that row issued, and clears the outcome,
  the reviewer and the note from the `fortnightAssessments` document. The
  assessment itself is not deleted: the figures stand, only the decision goes.
- This is the **only** way a warning is ever removed. There is no separate
  delete, so every withdrawal is a reviewed decision with a reason attached.
- The member is told the decision was withdrawn, unless it was a dismissal:
  they were never told about that one, and announcing its reversal would raise
  the issue the silence existed to avoid.

## Scrubbing assessments that should not exist

`/dev purge [fortnight] [rerun]`, limited to the deployment's administrators rather
than to Executives, confirmed on a card that counts the records and the people
before anything is removed.

- With no `fortnight`, it takes **every fortnight before the anchor**. Those were
  written by a boot that treated an empty database as downtime and assessed four
  fortnights that closed before the deployment existed. With a `fortnight`, it
  takes exactly that one, which is how rehearsal decisions written before the
  `rehearsal` flag existed are removed.
- Deletes `fortnightAssessments` documents and the `warnings` issued from them.
  Nothing else refers to either: `weeklyStats` and the rings are rebuilt from
  `activityDays` and `shifts`, which this does not touch, so no member's figures,
  streak or leaderboard position move.
- Deletes the review's **messages** as well: the header and every row card, so a
  re-run is read on its own rather than against what is left of the last one.
  The cards are removed from the records held in memory, **before** those
  records are deleted, because the record is the only thing that knows where
  its card is.
- Writes the audit row **first**, with every record embedded including where
  each card was, and abandons the delete if that write fails. `deleteScrubbed`
  requires the receipt `recordScrubIntent` returns, so the order is a type
  error to get wrong rather than a convention. The preview is taken again on the second click
  rather than trusted from the first, and so is the permission.

## The one command that deletes

**Purge this record**, on a decided leave request in the leave log channel.

- Executive only, re-checked on the confirmation as well as on the first click.
- Removes one `leave` document. Never the `staff` record, never a rollup, never
  another leave record belonging to the same person.
- Refuses while the leave is `active` and holds roles that have not been given
  back, because `removedRoles` is the only list of what the member held. End the
  leave first, then purge.
- Names the fortnights that will lose their exemption before you confirm. Those
  fortnights are reassessed on the figures alone at the next
  `/admin recompute`, and may come out adverse.
- Writes the audit row **before** deleting, with the whole record embedded, and
  aborts the purge if that write fails. The audit log is the only way back from
  a mistaken purge.
- Edits the log card in place afterwards. The channel keeps the request and the
  decision, and gains a line saying who purged the record behind it.

Nothing else in the bot deletes anything.

## Before you start

- Deletion is irreversible. Take a dump first: `mongodump --db staffbot`.
- Work out whether you actually need deletion. `/mydata export` answers an
  access request under IPP 6 of the Privacy Act 2020 without removing anything,
  and a member leaving the team is handled by setting `active: false`, which
  retains the record.
- If the member is coming back, or might, do not delete. Set `active: false`.

## Order matters

Delete in dependency order, children before parents. Rollups are derived from
raw data, so removing `activityDays` before `weeklyStats` would leave a rollup
that a later `/admin recompute` cannot rebuild and will not remove:

1. `warnings`
2. `fortnightAssessments`
3. `leave`
4. `weeklyStats`
5. `shifts`
6. `activityDays`
7. `staff`

## Full purge of one staff member

Open a shell against the database:

```bash
docker compose exec mongo mongosh staffbot
```

Find the record and confirm you have the right person before deleting anything:

```javascript
const staff = db.staff.findOne({ discordId: "PUT_DISCORD_ID_HERE" });
printjson(staff);
```

Check `previousDiscordIds` as well: if they have been relinked, the ID you were
given may be an old one.

```javascript
db.staff.findOne({ previousDiscordIds: "PUT_DISCORD_ID_HERE" });
```

With `staff._id` confirmed, purge in order:

```javascript
const id = staff._id;

db.warnings.deleteMany({ staffId: id });
db.fortnightAssessments.deleteMany({ staffId: id });
db.leave.deleteMany({ staffId: id }); // or purge them one by one from the log
db.weeklyStats.deleteMany({ staffId: id });
db.shifts.deleteMany({ staffId: id });
db.activityDays.deleteMany({ staffId: id });
db.staff.deleteOne({ _id: id });
```

The audit log is intentionally not in that list. It records who did what, which
is an organisational record rather than the subject's own personal information,
and destroying it would remove the evidence that decisions about them were made
properly. If a specific legal request requires its removal too:

```javascript
db.auditLog.deleteMany({ targetStaffId: id });
```

Deliveries are keyed by a string containing the staff ID, so clear those as
well or the member will silently miss a recap if a record is ever recreated:

```javascript
db.deliveries.deleteMany({ _id: { $regex: id.toHexString() } });
```

## Partial purge

Removing participation history but keeping the person on the team, for example
after an agreed reset:

```javascript
const id = db.staff.findOne({ discordId: "PUT_DISCORD_ID_HERE" })._id;

db.activityDays.deleteMany({ staffId: id });
db.weeklyStats.deleteMany({ staffId: id });
db.shifts.deleteMany({ staffId: id });
```

Leave the `staff` document in place. Assessments and warnings are decisions
made about the member rather than raw participation data, so decide about them
explicitly rather than sweeping them up with the rest.

After a partial purge, rebuild the rollups so nothing stale is left behind:

```
/admin recompute weeks:8
```

## Removing only a date range

```javascript
db.activityDays.deleteMany({
    staffId: id,
    date: { $gte: "2026-09-01", $lte: "2026-09-30" }
});
```

Then `/admin recompute` over at least the affected weeks.

## demandBuckets is never in scope

`demandBuckets` holds a channel ID, a UTC hour and a message count. No user ID,
no message content, no way to attribute a row to a person. It is not personal
information and it is never part of a deletion request. Do not delete from it as
part of a purge: it is the only record of what the server's load looked like,
and removing rows silently corrupts every historical coverage heatmap.

## Verification

```javascript
const id = ObjectId("PUT_STAFF_ID_HERE");
[
    "warnings",
    "fortnightAssessments",
    "leave",
    "weeklyStats",
    "shifts",
    "activityDays"
].forEach((name) => print(name, db[name].countDocuments({ staffId: id })));
print("staff", db.staff.countDocuments({ _id: id }));
```

Every count should be zero after a full purge.
