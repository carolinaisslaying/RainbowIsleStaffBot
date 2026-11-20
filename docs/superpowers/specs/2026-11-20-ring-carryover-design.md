# Carry last week's shortfall onto the second week's ring

## Why

The fortnight review adds both weeks together, but a member's ring only ever
shows this week's target. Someone who fell short in week one has no clear sign
in week two of what they still need. This is a visual change so staff have
clearer expectations; it changes no rule.

## What changes

In the **second week of a fortnight**, a member's own ring card measures the
outer ring against `weeklyTargetMinutes + carried`, where
`carried = max(0, weeklyTargetMinutes − last week's minutes)`.

- Only a shortfall carries. A week over target carries nothing.
- Nothing carries if last week was exempt (leave), if this week is exempt (the
  ring is grey already), or if the fortnight is not assessable (before the anchor).
- The headline reads against the carried target, e.g. "**90 of 160 activity
  minutes** this week, below the minimum.", with a subtext line beneath:
  "120 for this week, plus the **40** you were short last week."
- The image's activity row reads "90 of 160 · 40 carried over"; the ring,
  percentage and accent colour are judged against 160.

Applies to: `/stats`, the shift-ended DM, the weekly recap DM, and the
leaderboard's **week** view.

On the leaderboard, ranking stays by minutes; only each row's percentage and
ring colour read against that member's own carried target, so the target becomes
per row rather than one number for the card. The **fortnight** view already
pools both weeks against twice the target and is unchanged, as is **all time**.
The leaderboard prints no target, so nothing extra is shown there.

## What does not change

- The team recap and the leaderboard log (the frozen closed-week copy in the
  Executive channel) stay on the plain weekly target.
- The stored `ringState`, "weeks in a row meeting the target", the fortnight
  review and the reminder: a week under 120 is still a missed week.

## Approaches

1. **Chosen:** a pure function (`carriedShortfall`) computes the carry from last
   week's rollup and fortnight position; the card callers pass it into
   `RingCardInput` as `carriedMinutes`, and the renderer only draws it. Keeps the
   rule testable and the renderer a leaf, as the codebase requires.
2. Change `weeklyTargetMinutes` per member in the rollup. Rejected: it would move
   stored ring states and streaks, which the change must not do.
3. Show the carry as text only, leaving the ring on 120. Rejected: the ring
   would still say "on track" while the member is behind, which is the problem.

## Left to the builder

The ring cache key must include `carriedMinutes`. Tests: the carry rule
(short, over, exempt either week, week one, pre-anchor) with a frozen `now`
in `Pacific/Auckland`, and the card text.
