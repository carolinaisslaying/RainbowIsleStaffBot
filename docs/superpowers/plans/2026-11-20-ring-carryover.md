# Ring Carry-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the second week of a fortnight, measure a member's own ring and their leaderboard week row against the weekly target plus last week's shortfall.

**Architecture:** A pure rule in `src/domain/carryOver.ts` decides the carry and the resulting target and ring state; two async loaders beside it read last week's rollup (stored, else computed). Callers pass `carriedMinutes` into `RingCardInput`/`RingsInput`; the renderer only draws it.

**Tech Stack:** TypeScript ESM, vitest, resvg.

**Spec:** `docs/superpowers/specs/2026-11-20-ring-carryover-design.md`

## Global Constraints

- Relative imports carry `.js`. `render/` must not import `domain/` or `services/`.
- Stored `ringState`, streaks, the fortnight review, team recap and leaderboard log are untouched.
- Copy: no "streak"; ⚠️ only in `render/tiers.ts`.

## Review Focus

- Member who joined during this week: no previous week to carry from → carry 0.
- Last week exempt (leave) or this week exempt → carry 0.
- Last week over target → carry 0, never negative.
- First week of a fortnight, or a fortnight before the anchor → carry 0.
- Ring cache must not hand back an image drawn without the carry (key includes it).

---

### Task 1: Carry rule (`src/domain/carryOver.ts`, `test/carryOver.test.ts`)

**Produces:**
- `carriedShortfall(input: { weeklyTargetMinutes: number; secondWeek: boolean; assessable: boolean; thisWeekExempt: boolean; previousWeek: { activityMinutes: number; onLeave: boolean } | null }): number`
- `weekTargetFor(stats: { activityMinutes: number; onLeave: boolean }, carriedMinutes: number, config: Pick<StaffBotConfig, "weeklyTargetMinutes" | "amberThresholdPercent">): { activityTarget: number; carriedMinutes: number; state: RingState }`
- `carryIntoWeek(staff: StaffDoc, weekStart: Date, thisWeekExempt: boolean, config, now?): Promise<number>`
- `carriesIntoWeek(staff: StaffDoc[], weekStart: Date, exempt: Set<string>, config, now?): Promise<Map<string, number>>` (one rollup query, compute fallback)

Tests: 80 then week 2 → 40; 130 → 0; week 1 → 0; pre-anchor → 0; either week exempt → 0; null previous → 0; `weekTargetFor` with 90 + 40 carry → target 160, state red; 120 + 0 → green.

### Task 2: Draw it (`src/render/rings.ts`, `src/render/cards.ts`, `test/rings.test.ts`)

`RingsInput.carriedMinutes?` and `RingCardInput.carriedMinutes?`. Legend detail `"90 of 160 · 40 carried over"`; `describeRings` adds `", including 40 carried over from last week"`; `ringsCacheKey` takes `carriedMinutes`. `ringFigures` adds `-# 120 for this week, plus **40** left over from last week.` beneath the headline.

### Task 3: Wire callers

`commands/stats.ts`, `services/shiftService.ts` (both cards), `services/notifications.ts` (ring-closed DM fires at the carried target; weekly recap DM), `commands/leaderboard.ts` (week scope: per-row target; viewer rings). Fortnight and all-time scopes unchanged.

### Task 4: Verify and record

`pnpm typecheck`, `pnpm test`, render a sample PNG. Add a CLAUDE.md paragraph. Commit to main and push.
