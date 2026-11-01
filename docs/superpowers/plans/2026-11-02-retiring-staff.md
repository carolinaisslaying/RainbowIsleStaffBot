# Retiring Staff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `StaffDoc.active` true to the facts, so people who lost the role leave every current view
while their records and closed-week history survive.

**Architecture:** Pure rules in `domain/retirement.ts`; orchestration in `services/retirementService.ts`,
driven by member events and by a sweep at boot and week close. Existing `listActiveStaff` readers then
follow without change.

**Tech Stack:** TypeScript, discord.js 14, mongodb 6, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-retiring-staff-design.md`

## Global Constraints

- Relative imports carry `.js`. Cards say "no longer on the team". Threshold: more than a quarter of the
  roster (active, non-seeded).
- Retirement sends no DM. Names go through `staffDisplayName`. Tests cover pure functions only.

## Review Focus

- Leave starting: the department role comes off while the record still says `approved`. Must not retire.
- Lookup failure, as opposed to Unknown Member: must change nothing.
- A role configured then deleted: must stop the sweep and the live path.
- A retired person with minutes vs at 0 in a closed week, and a current member at 0.
- Top streak on the team recap must not name a retired person.

---

### Task 1: Rules

**Files:** Create `src/domain/retirement.ts`, `test/retirement.test.ts`; modify `src/db/types.ts`.

- [ ] Write failing tests for `retirementAction`, `isOnLeaveNow`, `staffRolesProblem`, `sweepOverThreshold`,
  `appearsInClosedWeek`, `retiredSpans`. Run and see them fail.
- [ ] Implement; run `pnpm vitest run test/retirement.test.ts`; expect PASS.

### Task 2: Records and rollups

**Files:** `src/domain/staff.ts`, `src/domain/weekly.ts`, `src/commands/admin.ts`.

- [ ] Replace `setStaffActive` with `retireStaff`/`returnStaff`; add `listAllStaff`, `countRetiredStaff`.
- [ ] `rebuildWeekFor(member, ...)` skips an empty week for a retired member with no stored row;
  `rebuildWeekForAll` and `/admin recompute` cover every record.

### Task 3: Closing out

**Files:** `src/services/leaveService.ts`, `src/services/shiftService.ts`, `src/render/leaveHistory.ts`,
`src/render/shiftHistory.ts`, `src/db/types.ts`, `src/domain/leave.ts`, `test/leaveHistory.test.ts`.

- [ ] Test the two new history lines; add shift reason `retired`; `cancelLeave` accepts `by: null`;
  `endLeave` accepts `{ kind: "retired" }` and sends no DM.

### Task 4: Service, events, boot, week close

**Files:** Create `src/services/retirementService.ts`, `src/events/retirementMembers.ts`; modify
`src/index.ts`, `src/jobs/weeklyRollup.ts`.

- [ ] `runRetirementSweep(client, config, { pastThreshold })`, `sweepOutcome()`, `applyLiveReading`.
- [ ] Sweep before `reconcileOnBoot` and at the start of `closeWeek`.

### Task 5: Views

**Files:** `src/services/leaderboardLogService.ts`, `src/domain/teamRecap.ts`,
`src/services/teamRecapService.ts`, `src/services/coverageService.ts`, `src/render/retired.ts`, `src/commands/{stats,warnings,coverage}.ts`,
`test/teamRecap.test.ts`.

- [ ] Test retired rows in `summariseTeamWeek`; filter closed weeks; line on lookups; skip retired periods.

### Task 6: `/dev status` and the button

**Files:** `src/render/configCards.ts`, `src/commands/dev.ts`, create `src/events/retireButtons.ts`, modify
`src/events/interactionCreate.ts`.

- [ ] Count, red block, **Retire them** with one confirmation, gated as `/dev` is, re-reading on each press.

### Task 7: Documentation and verification

- [ ] Update `CLAUDE.md` and `DELETION.md`. Run `pnpm typecheck`, `pnpm test`, `pnpm build`; all pass.
