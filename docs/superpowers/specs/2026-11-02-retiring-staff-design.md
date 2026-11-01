# Retiring staff who are no longer on the team

## Why

Staff records are created implicitly and never retired. `StaffDoc.active` exists and most of the bot
reads it through `listActiveStaff`, but `setStaffActive` has no callers, so `active` is true for
everyone who ever held the role. People who no longer have the role stay on every leaderboard, are
assessed each fortnight, can land in the review queue, and are sent the weekly recap DM.

This makes `active` true to the facts: on the team means holding Staff tier in the public guild.

"Retired" is this document's word. Cards say "no longer on the team".

## Goals

- Someone who loses the role disappears from every current staff view at once.
- A closed week's history stays truthful about minutes that were really logged.
- Their records survive, and they return automatically if they get the role back.

## Non-goals

- Deleting anything. `DELETION.md` and the bot-record cleanup are unrelated.
- Any manual retire or keep command. The role alone decides.
- Changing what makes somebody Staff tier.

## Anti-goals

- Retiring somebody because a Discord lookup failed. Not knowing is not knowing they left.
- Retiring somebody because leave took their department role.
- Fetching the whole public guild (about 110,000 members; the gateway request is rate-limited).

## Who counts as on the team

`tierOf(member, config) !== "none"` in the public guild, so a Lead or Executive without the Moderation
role counts and a bot never does. Permissions read the public guild, as everywhere else.

| Situation | Result |
|---|---|
| Discord says the member is not in the public guild | Retire, cause `left_server`, even if on leave |
| In the guild, tier `none`, active leave or wearing the on-leave role | Stay on the team |
| In the guild, tier `none`, not on leave | Retire, cause `role_removed` |
| In the guild, has a tier, currently retired | Return |
| Lookup failed for any other reason | Change nothing |

Anyone in `BOOTSTRAP_ADMIN_IDS` is never retired, whatever the table says, including after leaving the
guild. By decision: they stay on the team, on leaderboards and assessed, with or without a role. The rule
function takes this as an input so it stays pure.

`fetchMember` (`discord/roles.ts`) returns null for every failure, so it cannot make this distinction.
This feature needs a lookup that separates Discord's "Unknown Member" answer from any other error. Hold
the rule as a pure function in `domain/`, tested, in the manner of `botRecordAction`.

Removing somebody who is on leave has no shortcut, by decision: an Executive ends the leave, which gives
their roles back and sends the usual welcome-back DM, and then removes the role.

## When it runs

- **Live:** `GuildMemberRemove` and `GuildMemberUpdate` for the public guild. Takes effect immediately,
  with no grace period. Use the cached `findStaffByDiscordId`, so non-staff cost nothing, and do not rely
  on the `before` member, which may be partial.
- **Sweep:** at boot and at week close, every staff record is fetched by id and the table above applied.
  Boot and week close must run it before the rollups and assessments that depend on it. Its first run is
  the cleanup of people already out of date; it needs no separate migration and leaves their past records
  untouched.

**The guard against a bad configuration.** `tierOf` answers `none` for a member fetched successfully when
the role keys are unset or name a deleted role, so a bad configuration looks like everybody quitting, and
cancelled leave cannot be restored.

- The sweep evaluates the whole roster before writing anything. It changes nothing and reports if no
  staff role is configured, a configured role no longer exists in the public guild, or it would retire
  more than a quarter of the roster (active, non-seeded staff).
- The live path stands down, with a logged warning, if no staff role is configured or a configured role no
  longer exists.
- An aborted sweep shows red on `/dev status` and logs an error, until a later sweep succeeds. Hold the
  decision as a pure function. This fits "configuration never refuses": it refuses nothing, it declines to
  act on a reading that looks wrong, and says so.
- A real mass removal above the threshold still works: the live path handles it as each role goes.
- **The first cleanup can legitimately cross the threshold**, since it retires everybody who has gone out of
  date since the bot began. So an aborted sweep over the threshold lists on `/dev status` who it would
  retire, with a **Retire them** button that confirms once and runs that sweep past the threshold. The
  button re-reads the roster when pressed and carries both `/dev` gates. It still refuses if a role is unset
  or deleted, and it is not a way to retire one chosen person.

## What retiring does

All of it idempotent, so the live event and the sweep can both reach the same person.

1. `active: false`, plus new `StaffDoc.retiredAt` and `retiredCause` (`role_removed` | `left_server`).
   For the first cleanup, the date is when the bot noticed. Absent reads as never retired.
2. An open shift ends at that moment and keeps its minutes, with no summary DM.
3. Five minutes later (added after this was first agreed, for two-step role swaps), pending requests, pending extensions and approved leave that has not started are closed, with "no
   longer on the team" on the leave card and any ping cleared, and nobody DMed. Reassess as any other
   leave change does. Pending leave may have been holding a review row.
4. Active leave ends only for `left_server`, without trying to restore roles and without a DM.
5. An audit row. No channel post, no ping, no DM to the member.

## Views

- **Current views** read `listActiveStaff`, so they lose the person for free: live leaderboards
  including all-time, and pickers and counts built on it. Team totals keep their minutes.
- **Closed weeks** (leaderboard log, weekly history): a retired person appears as a plain row, in rank
  order, only if they have minutes for that week. Current staff at 0 still appear. Hidden members keep
  their padlock. `/admin leaderboard-log` reposts follow the same rule, using who is retired now.
- **Team recap:** minutes count in the total. They are not in the head count, nor in the "closed their
  ring" figure.
- **Lookups:** Executives and Leads use the existing user options on `/stats`, `/warnings view` and
  `/coverage member`, and those cards say "No longer on the team since 3 Nov, role removed". No name
  search and no stored name; somebody who has left the server is reached by pasting their id, and shown
  by the existing display-name fallback. `/dev status` shows a count of retired people.
- **Their own access:** commands refuse them as they refuse anybody not on the team. Check that a retired
  member is not let through by `resolveTierAllowingLeave`, which re-grants Staff tier for active leave;
  retiring ends or leaves that leave per the table above.

## Rollups: the catch

`rebuildWeekForAll` covers active staff only, so someone retired mid-week would get no rollup for that
week and lose their history row. Week close and `/admin recompute` must also cover anyone retired, not
just those retired during the week being rebuilt, so past weeks can be rebuilt after the fact. Writing a
rollup for a retired person's zero-minute week is harmless because the history rule above hides it, but
the builder may skip it.

`deliverDueRecaps` keeps reading active staff, so the last recap is not sent. All bot DMs stop on
retirement.

## Assessment and warnings

- **Still retired when a fortnight closes:** not assessed. No row, no DM. `assessFortnight` already reads
  active staff.
- **A later re-run** assesses whoever is on the team at that moment, so somebody who has since returned
  gets a row. That is deliberate: it is how an Executive repairs an accidental removal across a close.
  Nothing happens unless somebody re-runs it.
- **Reassessment after a leave change** of an already-assessed retired person keeps working on the rows
  that exist, and creates none.
- **An undecided row:** stays in the queue, drawn as departed, can be excused or dismissed but not warned.
  `reviewRowFor` and `decisionPermitted` already do this off `active`, once something sets it.
- **New conduct warnings:** refused. `conductWarningPermitted` already treats `active === false` as
  departed; check it refuses somebody still in the server.
- **Existing warnings:** unchanged. Conduct stays permanent; activity warnings keep expiring on their
  normal clock, including while the person is away.

## Staff of the Week

- **The holder:** today's notice-only behaviour stays. An Executive decides; they stay credited unless
  removed.
- **A pending pick:** refused at handoff as today, leaving the week empty, with the notice saying so.
- `candidate.active` already refuses retired people from the draw.

## Coming back

Automatic when the role returns, via the same event or sweep. `active: true`, `retiredAt` and
`retiredCause` cleared, and the period appended to a new `StaffDoc.retiredPeriods` (`{ from, to }`).
`joinedTeamAt` does not move. `/coverage member` passes those periods as `excludedHours`, exactly as leave
is handled, so the gap is not read as quiet time and a mistaken removal costs no coverage history. Settings,
ring face, timezone, hidden status and history stay. Audit row. Cancelled leave stays cancelled.

They are assessed normally for the fortnight they return in, on the full requirement, even when they
come back partway through. An accidental removal undone before the close therefore changes nothing but
the ended shift and any cancelled leave.

`ensureStaff` must not be the path back: it writes only on insert, and a retired person is refused before
it would matter.

## Tests

Pure functions only, per `CLAUDE.md`: the table above (leave, failed lookup, unknown member, return, seeded
admin), the sweep guard (unset role, deleted role, at and over the threshold), the closed-week row rule (retired at 0 hidden, retired with minutes shown, current at 0 shown) and the team
recap's head count.

## Documentation

Update `CLAUDE.md`: the section on bot staff records says "nothing retires records", which stops being
true. Add `retiredAt`/`retiredCause`/`retiredPeriods` to `DELETION.md` if it enumerates staff fields.

## Calls made while writing this up

- Week close and `/admin recompute` cover retired people, so past weeks stay rebuildable. Not something
  the requester chose; the alternative loses history rows.
- Active leave ended by `left_server` skips role restoration, since there is no member to give them to.
- "Look up" means the existing user options on `/stats`, `/warnings view` and `/coverage member`. No name
  search, because that would mean storing and maintaining names.
- A sweep over the threshold aborts whole rather than retiring some of the roster.
- The threshold is a quarter of the roster, and the **Retire them** button on `/dev status` is the way past
  it. Without the button, the first cleanup could abort for ever.

## Left to the builder

File placement, the shape of the lookup result, how cancellation reuses `cancelLeave`/`markLeaveEnded`,
and the exact card wording beyond "no longer on the team".
