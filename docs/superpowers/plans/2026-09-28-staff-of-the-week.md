# Staff of the Week Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each accounting week one moderator holds a Staff of the Week role that wears their own saved colour: Executives are reminded to pick, the bot hands the role over at the week boundary (drawing fairly at random when nobody picked), and the holder is recognised on the leaderboard, the team recap and `/stats`.

**Architecture:** Pure rules live in `domain/staffOfWeek.ts` (eligibility, draw, week slots, timing) and `domain/sotwColour.ts` (colour codes and role colours), both unit-tested. One `staffOfWeek` collection records each week through `domain/staffOfWeekStore.ts`. Services own everything that touches Discord: role ownership (`sotwRole`), eligibility context (`sotwContext`), notices and the reminder (`sotwNotices`), the handoff (`sotwHandoff`), Executive decisions (`sotwDecisions`), colour settings (`sotwColourService`) and preview assets (`sotwPreviewService`). The handoff runs inside `closeWeek` after the rollup and before the team recap.

**Tech Stack:** Node ≥ 26, TypeScript 5.9 ESM (`.js` import suffixes), discord.js 14.27 Components V2, MongoDB 6 driver, @resvg/resvg-js, vitest. pnpm only.

**Spec:** `docs/superpowers/specs/2026-09-27-staff-of-the-week-design.md` (approved 2026-09-28). Read it before starting any task; this plan argues from it.

## Global Constraints

- Work only on branch `feature/staff-of-the-week`. Never push. Commit after every task.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Messages are sentence case and imperative, like the existing history ("Log each closed week's leaderboard, …"). No `feat:` prefixes.
- Relative imports carry `.js`, in `test/` too.
- Components V2 only: never `content`, `embeds`, `poll` or `stickers` on a message.
- Layering: `commands`/`events` → `services` → `domain` → `db`. `render/` and `time/` are leaves and never import `services/` or `domain/`.
- Tests cover pure functions only. There is no database or Discord fixture. Date tests freeze `now` and pass an explicit zone, usually `Pacific/Auckland`.
- **🏆 means Staff of the Week and nothing else.** It is written literally only in `src/render/emoji.ts` (as `EMOJI.staffOfWeek` and the `COLOUR.staffOfWeek` entry). Everywhere else uses `EMOJI.staffOfWeek`. The standings mark becomes 📈.
- `COLOUR.staffOfWeek = 0x66d4cf` (mint).
- ⚠️ is never used; inline alerts use ❗ (`EMOJI.warning`).
- No card names a file, repository or environment variable.
- Command mentions go through `cmd()`; arguments go in the sentence beside the chip, never inside it.
- Every name the bot prints goes through `staffDisplayName`. **The one exception** is the colour preview and the picker link, which show the public-guild nickname, because that is the only place the colour is visible.
- Twemoji comes from `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/<codepoints>.png`, **always `@latest`, never a pinned version**.
- Config keys: `staffOfWeekRole` (default `""`, empty turns the feature off), `staffOfWeekChannelId` (default `""`), `staffOfWeekReminderOffsetMinutes` (default `7560`, 0–10079), `staffOfWeekColourPickerUrl` (default `""`, https only). All are `optional`.
- Receipts in `deliveries`: `sotw-reminder:<weekStartMs>`, `sotw-handoff:<weekStartMs>`, `sotw-notice:<key>`.
- Staged colour TTL is 10 minutes. The role-write cooldown is 30 seconds, and it applies only to a Save while the member holds the role.
- Scratch files go in the session scratchpad, never the repo. Never `rm -f` or glob-delete to tidy up.
- Run `pnpm typecheck` and `pnpm test` before every commit. Both must pass.

## Review Focus

Things the spec implies but no feature test naturally covers. These are the most likely to hurt a real user, most likely first. Each has a pinned test in the task named.

1. **A nickname carrying `<`, `&`, quotes or emoji** must render in the preview SVG without breaking the markup (escaped), and must survive the picker link round trip. Pinned in Task 7 (`escapes a hostile nickname`) and Task 6 (`round-trips a nickname with emoji and symbols`).
2. **A long unicode nickname** must never push the picker URL past Discord's 512-character link limit. The nickname shrinks and the ids never do. Pinned in Task 6 (`keeps the link within Discord's limit`).
3. **A pasted colour code in the wrong case, with spaces, a leading `#`, three-digit hex, or a newer version prefix** must parse where it can, and otherwise refuse with words the member can act on. Pinned in Task 4 (`tolerates how people paste`, `explains a code from a newer picker`).
4. **A closed week where everyone ties, or where nobody met the target**, must give a pool with every tied member, or an empty pool, and never a crash. Pinned in Task 5 (`keeps every member tied at the cut`, `returns nobody when nobody met the target`).
5. **A reminder offset that crosses a daylight-saving change** must land on the local wall-clock time, not on a fixed number of hours. Pinned in Task 5 (`follows the wall clock across a DST change`).

---

## File map

Created:

| File | Responsibility |
|---|---|
| `src/domain/sotwColour.ts` | Colour code parser/formatter, `roleColoursFor`, descriptions, highest icon role, Twemoji URL |
| `src/domain/staffOfWeek.ts` | Pure rules: credited holders, eligibility, draw, handoff decision, week slots, timing, status lines, recap holder, late-change cause |
| `src/domain/sotwStaging.ts` | In-memory staged colour (10 min), role-write cooldown (30 s), pending `/sotw set` choice |
| `src/domain/sotwFragment.ts` | Picker URL fragment, encoded and decoded |
| `src/domain/staffOfWeekStore.ts` | The `staffOfWeek` collection's reads and writes |
| `src/render/sotwPalette.ts` | Holographic constants and hex formatting shared by domain and render |
| `src/render/sotwPreview.ts` | Mock Discord message SVG, rasterised and cached |
| `src/render/sotwCards.ts` | Every Staff of the Week card |
| `src/render/sotwMessages.ts` | `SOTW_CONGRATULATIONS` |
| `src/services/sotwRole.ts` | Grant, remove and recolour the role; role-order facts |
| `src/services/sotwContext.ts` | Week slots, candidates, barred sets, roster, current holder |
| `src/services/sotwPreviewService.ts` | Fetch avatar and badge as data URIs; build a preview |
| `src/services/sotwNotices.ts` | Channel notices, the Executive recipient list, the reminder |
| `src/services/sotwHandoff.ts` | Handoff, boot handoff, re-assert, congratulation |
| `src/services/sotwDecisions.ts` | `/sotw set`, skip, rest of week, remove, view |
| `src/services/sotwColourService.ts` | The `/settings sotw-colour` card and Save |
| `src/services/sotwWatch.ts` | Late-change notices (leave, departure, tier) |
| `src/commands/sotw.ts` | `/sotw` |
| `src/events/sotwButtons.ts` | `sotw:*` and `sotwColour:*` buttons, `sotwCode`/`sotwRemove` modals |
| `src/events/sotwMembers.ts` | GuildMemberRemove / GuildMemberUpdate for the holder |
| `site/sotw-colour/index.html` | The colour picker page |
| `test/staffOfWeekMark.test.ts`, `test/sotwConfig.test.ts`, `test/sotwColour.test.ts`, `test/staffOfWeek.test.ts`, `test/sotwTiming.test.ts`, `test/sotwStaging.test.ts`, `test/sotwFragment.test.ts`, `test/sotwPreview.test.ts`, `test/sotwCards.test.ts`, `test/sotwRecognition.test.ts`, `test/sotwGuard.test.ts`, `test/sotwPicker.test.ts` | Tests |

Modified: `src/render/theme.ts`, `src/render/emoji.ts`, `src/db/types.ts`, `src/db/client.ts`, `src/services/notifications.ts`, `src/config/guildConfig.ts`, `src/commands/config.ts`, `src/time/calendar.ts`, `src/render/modals.ts`, `src/domain/staff.ts`, `src/jobs/index.ts`, `src/jobs/weeklyRollup.ts`, `src/commands/index.ts`, `src/events/interactionCreate.ts`, `src/commands/settings.ts`, `src/render/cards.ts`, `src/commands/leaderboard.ts`, `src/services/leaderboardLogService.ts`, `src/services/teamRecapService.ts`, `src/commands/stats.ts`, `src/services/leaveReassess.ts`, `src/index.ts`, `src/config/configGuards.ts`, `src/render/configCards.ts`, `src/commands/dev.ts`, `test/commandRequirements.test.ts`, `CLAUDE.md`, `DELETION.md`, the spec (status line).

---

### Task 1: The trophy mark and the feature's colour

**Files:**
- Modify: `src/render/theme.ts` (inside `COLOUR`, after `activityWarning`)
- Modify: `src/render/emoji.ts` (`EMOJI_FOR_COLOUR`, `EMOJI`)
- Modify: `docs/superpowers/specs/2026-09-27-staff-of-the-week-design.md:3`
- Test: `test/staffOfWeekMark.test.ts`

**Interfaces:**
- Produces: `COLOUR.staffOfWeek` (`0x66d4cf`), `EMOJI.staffOfWeek` (`"🏆"`), `emojiForColour(COLOUR.staffOfWeek) === "🏆"`, `emojiForColour(COLOUR.standings) === "📈"`.

- [ ] **Step 1: Write the failing test**

`test/staffOfWeekMark.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMOJI, emojiForColour } from "../src/render/emoji.js";
import { COLOUR } from "../src/render/theme.js";

const TROPHY = "\u{1F3C6}";

describe("the trophy means Staff of the Week and nothing else", () => {
    it("is the feature's mark, by name and from its colour", () => {
        expect(EMOJI.staffOfWeek).toBe(TROPHY);
        expect(emojiForColour(COLOUR.staffOfWeek)).toBe(TROPHY);
    });

    it("no longer marks standings", () => {
        expect(emojiForColour(COLOUR.standings)).toBe("\u{1F4C8}");
    });

    it("appears in no source file but the emoji table", async () => {
        const { readdirSync, readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
            );
        const offenders = walk("src")
            .filter((file) => file.endsWith(".ts") && !file.endsWith(join("render", "emoji.ts")))
            .filter((file) => readFileSync(file, "utf8").includes(TROPHY));
        expect(offenders).toEqual([]);
    });

    it("is not the colour of anything else", () => {
        const others = Object.entries(COLOUR).filter(([role]) => role !== "staffOfWeek");
        expect(others.map(([, value]) => value)).not.toContain(COLOUR.staffOfWeek);
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/staffOfWeekMark.test.ts`
Expected: FAIL, because `EMOJI.staffOfWeek` is undefined.

- [ ] **Step 3: Implement**

In `src/render/theme.ts`, add inside `COLOUR` after `activityWarning: 0x6f86a8`:

```ts
    activityWarning: 0x6f86a8,
    /**
     * Staff of the Week. Mint: not amber, which is the fortnight review's; not
     * red; and not the gold that standings and the Caution rung already share.
     */
    staffOfWeek: 0x66d4cf
```

In `src/render/emoji.ts`, change the standings entry and add the new colour:

```ts
    [COLOUR.personal]: "📊",
    // Standings trend upwards. The trophy used to sit here and was never drawn,
    // because the leaderboard card writes its own title; it now belongs to
    // Staff of the Week alone.
    [COLOUR.standings]: "📈",
    [COLOUR.staffOfWeek]: "🏆"
```

Add to `EMOJI`, after `hidden`:

```ts
    /**
     * Staff of the Week, beside the holder's row and on the feature's cards.
     * The only place the trophy is written; everything else uses this name,
     * and a test fails if it turns up anywhere else.
     */
    staffOfWeek: "🏆",
```

In the spec, change line 3 to:

```
Status: **approved 2026-09-28**, implementation planned in
`docs/superpowers/plans/2026-09-28-staff-of-the-week.md`. Branch: `feature/staff-of-the-week`
```

(Keep the rest of that sentence, "(never pushed to `main` …)", on the following line.)

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/staffOfWeekMark.test.ts test/emoji.test.ts test/tierPresentation.test.ts`
Expected: PASS. The existing "gives every colour in the palette one" test covers the new colour.

- [ ] **Step 5: Commit**

```bash
git add src/render/theme.ts src/render/emoji.ts test/staffOfWeekMark.test.ts docs/superpowers/specs/2026-09-27-staff-of-the-week-design.md
git commit -m "Give Staff of the Week the trophy and a mint accent; standings take the chart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Document shapes, the collection and its receipts

**Files:**
- Modify: `src/db/types.ts` (after `StaffDoc`; new fields on `StaffDoc`)
- Modify: `src/db/client.ts` (imports, `collections`, `ensureIndexes`)
- Modify: `src/services/notifications.ts` (after `claimLeaderboardLog`)

**Interfaces:**
- Produces:
  - `type SotwColour = { style: "solid"; primary: number } | { style: "gradient"; primary: number; secondary: number } | { style: "holographic" }`
  - `StaffDoc.sotwColour?: SotwColour | null`, `StaffDoc.sotwColourUpdatedAt?: Date | null`
  - `type StaffOfWeekStatus = "pending" | "picked" | "random" | "skipped" | "empty"`
  - `type StaffOfWeekEventKind`, `interface StaffOfWeekEvent`, `interface StaffOfWeekDoc`
  - `collections.staffOfWeek()`
  - `claimSotwReminder(weekStart: Date): Promise<boolean>`, `claimSotwHandoff(weekStart: Date): Promise<boolean>`, `sotwHandedOff(weekStart: Date): Promise<boolean>`, `claimSotwNotice(key: string): Promise<boolean>`

This task has no pure behaviour to test. The type checker is the gate.

- [ ] **Step 1: Add the types**

In `src/db/types.ts`, add these fields to `StaffDoc` after `ringFace`:

```ts
    /**
     * Their Staff of the Week colour: what they chose, never downgraded to what
     * the server can currently show. Absent or null is "no preference", which
     * leaves the role uncoloured while they hold it. Kept whatever happens to
     * the role — a handoff, a removal, a skip — because it is theirs.
     */
    sotwColour?: SotwColour | null;
    sotwColourUpdatedAt?: Date | null;
```

Directly above `export interface StaffDoc`, add:

```ts
/** A member's own Staff of the Week colour. `roleColoursFor` turns it into a role write. */
export type SotwColour =
    | { style: "solid"; primary: number }
    | { style: "gradient"; primary: number; secondary: number }
    | { style: "holographic" };
```

After `StaffDoc`, add:

```ts
/**
 * `pending` exists only before a week is handed off: a pick recorded ahead of
 * time. The handoff turns it into `picked`, and an undecided week into
 * `random` or `empty`. `skipped` is an Executive choosing nobody.
 */
export type StaffOfWeekStatus = "pending" | "picked" | "random" | "skipped" | "empty";

export type StaffOfWeekEventKind =
    | "set"
    | "replaced"
    | "skipped"
    | "removed"
    | "drawn"
    | "pickFailed"
    | "empty"
    | "handoff"
    | "colour"
    | "colourCleared";

export interface StaffOfWeekEvent {
    kind: StaffOfWeekEventKind;
    at: Date;
    /** Discord id of whoever did it; null for the bot. */
    actorId: string | null;
    staffId: ObjectId | null;
    reason: string | null;
    /** The draw pool, the colours applied, why a pick could not be honoured. */
    detail: Record<string, unknown> | null;
}

/**
 * One accounting week of Staff of the Week. Never deleted: a removal is an
 * event. `holders` is everyone who held the role at any point in the week and
 * `removedHolders` the subset taken off with `/sotw remove`, who are neither
 * barred nor credited — `creditedHolders` is the only reader of the two.
 *
 * The arrays and `events` are created by `$addToSet`/`$push` on first write,
 * so an older or partly written document may lack them; readers use `?? []`.
 */
export interface StaffOfWeekDoc {
    _id: ObjectId;
    weekStart: Date;
    status: StaffOfWeekStatus;
    /** The holder now, or the pending pick. Null when nobody. */
    staffId: ObjectId | null;
    /** Discord id of the Executive who decided; null for a draw or nobody. */
    decidedBy: string | null;
    decidedAt: Date | null;
    holders?: ObjectId[];
    removedHolders?: ObjectId[];
    handedOffAt: Date | null;
    events?: StaffOfWeekEvent[];
    createdAt: Date;
    updatedAt: Date;
}
```

- [ ] **Step 2: Add the collection and indexes**

In `src/db/client.ts`, add `StaffOfWeekDoc` to the type import list. Add to `collections` after `pings`:

```ts
    pings: () => db().collection<PingDoc>("pings"),
    staffOfWeek: () => db().collection<StaffOfWeekDoc>("staffOfWeek")
```

At the end of `ensureIndexes`:

```ts
    // One document per week, and every Staff of the Week read is by week start
    // or, for /stats and the export, by who held it.
    const staffOfWeek = target.collection<StaffOfWeekDoc>("staffOfWeek");
    await staffOfWeek.createIndex({ weekStart: 1 }, { unique: true });
    await staffOfWeek.createIndex({ holders: 1 });
```

- [ ] **Step 3: Add the receipts**

In `src/services/notifications.ts`, after `claimLeaderboardLog`:

```ts
/** The week's one Staff of the Week reminder to the Executives. */
export async function claimSotwReminder(weekStart: Date): Promise<boolean> {
    return claim(`sotw-reminder:${weekStart.getTime()}`);
}

/**
 * The week's one handoff. Claimed before the role moves rather than after,
 * unlike the recaps: a handoff always has something to do, even for an empty
 * week, and running one twice would move the role and DM the holder twice.
 */
export async function claimSotwHandoff(weekStart: Date): Promise<boolean> {
    return claim(`sotw-handoff:${weekStart.getTime()}`);
}

/** Whether a week's handoff has been claimed, without claiming it. */
export async function sotwHandedOff(weekStart: Date): Promise<boolean> {
    const found = await collections
        .deliveries()
        .findOne({ _id: `sotw-handoff:${weekStart.getTime()}` });
    return found !== null;
}

/** One late-change notice per subject per week, so a flapping change does not repeat. */
export async function claimSotwNotice(key: string): Promise<boolean> {
    return claim(`sotw-notice:${key}`);
}
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/db/client.ts src/services/notifications.ts
git commit -m "Add the Staff of the Week collection, the saved colour and their receipts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Configuration keys, including a URL kind

**Files:**
- Modify: `src/config/guildConfig.ts` (`StaffBotConfig`, `KeyKind`, `CONFIG_KEYS`, `DEFAULT_CONFIG`, `parseConfigValue`)
- Modify: `src/commands/config.ts:109-124` (`guildForKey`)
- Test: `test/sotwConfig.test.ts`

**Interfaces:**
- Produces: `config.staffOfWeekRole: string`, `config.staffOfWeekChannelId: string`, `config.staffOfWeekReminderOffsetMinutes: number`, `config.staffOfWeekColourPickerUrl: string`. `KeyKind` gains `"url"`.

- [ ] **Step 1: Write the failing test**

`test/sotwConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, DEFAULT_CONFIG, parseConfigValue } from "../src/config/guildConfig.js";

describe("Staff of the Week configuration", () => {
    it("ships switched off, with the reminder on Saturday morning", () => {
        expect(DEFAULT_CONFIG.staffOfWeekRole).toBe("");
        expect(DEFAULT_CONFIG.staffOfWeekChannelId).toBe("");
        expect(DEFAULT_CONFIG.staffOfWeekColourPickerUrl).toBe("");
        // 5 days 6 hours after a Monday 00:00 week start.
        expect(DEFAULT_CONFIG.staffOfWeekReminderOffsetMinutes).toBe(7560);
    });

    it("never reads as missing", () => {
        for (const key of [
            "staffOfWeekRole",
            "staffOfWeekChannelId",
            "staffOfWeekReminderOffsetMinutes",
            "staffOfWeekColourPickerUrl"
        ] as const) {
            expect(CONFIG_KEYS[key].importance).toBe("optional");
        }
    });

    it("keeps the reminder inside one week", () => {
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "0").ok).toBe(true);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "10079").ok).toBe(true);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "10080").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekReminderOffsetMinutes", "-1").ok).toBe(false);
    });

    it("takes an https address and drops any fragment", () => {
        expect(parseConfigValue("staffOfWeekColourPickerUrl", " https://colour.example.nz/pick#old ")).toEqual({
            ok: true,
            value: "https://colour.example.nz/pick"
        });
    });

    it("refuses anything that is not an https address", () => {
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "http://colour.example.nz").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "colour.example.nz").ok).toBe(false);
        expect(parseConfigValue("staffOfWeekColourPickerUrl", "javascript:alert(1)").ok).toBe(false);
    });

    it("takes the role and channel as Discord ids", () => {
        expect(parseConfigValue("staffOfWeekRole", "<@&123456789012345678>")).toEqual({
            ok: true,
            value: "123456789012345678"
        });
        expect(parseConfigValue("staffOfWeekChannelId", "<#123456789012345678>").ok).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwConfig.test.ts`
Expected: FAIL, because the defaults are undefined.

- [ ] **Step 3: Implement**

In `StaffBotConfig`, add after `warningChannelId: string;`:

```ts
    staffOfWeekRole: string;
    staffOfWeekChannelId: string;
    staffOfWeekReminderOffsetMinutes: number;
    staffOfWeekColourPickerUrl: string;
```

Change `KeyKind`:

```ts
type KeyKind =
    | "string"
    | "number"
    | "boolean"
    | "stringArray"
    | "timezone"
    | "isoDate"
    | "weekday"
    | "url";
```

In `CONFIG_KEYS`, add after `staffRankRoles`:

```ts
    staffOfWeekRole: {
        kind: "string",
        description: "Staff of the Week, in the community server. Unset turns it off",
        target: "role",
        importance: "optional",
        group: "roles",
        consequence: "Staff of the Week is off: no reminder, no handoff, no draw"
    },
```

After `warningChannelId`:

```ts
    staffOfWeekChannelId: {
        kind: "string",
        description: "Staff of the Week notices for the Executives",
        target: "channel",
        importance: "optional",
        group: "channels",
        consequence: "Staff of the Week notices are only logged"
    },
    staffOfWeekColourPickerUrl: {
        kind: "url",
        description: "The page members choose their Staff of the Week colour on",
        target: "plain",
        importance: "optional",
        group: "channels",
        consequence: "No picker link; colour codes and hex still work"
    },
```

After `reviewReminderDays`:

```ts
    staffOfWeekReminderOffsetMinutes: {
        kind: "number",
        description: "Minutes into the week that Executives are reminded to pick Staff of the Week",
        target: "plain",
        importance: "optional",
        group: "timings",
        min: 0,
        max: 10079
    },
```

In `DEFAULT_CONFIG`, after `warningChannelId: "",`:

```ts
    staffOfWeekRole: "",
    staffOfWeekChannelId: "",
    // 5 days 6 hours: Saturday 06:00 when weeks start Monday 00:00.
    staffOfWeekReminderOffsetMinutes: 7560,
    staffOfWeekColourPickerUrl: "",
```

In `parseConfigValue`, add a case before `default:`:

```ts
        case "url": {
            let parsed: URL;
            try {
                parsed = new URL(trimmed);
            } catch {
                return { ok: false, error: "Expected a full address starting https://." };
            }
            if (parsed.protocol !== "https:") {
                return { ok: false, error: "Expected an address starting https://." };
            }
            // The bot writes its own fragment on every link it builds.
            parsed.hash = "";
            return { ok: true, value: parsed.toString() };
        }
```

In `src/commands/config.ts`, `guildForKey`, add `key === "staffOfWeekChannelId" ||` to the staff-server list. Update the comment above it to read "Review, recap, leaderboard log and Staff of the Week channels, …".

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwConfig.test.ts test/configView.test.ts test/configTransfer.test.ts test/config.test.ts`
Expected: PASS. If `configView.test.ts` asserts an exact count or list of keys per group, add the new keys to that expectation. That is the only change allowed to an existing test here.

- [ ] **Step 5: Commit**

```bash
git add src/config/guildConfig.ts src/commands/config.ts test/sotwConfig.test.ts test/configView.test.ts
git commit -m "Add Staff of the Week settings, with a URL kind for the picker link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Colour codes and what goes on the role

**Files:**
- Create: `src/render/sotwPalette.ts`
- Create: `src/domain/sotwColour.ts`
- Test: `test/sotwColour.test.ts`

**Interfaces:**
- Consumes: `SotwColour` (Task 2).
- Produces (`render/sotwPalette.ts`): `HOLOGRAPHIC: { primary: 0xa9ffff; secondary: 0xffcccc; tertiary: 0xffe0a0 }`, `hexOf(value: number): string` (`"#A9FFFF"`).
- Produces (`domain/sotwColour.ts`):
  - `SOTW_CODE_VERSION = "SOTW1"`
  - `type ParsedCode = { ok: true; colour: SotwColour } | { ok: false; error: string }`
  - `parseColourCode(raw: string): ParsedCode`
  - `formatColourCode(colour: SotwColour): string`
  - `interface RoleColourWrite { primaryColor: number; secondaryColor: number | null; tertiaryColor: number | null }`
  - `roleColoursFor(pref: SotwColour | null | undefined, guildHasEnhanced: boolean): { colours: RoleColourWrite; downgraded: boolean }`
  - `downgradeNote(pref: SotwColour): string | null`
  - `describeColour(pref: SotwColour | null | undefined): string`
  - `interface IconRole { id: string; position: number; icon: string | null; unicodeEmoji: string | null }`
  - `highestIconRole<T extends IconRole>(roles: T[]): T | null`
  - `twemojiCodepoints(emoji: string): string`, `twemojiUrl(emoji: string): string`

- [ ] **Step 1: Write the failing test**

`test/sotwColour.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Constants } from "discord.js";
import {
    SOTW_CODE_VERSION,
    describeColour,
    downgradeNote,
    formatColourCode,
    highestIconRole,
    parseColourCode,
    roleColoursFor,
    twemojiCodepoints,
    twemojiUrl
} from "../src/domain/sotwColour.js";
import { HOLOGRAPHIC, hexOf } from "../src/render/sotwPalette.js";
import type { SotwColour } from "../src/db/types.js";

const solid: SotwColour = { style: "solid", primary: 0xff66aa };
const gradient: SotwColour = { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff };
const holo: SotwColour = { style: "holographic" };

describe("the colour code", () => {
    it("reads every form the picker writes", () => {
        expect(parseColourCode("SOTW1-S-FF66AA")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("SOTW1-G-FF66AA-3366FF")).toEqual({ ok: true, colour: gradient });
        expect(parseColourCode("SOTW1-H")).toEqual({ ok: true, colour: holo });
    });

    it("reads bare hex as a solid colour", () => {
        expect(parseColourCode("#FF66AA")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("ff66aa")).toEqual({ ok: true, colour: solid });
        expect(parseColourCode("#f6a")).toEqual({ ok: true, colour: solid });
    });

    it("tolerates how people paste", () => {
        expect(parseColourCode("  sotw1-g-ff66aa-3366ff\n")).toEqual({ ok: true, colour: gradient });
        expect(parseColourCode("\tSoTw1-h ")).toEqual({ ok: true, colour: holo });
    });

    it("refuses what is not a colour, in words", () => {
        for (const raw of ["", "pink", "#12345", "SOTW1-S-GGGGGG", "SOTW1-G-FF66AA", "SOTW1-X-FF66AA"]) {
            const parsed = parseColourCode(raw);
            expect(parsed.ok, raw).toBe(false);
            if (!parsed.ok) expect(parsed.error).toMatch(/colour/i);
        }
    });

    it("explains a code from a newer picker", () => {
        const parsed = parseColourCode("SOTW2-S-FF66AA");
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.error).toMatch(/newer/i);
    });

    it("writes what it reads", () => {
        for (const colour of [solid, gradient, holo]) {
            const code = formatColourCode(colour);
            expect(code.startsWith(`${SOTW_CODE_VERSION}-`)).toBe(true);
            expect(parseColourCode(code)).toEqual({ ok: true, colour });
        }
        expect(formatColourCode(solid)).toBe("SOTW1-S-FF66AA");
    });
});

describe("what goes on the role", () => {
    it("clears the role when there is no preference", () => {
        for (const pref of [null, undefined]) {
            expect(roleColoursFor(pref, true)).toEqual({
                colours: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
                downgraded: false
            });
        }
    });

    it("puts a solid colour on as it is", () => {
        expect(roleColoursFor(solid, false).colours).toEqual({
            primaryColor: 0xff66aa,
            secondaryColor: null,
            tertiaryColor: null
        });
    });

    it("keeps black visible, because Discord reads zero as no colour", () => {
        expect(roleColoursFor({ style: "solid", primary: 0 }, true).colours.primaryColor).toBe(1);
    });

    it("draws gradient and holographic in full where the server supports them", () => {
        expect(roleColoursFor(gradient, true)).toEqual({
            colours: { primaryColor: 0xff66aa, secondaryColor: 0x3366ff, tertiaryColor: null },
            downgraded: false
        });
        expect(roleColoursFor(holo, true).colours).toEqual({
            primaryColor: HOLOGRAPHIC.primary,
            secondaryColor: HOLOGRAPHIC.secondary,
            tertiaryColor: HOLOGRAPHIC.tertiary
        });
    });

    it("falls back to one colour where it does not, and says so", () => {
        const flat = roleColoursFor(gradient, false);
        expect(flat).toEqual({
            colours: { primaryColor: 0xff66aa, secondaryColor: null, tertiaryColor: null },
            downgraded: true
        });
        expect(roleColoursFor(holo, false).colours.primaryColor).toBe(HOLOGRAPHIC.primary);
        expect(downgradeNote(gradient)).toMatch(/gradient/i);
        expect(downgradeNote(holo)).toMatch(/holographic/i);
        expect(downgradeNote(solid)).toBeNull();
    });

    it("never rewrites the preference it was given", () => {
        const pref: SotwColour = { style: "gradient", primary: 1, secondary: 2 };
        const before = JSON.stringify(pref);
        roleColoursFor(pref, false);
        expect(JSON.stringify(pref)).toBe(before);
    });

    it("uses Discord's own holographic stops", () => {
        expect(HOLOGRAPHIC.primary).toBe(Constants.HolographicStyle.Primary);
        expect(HOLOGRAPHIC.secondary).toBe(Constants.HolographicStyle.Secondary);
        expect(HOLOGRAPHIC.tertiary).toBe(Constants.HolographicStyle.Tertiary);
    });

    it("describes each choice in words", () => {
        expect(describeColour(null)).toBe("No colour");
        expect(describeColour(solid)).toBe("Solid #FF66AA");
        expect(describeColour(gradient)).toBe("Gradient #FF66AA to #3366FF");
        expect(describeColour(holo)).toBe("Holographic");
        expect(hexOf(0xa)).toBe("#00000A");
    });
});

describe("the badge beside a name", () => {
    it("is the icon of the highest role that has one", () => {
        const roles = [
            { id: "1", position: 9, icon: null, unicodeEmoji: null },
            { id: "2", position: 5, icon: "abc", unicodeEmoji: null },
            { id: "3", position: 7, icon: null, unicodeEmoji: "🌈" },
            { id: "4", position: 1, icon: "def", unicodeEmoji: null }
        ];
        expect(highestIconRole(roles)?.id).toBe("3");
        expect(highestIconRole([{ id: "1", position: 1, icon: null, unicodeEmoji: null }])).toBeNull();
    });

    it("names Twemoji's file the way Twemoji does", () => {
        expect(twemojiCodepoints("🌈")).toBe("1f308");
        // A lone variation selector is dropped.
        expect(twemojiCodepoints("❤️")).toBe("2764");
        // Inside a ZWJ sequence it is kept.
        expect(twemojiCodepoints("🏳️‍🌈")).toBe("1f3f3-fe0f-200d-1f308");
    });

    it("always asks for the latest Twemoji, never a pinned version", () => {
        const url = twemojiUrl("🌈");
        expect(url).toBe("https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/1f308.png");
        expect(url).not.toMatch(/@\d/);
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwColour.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

`src/render/sotwPalette.ts`:

```ts
/**
 * Colour primitives shared by the colour rules and the preview renderer.
 *
 * Here rather than in `domain/` because `render/` is a leaf and must not import
 * from it, while the domain may import a leaf.
 */

/** Discord's fixed holographic stops (discord.js `Constants.HolographicStyle`). */
export const HOLOGRAPHIC = {
    primary: 0xa9ffff,
    secondary: 0xffcccc,
    tertiary: 0xffe0a0
} as const;

/** `#RRGGBB`, upper case, as Discord's own colour menu writes it. */
export function hexOf(value: number): string {
    return `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
}
```

`src/domain/sotwColour.ts`:

```ts
import type { SotwColour } from "../db/types.js";
import { HOLOGRAPHIC, hexOf } from "../render/sotwPalette.js";

/**
 * A member's Staff of the Week colour, as a code they can paste and as what the
 * role is given.
 *
 * The code is versioned so the picker page can change its format without
 * every code already pasted into a notes app turning into nonsense. A test
 * runs the page's own generator against this parser, so the two cannot drift.
 */

export const SOTW_CODE_VERSION = "SOTW1";

export type ParsedCode = { ok: true; colour: SotwColour } | { ok: false; error: string };

const NOT_A_COLOUR =
    "That is not a colour code. Paste the code the colour picker gave you, or a hex colour " +
    "such as #FF66AA.";

function readHex(raw: string, allowShort: boolean): number | null {
    const bare = raw.replace(/^#/, "");
    if (/^[0-9a-f]{6}$/.test(bare)) return Number.parseInt(bare, 16);
    if (allowShort && /^[0-9a-f]{3}$/.test(bare)) {
        return Number.parseInt(
            bare
                .split("")
                .map((digit) => digit + digit)
                .join(""),
            16
        );
    }
    return null;
}

export function parseColourCode(raw: string): ParsedCode {
    const value = raw.trim().toLowerCase();
    if (!value) return { ok: false, error: NOT_A_COLOUR };

    const prefix = `${SOTW_CODE_VERSION.toLowerCase()}-`;
    if (value.startsWith(prefix)) {
        const [style, ...stops] = value.slice(prefix.length).split("-");
        if (style === "s" && stops.length === 1) {
            const primary = readHex(stops[0], false);
            if (primary !== null) return { ok: true, colour: { style: "solid", primary } };
        }
        if (style === "g" && stops.length === 2) {
            const primary = readHex(stops[0], false);
            const secondary = readHex(stops[1], false);
            if (primary !== null && secondary !== null) {
                return { ok: true, colour: { style: "gradient", primary, secondary } };
            }
        }
        if (style === "h" && stops.length === 0) {
            return { ok: true, colour: { style: "holographic" } };
        }
        return { ok: false, error: NOT_A_COLOUR };
    }

    if (/^sotw\d+-/.test(value)) {
        return {
            ok: false,
            error:
                "That code came from a newer colour picker than this bot understands yet. " +
                "Paste the hex colour instead, such as #FF66AA."
        };
    }

    const primary = readHex(value, true);
    if (primary === null) return { ok: false, error: NOT_A_COLOUR };
    return { ok: true, colour: { style: "solid", primary } };
}

const bare = (value: number) => hexOf(value).slice(1);

export function formatColourCode(colour: SotwColour): string {
    switch (colour.style) {
        case "solid":
            return `${SOTW_CODE_VERSION}-S-${bare(colour.primary)}`;
        case "gradient":
            return `${SOTW_CODE_VERSION}-G-${bare(colour.primary)}-${bare(colour.secondary)}`;
        case "holographic":
            return `${SOTW_CODE_VERSION}-H`;
    }
}

export interface RoleColourWrite {
    primaryColor: number;
    secondaryColor: number | null;
    tertiaryColor: number | null;
}

/** Discord reads a primary colour of zero as "no colour", so black is nudged to one. */
const visible = (value: number) => (value === 0 ? 1 : value);

/**
 * The one function every role write goes through: the handoff, a rest-of-week
 * grant, a Save while holding, and the boot re-assert. The preference is never
 * rewritten; a server without enhanced role colours gets the nearest thing it
 * can show, and `downgraded` lets the card say so.
 */
export function roleColoursFor(
    pref: SotwColour | null | undefined,
    guildHasEnhanced: boolean
): { colours: RoleColourWrite; downgraded: boolean } {
    if (!pref) {
        return {
            colours: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
            downgraded: false
        };
    }
    switch (pref.style) {
        case "solid":
            return {
                colours: { primaryColor: visible(pref.primary), secondaryColor: null, tertiaryColor: null },
                downgraded: false
            };
        case "gradient":
            return guildHasEnhanced
                ? {
                      colours: {
                          primaryColor: visible(pref.primary),
                          secondaryColor: visible(pref.secondary),
                          tertiaryColor: null
                      },
                      downgraded: false
                  }
                : {
                      colours: { primaryColor: visible(pref.primary), secondaryColor: null, tertiaryColor: null },
                      downgraded: true
                  };
        case "holographic":
            return guildHasEnhanced
                ? {
                      colours: {
                          primaryColor: HOLOGRAPHIC.primary,
                          secondaryColor: HOLOGRAPHIC.secondary,
                          tertiaryColor: HOLOGRAPHIC.tertiary
                      },
                      downgraded: false
                  }
                : {
                      colours: { primaryColor: HOLOGRAPHIC.primary, secondaryColor: null, tertiaryColor: null },
                      downgraded: true
                  };
    }
}

/** What a member is told when the server cannot show their choice in full. */
export function downgradeNote(pref: SotwColour): string | null {
    if (pref.style === "gradient") {
        return (
            "Your gradient shows as its first colour here, because the server does not " +
            "support gradient roles."
        );
    }
    if (pref.style === "holographic") {
        return (
            "Holographic shows as a single colour here, because the server does not support " +
            "holographic roles."
        );
    }
    return null;
}

export function describeColour(pref: SotwColour | null | undefined): string {
    if (!pref) return "No colour";
    switch (pref.style) {
        case "solid":
            return `Solid ${hexOf(pref.primary)}`;
        case "gradient":
            return `Gradient ${hexOf(pref.primary)} to ${hexOf(pref.secondary)}`;
        case "holographic":
            return "Holographic";
    }
}

export interface IconRole {
    id: string;
    position: number;
    icon: string | null;
    unicodeEmoji: string | null;
}

/** Discord's own rule: a name shows the icon of the highest role that has one. */
export function highestIconRole<T extends IconRole>(roles: T[]): T | null {
    return (
        roles
            .filter((role) => role.icon || role.unicodeEmoji)
            .sort((left, right) => right.position - left.position)[0] ?? null
    );
}

/** Twemoji's file name: code points in hex, a lone U+FE0F dropped unless joined by ZWJ. */
export function twemojiCodepoints(emoji: string): string {
    const points = [...emoji].map((char) => char.codePointAt(0) as number);
    const joined = points.includes(0x200d);
    return points
        .filter((point) => joined || point !== 0xfe0f)
        .map((point) => point.toString(16))
        .join("-");
}

/**
 * Always the latest release, never a pinned one, so a newly added emoji
 * renders as soon as Twemoji draws it. jsDelivr resolves `@latest` itself.
 */
export function twemojiUrl(emoji: string): string {
    return (
        "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/" +
        `${twemojiCodepoints(emoji)}.png`
    );
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwColour.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/sotwPalette.ts src/domain/sotwColour.ts test/sotwColour.test.ts
git commit -m "Parse Staff of the Week colour codes and decide what the role wears

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Eligibility, the draw, week slots and timing

**Files:**
- Modify: `src/time/calendar.ts` (new export after `nextWeekStart`)
- Create: `src/domain/staffOfWeek.ts`
- Test: `test/staffOfWeek.test.ts`, `test/sotwTiming.test.ts`

**Interfaces:**
- Produces (`time/calendar.ts`): `addWallClockMinutes(instant: Date, minutes: number, timeZone: string): Date`
- Produces (`domain/staffOfWeek.ts`):
  - `interface HolderRecord { holders: string[]; removedHolders: string[] }` (hex ids)
  - `creditedHolders(record: HolderRecord | null): string[]`
  - `barredIds(previous: (HolderRecord | null)[]): Set<string>`
  - `interface Candidate { staffId: string; active: boolean; tier: Tier; exemptByLeave: boolean; pendingLeave: boolean }`
  - `type Refusal = "inactive" | "notStaff" | "executive" | "recentHolder" | "onLeave"`
  - `type Eligibility = { eligible: true; pendingLeave: boolean } | { eligible: false; reason: Refusal }`
  - `eligibilityFor(candidate: Candidate, barred: Set<string>): Eligibility`
  - `isHardRefusal(eligibility: Eligibility): boolean`
  - `refusalText(reason: Refusal, name: string): string`
  - `PENDING_LEAVE_NOTE: string`
  - `interface Standing { staffId: string; minutes: number }`
  - `drawPool(standings: Standing[], target: number, eligibility: Map<string, Eligibility>): Standing[]`
  - `draw<T>(pool: readonly T[], rng: () => number): T | null`
  - `type HandoffDecision = { kind: "picked"; staffId: string } | { kind: "random"; staffId: string } | { kind: "skipped" } | { kind: "empty" }`
  - `decideHandoff(input: { week: { status: StaffOfWeekStatus; staffId: string | null } | null; pickEligibility: Eligibility | null; pool: Standing[]; rng: () => number }): { decision: HandoffDecision; pickFailed: Refusal | null }`
  - `HANDOFF_GRACE_MS = 3_600_000`
  - `handoffSettled(input: { claimed: boolean; now: Date; weekStart: Date }): boolean`
  - `targetWeeks(input: { previousStart: Date; currentStart: Date; nextStart: Date; currentHandedOff: boolean }): { current: Date; next: Date }`
  - `isHolding(status: StaffOfWeekStatus): boolean`
  - `restOfWeekOffered(current: { status: StaffOfWeekStatus; staffId: string | null } | null, handedOff: boolean): boolean`
  - `nextReminderAt(from: Date, rules: { timeZone: string; weekStartDay: number; offsetMinutes: number }): Date`
  - `reminderTimeFor(weekStart: Date, rules: { timeZone: string; offsetMinutes: number }): Date`
  - `type ColourStatus = "holding" | "saved" | "executive"`
  - `colourStatus(input: { holding: boolean; tier: Tier }): ColourStatus`
  - `COLOUR_COOLDOWN_MS = 30_000`, `cooldownRemainingMs(lastAt: number | undefined, now: number): number`
  - `timesHeld(records: (HolderRecord & { weekStart: Date })[], staffId: string): { count: number; last: Date | null }`
  - `recapHolder(input: { recapWeekEnd: Date; currentWeekStart: Date; nextWeek: { status: StaffOfWeekStatus; staffId: string | null } | null }): string | null`
  - `type LateCause = "left" | "notStaff" | "executive"`
  - `lateCauseFor(input: { present: boolean; tier: Tier }): LateCause | null`
  - `sotwEnabled(config: { staffOfWeekRole: string }): boolean`

- [ ] **Step 1: Write the failing tests**

`test/staffOfWeek.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    barredIds,
    creditedHolders,
    decideHandoff,
    draw,
    drawPool,
    eligibilityFor,
    isHardRefusal,
    refusalText,
    type Candidate,
    type Eligibility
} from "../src/domain/staffOfWeek.js";

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
    staffId: "a",
    active: true,
    tier: "staff",
    exemptByLeave: false,
    pendingLeave: false,
    ...overrides
});

describe("who held it", () => {
    it("credits everyone who held it except those removed", () => {
        expect(creditedHolders({ holders: ["a", "b"], removedHolders: ["a"] })).toEqual(["b"]);
        expect(creditedHolders(null)).toEqual([]);
    });

    it("bars the credited holders of the two weeks before, and nobody for a skipped or empty week", () => {
        const barred = barredIds([
            { holders: ["a", "b"], removedHolders: ["a"] },
            { holders: [], removedHolders: [] },
            null
        ]);
        expect([...barred]).toEqual(["b"]);
    });
});

describe("eligibility", () => {
    it("refuses in the spec's order", () => {
        const everything = candidate({ active: false, tier: "executive", exemptByLeave: true });
        expect(eligibilityFor(everything, new Set(["a"]))).toEqual({ eligible: false, reason: "inactive" });
        expect(eligibilityFor(candidate({ tier: "none", exemptByLeave: true }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "notStaff"
        });
        expect(eligibilityFor(candidate({ tier: "executive" }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "executive"
        });
        expect(eligibilityFor(candidate({ exemptByLeave: true }), new Set(["a"]))).toEqual({
            eligible: false,
            reason: "recentHolder"
        });
        expect(eligibilityFor(candidate({ exemptByLeave: true }), new Set())).toEqual({
            eligible: false,
            reason: "onLeave"
        });
    });

    it("admits Staff and Leads, flagging pending leave rather than refusing it", () => {
        expect(eligibilityFor(candidate({ tier: "lead" }), new Set())).toEqual({ eligible: true, pendingLeave: false });
        expect(eligibilityFor(candidate({ pendingLeave: true }), new Set())).toEqual({
            eligible: true,
            pendingLeave: true
        });
    });

    it("treats only the first three refusals as hard", () => {
        expect(isHardRefusal({ eligible: false, reason: "notStaff" })).toBe(true);
        expect(isHardRefusal({ eligible: false, reason: "onLeave" })).toBe(false);
        expect(isHardRefusal({ eligible: true, pendingLeave: false })).toBe(false);
    });

    it("words every refusal for the Executive reading it", () => {
        for (const reason of ["inactive", "notStaff", "executive", "recentHolder", "onLeave"] as const) {
            expect(refusalText(reason, "Robin")).toContain("**Robin**");
        }
    });
});

describe("the draw", () => {
    const yes: Eligibility = { eligible: true, pendingLeave: false };
    const all = (ids: string[], value: Eligibility = yes) => new Map(ids.map((id) => [id, value]));

    it("takes the top three who met the target", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 300 },
                { staffId: "b", minutes: 250 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 150 },
                { staffId: "e", minutes: 100 }
            ],
            120,
            all(["a", "b", "c", "d", "e"])
        );
        expect(pool.map((row) => row.staffId)).toEqual(["a", "b", "c"]);
    });

    it("keeps every member tied at the cut", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 200 },
                { staffId: "b", minutes: 200 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 200 },
                { staffId: "e", minutes: 199 }
            ],
            120,
            all(["a", "b", "c", "d", "e"])
        );
        expect(pool.map((row) => row.staffId).sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("leaves out anyone ineligible or with pending leave", () => {
        const eligibility = new Map<string, Eligibility>([
            ["a", { eligible: false, reason: "recentHolder" }],
            ["b", { eligible: true, pendingLeave: true }],
            ["c", yes]
        ]);
        const pool = drawPool(
            [
                { staffId: "a", minutes: 300 },
                { staffId: "b", minutes: 250 },
                { staffId: "c", minutes: 200 },
                { staffId: "d", minutes: 500 }
            ],
            120,
            eligibility
        );
        expect(pool.map((row) => row.staffId)).toEqual(["c"]);
    });

    it("draws from a thin week", () => {
        const pool = drawPool([{ staffId: "a", minutes: 130 }], 120, all(["a"]));
        expect(draw(pool, () => 0.99)?.staffId).toBe("a");
    });

    it("returns nobody when nobody met the target", () => {
        const pool = drawPool(
            [
                { staffId: "a", minutes: 0 },
                { staffId: "b", minutes: 0 }
            ],
            120,
            all(["a", "b"])
        );
        expect(pool).toEqual([]);
        expect(draw(pool, () => 0.5)).toBeNull();
    });

    it("is uniform over the pool with the rng given", () => {
        const pool = ["a", "b", "c"];
        expect(draw(pool, () => 0)).toBe("a");
        expect(draw(pool, () => 0.34)).toBe("b");
        expect(draw(pool, () => 0.999999)).toBe("c");
        expect(draw(pool, () => 1)).toBe("c");
    });
});

describe("the handoff decision", () => {
    const pool = [{ staffId: "z", minutes: 300 }];

    it("honours a pick that can still hold it, late leave included", () => {
        expect(
            decideHandoff({
                week: { status: "pending", staffId: "p" },
                pickEligibility: { eligible: false, reason: "onLeave" },
                pool,
                rng: () => 0
            })
        ).toEqual({ decision: { kind: "picked", staffId: "p" }, pickFailed: null });
    });

    it("falls back to the draw when the pick can no longer hold it at all", () => {
        expect(
            decideHandoff({
                week: { status: "pending", staffId: "p" },
                pickEligibility: { eligible: false, reason: "notStaff" },
                pool,
                rng: () => 0
            })
        ).toEqual({ decision: { kind: "random", staffId: "z" }, pickFailed: "notStaff" });
    });

    it("hands a skipped week to nobody and never draws", () => {
        expect(
            decideHandoff({ week: { status: "skipped", staffId: null }, pickEligibility: null, pool, rng: () => 0 })
                .decision
        ).toEqual({ kind: "skipped" });
    });

    it("draws for an undecided week, and records nobody when the pool is empty", () => {
        expect(decideHandoff({ week: null, pickEligibility: null, pool, rng: () => 0 }).decision).toEqual({
            kind: "random",
            staffId: "z"
        });
        expect(decideHandoff({ week: null, pickEligibility: null, pool: [], rng: () => 0 }).decision).toEqual({
            kind: "empty"
        });
    });
});
```

`test/sotwTiming.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addWallClockMinutes } from "../src/time/calendar.js";
import {
    colourStatus,
    cooldownRemainingMs,
    handoffSettled,
    lateCauseFor,
    nextReminderAt,
    recapHolder,
    restOfWeekOffered,
    sotwEnabled,
    targetWeeks,
    timesHeld
} from "../src/domain/staffOfWeek.js";

const at = (iso: string) => new Date(iso);

describe("the reminder", () => {
    const utc = { timeZone: "UTC", weekStartDay: 1, offsetMinutes: 7560 };

    it("lands on Saturday 06:00 with the shipped settings", () => {
        // Monday 2026-09-28 is a week start.
        expect(nextReminderAt(at("2026-09-28T09:00:00Z"), utc)).toEqual(at("2026-10-03T06:00:00Z"));
    });

    it("rolls to next week once this week's has passed", () => {
        expect(nextReminderAt(at("2026-10-03T06:00:00Z"), utc)).toEqual(at("2026-10-10T06:00:00Z"));
    });

    it("follows the wall clock across a DST change", () => {
        // Auckland moves to NZDT at 02:00 on Sunday 2026-09-27. The week
        // starting Monday 2026-09-21 00:00 NZST is 2026-09-20T12:00Z; 6 days 10
        // hours on the wall clock is Sunday 10:00 NZDT, 2026-09-26T21:00Z — an
        // hour earlier than adding 154 hours would give.
        const rules = { timeZone: "Pacific/Auckland", weekStartDay: 1, offsetMinutes: 6 * 1440 + 600 };
        expect(nextReminderAt(at("2026-09-21T00:00:00Z"), rules)).toEqual(at("2026-09-26T21:00:00Z"));
        expect(addWallClockMinutes(at("2026-09-20T12:00:00Z"), 6 * 1440 + 600, "Pacific/Auckland")).toEqual(
            at("2026-09-26T21:00:00Z")
        );
    });

    it("moves with weekStartDay", () => {
        const sunday = { timeZone: "UTC", weekStartDay: 0, offsetMinutes: 60 };
        expect(nextReminderAt(at("2026-09-28T09:00:00Z"), sunday)).toEqual(at("2026-10-04T01:00:00Z"));
    });
});

describe("which week a decision is about", () => {
    const previousStart = at("2026-09-21T00:00:00Z");
    const currentStart = at("2026-09-28T00:00:00Z");
    const nextStart = at("2026-10-05T00:00:00Z");

    it("is next week once this week has been handed off", () => {
        expect(targetWeeks({ previousStart, currentStart, nextStart, currentHandedOff: true })).toEqual({
            current: currentStart,
            next: nextStart
        });
    });

    it("is the week about to be handed off in the minutes before it is", () => {
        expect(targetWeeks({ previousStart, currentStart, nextStart, currentHandedOff: false })).toEqual({
            current: previousStart,
            next: currentStart
        });
    });

    it("counts a week as settled once handed off, or an hour in whatever happened", () => {
        expect(handoffSettled({ claimed: true, now: at("2026-09-28T00:01:00Z"), weekStart: currentStart })).toBe(true);
        expect(handoffSettled({ claimed: false, now: at("2026-09-28T00:02:00Z"), weekStart: currentStart })).toBe(
            false
        );
        expect(handoffSettled({ claimed: false, now: at("2026-09-28T01:00:00Z"), weekStart: currentStart })).toBe(
            true
        );
    });

    it("offers the rest of this week only when nobody holds it", () => {
        expect(restOfWeekOffered(null, true)).toBe(true);
        expect(restOfWeekOffered({ status: "empty", staffId: null }, true)).toBe(true);
        expect(restOfWeekOffered({ status: "skipped", staffId: null }, true)).toBe(true);
        expect(restOfWeekOffered({ status: "picked", staffId: "a" }, true)).toBe(false);
        expect(restOfWeekOffered(null, false)).toBe(false);
    });
});

describe("the colour card", () => {
    it("says what saving will do", () => {
        expect(colourStatus({ holding: true, tier: "staff" })).toBe("holding");
        expect(colourStatus({ holding: false, tier: "lead" })).toBe("saved");
        expect(colourStatus({ holding: false, tier: "executive" })).toBe("executive");
    });

    it("cools a holder's role writes for thirty seconds", () => {
        expect(cooldownRemainingMs(undefined, 1000)).toBe(0);
        expect(cooldownRemainingMs(1000, 11_000)).toBe(20_000);
        expect(cooldownRemainingMs(1000, 31_000)).toBe(0);
    });
});

describe("recognition", () => {
    it("counts credited weeks only", () => {
        const records = [
            { weekStart: at("2026-09-07T00:00:00Z"), holders: ["a"], removedHolders: [] },
            { weekStart: at("2026-09-14T00:00:00Z"), holders: ["a", "b"], removedHolders: ["a"] },
            { weekStart: at("2026-09-28T00:00:00Z"), holders: ["a"], removedHolders: [] }
        ];
        expect(timesHeld(records, "a")).toEqual({ count: 2, last: at("2026-09-28T00:00:00Z") });
        expect(timesHeld(records, "c")).toEqual({ count: 0, last: null });
    });

    it("names the new holder on the recap of the week that just closed, and no other", () => {
        const currentWeekStart = at("2026-09-28T00:00:00Z");
        const nextWeek = { status: "random" as const, staffId: "a" };
        expect(recapHolder({ recapWeekEnd: currentWeekStart, currentWeekStart, nextWeek })).toBe("a");
        expect(recapHolder({ recapWeekEnd: at("2026-09-21T00:00:00Z"), currentWeekStart, nextWeek })).toBeNull();
        expect(
            recapHolder({ recapWeekEnd: currentWeekStart, currentWeekStart, nextWeek: { status: "empty", staffId: null } })
        ).toBeNull();
    });
});

describe("late changes and the switch", () => {
    it("names why a holder can no longer hold it", () => {
        expect(lateCauseFor({ present: false, tier: "none" })).toBe("left");
        expect(lateCauseFor({ present: true, tier: "none" })).toBe("notStaff");
        expect(lateCauseFor({ present: true, tier: "executive" })).toBe("executive");
        expect(lateCauseFor({ present: true, tier: "lead" })).toBeNull();
    });

    it("is off while the role is unset", () => {
        expect(sotwEnabled({ staffOfWeekRole: "" })).toBe(false);
        expect(sotwEnabled({ staffOfWeekRole: "123" })).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm vitest run test/staffOfWeek.test.ts test/sotwTiming.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement**

In `src/time/calendar.ts`, after `nextWeekStart`:

```ts
/**
 * Move an instant along the local wall clock by whole minutes. A DST change in
 * between moves the result with the clock, so "Saturday 06:00" stays 06:00.
 * `zonedToUtc` normalises minutes past 59 the way Date.UTC does.
 */
export function addWallClockMinutes(instant: Date, minutes: number, timeZone: string): Date {
    const wall = wallClockIn(instant, timeZone);
    return zonedToUtc(
        {
            year: wall.year,
            month: wall.month,
            day: wall.day,
            hour: wall.hour,
            minute: wall.minute + minutes,
            second: wall.second
        },
        timeZone
    );
}
```

`src/domain/staffOfWeek.ts`:

```ts
import type { StaffOfWeekStatus } from "../db/types.js";
import type { Tier } from "./permissions.js";
import { addWallClockMinutes, nextWeekStart, weekStartFor } from "../time/calendar.js";

/**
 * Staff of the Week, as pure rules.
 *
 * Every surface — `/sotw set`, the random draw, the reminder's list, `/sotw
 * view` — asks `eligibilityFor`, so they cannot disagree about who may hold it.
 * Ids are hex strings here so nothing in this file needs a database.
 */

export function sotwEnabled(config: { staffOfWeekRole: string }): boolean {
    return config.staffOfWeekRole !== "";
}

export interface HolderRecord {
    holders: string[];
    removedHolders: string[];
}

/** Held the role in the week and was not taken off it. The only reader of the two lists. */
export function creditedHolders(record: HolderRecord | null): string[] {
    if (!record) return [];
    const removed = new Set(record.removedHolders);
    return record.holders.filter((id) => !removed.has(id));
}

/** The credited holders of the two week slots before the one being assigned. */
export function barredIds(previous: (HolderRecord | null)[]): Set<string> {
    return new Set(previous.flatMap((record) => creditedHolders(record)));
}

export interface Candidate {
    staffId: string;
    active: boolean;
    /** Resolved in the public guild; `none` covers somebody who has left it. */
    tier: Tier;
    /** Approved or active leave exempts the week. */
    exemptByLeave: boolean;
    /** Leave waiting on a decision would exempt the week if approved. */
    pendingLeave: boolean;
}

export type Refusal = "inactive" | "notStaff" | "executive" | "recentHolder" | "onLeave";

export type Eligibility =
    | { eligible: true; pendingLeave: boolean }
    | { eligible: false; reason: Refusal };

export function eligibilityFor(candidate: Candidate, barred: Set<string>): Eligibility {
    if (!candidate.active) return { eligible: false, reason: "inactive" };
    if (candidate.tier === "none") return { eligible: false, reason: "notStaff" };
    if (candidate.tier === "executive") return { eligible: false, reason: "executive" };
    if (barred.has(candidate.staffId)) return { eligible: false, reason: "recentHolder" };
    if (candidate.exemptByLeave) return { eligible: false, reason: "onLeave" };
    return { eligible: true, pendingLeave: candidate.pendingLeave };
}

/**
 * The refusals that make a recorded pick impossible to honour at the handoff.
 * Late leave is not one of them: the Executives were already told who it
 * would be, and changing it is their call.
 */
const HARD: readonly Refusal[] = ["inactive", "notStaff", "executive"];

export function isHardRefusal(eligibility: Eligibility): boolean {
    return !eligibility.eligible && HARD.includes(eligibility.reason);
}

export function refusalText(reason: Refusal, name: string): string {
    switch (reason) {
        case "inactive":
            return `**${name}** has no active staff record.`;
        case "notStaff":
            return `**${name}** is not Moderation staff in the community server, or has left it.`;
        case "executive":
            return `**${name}** is an Executive, and Executives are never Staff of the Week.`;
        case "recentHolder":
            return (
                `**${name}** held Staff of the Week in one of the two weeks before, so they ` +
                "cannot hold it again yet."
            );
        case "onLeave":
            return `**${name}** has enough approved leave that week to be exempt from it.`;
    }
}

export const PENDING_LEAVE_NOTE = "has leave awaiting a decision for that week";

export interface Standing {
    staffId: string;
    minutes: number;
}

/**
 * Who the draw chooses between: the closed week's top three who met the
 * target and may hold it, plus everybody tied with the third, so a tie at the
 * cut never decides who is in. Pending leave skips the draw, so the bot never
 * hands the role to somebody who is probably away.
 */
export function drawPool(
    standings: Standing[],
    target: number,
    eligibility: Map<string, Eligibility>
): Standing[] {
    const qualifying = standings
        .filter((row) => row.minutes >= target)
        .filter((row) => {
            const verdict = eligibility.get(row.staffId);
            return verdict?.eligible === true && !verdict.pendingLeave;
        })
        .sort((left, right) => right.minutes - left.minutes || left.staffId.localeCompare(right.staffId));
    if (qualifying.length <= 3) return qualifying;
    const cut = qualifying[2].minutes;
    return qualifying.filter((row) => row.minutes >= cut);
}

/** One uniformly at random. `rng` is injected so tests are deterministic. */
export function draw<T>(pool: readonly T[], rng: () => number): T | null {
    if (pool.length === 0) return null;
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

export type HandoffDecision =
    | { kind: "picked"; staffId: string }
    | { kind: "random"; staffId: string }
    | { kind: "skipped" }
    | { kind: "empty" };

export function decideHandoff(input: {
    week: { status: StaffOfWeekStatus; staffId: string | null } | null;
    pickEligibility: Eligibility | null;
    pool: Standing[];
    rng: () => number;
}): { decision: HandoffDecision; pickFailed: Refusal | null } {
    if (input.week?.status === "skipped") return { decision: { kind: "skipped" }, pickFailed: null };

    let pickFailed: Refusal | null = null;
    if (input.week?.status === "pending" && input.week.staffId) {
        const verdict = input.pickEligibility;
        if (verdict && isHardRefusal(verdict) && !verdict.eligible) {
            pickFailed = verdict.reason;
        } else {
            return { decision: { kind: "picked", staffId: input.week.staffId }, pickFailed: null };
        }
    }

    const chosen = draw(input.pool, input.rng);
    return {
        decision: chosen ? { kind: "random", staffId: chosen.staffId } : { kind: "empty" },
        pickFailed
    };
}

/**
 * How long after a week starts it counts as handed off even without a
 * receipt: a deployment that switched the feature on mid-week, or whose
 * handoff never ran, must not keep targeting a week that has already begun.
 */
export const HANDOFF_GRACE_MS = 3_600_000;

export function handoffSettled(input: { claimed: boolean; now: Date; weekStart: Date }): boolean {
    return input.claimed || input.now.getTime() - input.weekStart.getTime() >= HANDOFF_GRACE_MS;
}

/**
 * Which week `/sotw set` and `/sotw skip` are about. Before the calendar
 * week's handoff has run — the minutes between 00:00 and the 00:05 close — the
 * week about to be handed off is still "next", or a pick made at 00:02 would
 * land a week late and leave this one to the draw.
 */
export function targetWeeks(input: {
    previousStart: Date;
    currentStart: Date;
    nextStart: Date;
    currentHandedOff: boolean;
}): { current: Date; next: Date } {
    return input.currentHandedOff
        ? { current: input.currentStart, next: input.nextStart }
        : { current: input.previousStart, next: input.currentStart };
}

export function isHolding(status: StaffOfWeekStatus): boolean {
    return status === "picked" || status === "random";
}

/** Somebody could be given the rest of this week: it is handed off and nobody holds it. */
export function restOfWeekOffered(
    current: { status: StaffOfWeekStatus; staffId: string | null } | null,
    handedOff: boolean
): boolean {
    if (!handedOff) return false;
    return !current || current.staffId === null || !isHolding(current.status);
}

export function reminderTimeFor(
    weekStart: Date,
    rules: { timeZone: string; offsetMinutes: number }
): Date {
    return addWallClockMinutes(weekStart, rules.offsetMinutes, rules.timeZone);
}

export function nextReminderAt(
    from: Date,
    rules: { timeZone: string; weekStartDay: number; offsetMinutes: number }
): Date {
    const current = weekStartFor(from, rules.timeZone, rules.weekStartDay);
    const thisWeek = reminderTimeFor(current, rules);
    if (thisWeek > from) return thisWeek;
    return reminderTimeFor(nextWeekStart(current, rules.timeZone, rules.weekStartDay), rules);
}

export type ColourStatus = "holding" | "saved" | "executive";

export function colourStatus(input: { holding: boolean; tier: Tier }): ColourStatus {
    if (input.holding) return "holding";
    return input.tier === "executive" ? "executive" : "saved";
}

export const COLOUR_COOLDOWN_MS = 30_000;

export function cooldownRemainingMs(lastAt: number | undefined, now: number): number {
    if (lastAt === undefined) return 0;
    return Math.max(0, lastAt + COLOUR_COOLDOWN_MS - now);
}

export function timesHeld(
    records: (HolderRecord & { weekStart: Date })[],
    staffId: string
): { count: number; last: Date | null } {
    const held = records
        .filter((record) => creditedHolders(record).includes(staffId))
        .map((record) => record.weekStart)
        .sort((left, right) => left.getTime() - right.getTime());
    return { count: held.length, last: held.at(-1) ?? null };
}

/**
 * The holder the team recap names: whoever holds the week that has just
 * begun, and only on the recap of the week that has just closed. A recap
 * posted during catch-up for an older week names nobody.
 */
export function recapHolder(input: {
    recapWeekEnd: Date;
    currentWeekStart: Date;
    nextWeek: { status: StaffOfWeekStatus; staffId: string | null } | null;
}): string | null {
    if (input.recapWeekEnd.getTime() !== input.currentWeekStart.getTime()) return null;
    if (!input.nextWeek || !isHolding(input.nextWeek.status)) return null;
    return input.nextWeek.staffId;
}

export type LateCause = "left" | "notStaff" | "executive";

/** Why the current holder can no longer hold it, or null when they still can. */
export function lateCauseFor(input: { present: boolean; tier: Tier }): LateCause | null {
    if (!input.present) return "left";
    if (input.tier === "none") return "notStaff";
    if (input.tier === "executive") return "executive";
    return null;
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/staffOfWeek.test.ts test/sotwTiming.test.ts test/calendar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/time/calendar.ts src/domain/staffOfWeek.ts test/staffOfWeek.test.ts test/sotwTiming.test.ts
git commit -m "Decide who may hold Staff of the Week, how the draw picks, and when

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Staging, the cooldown and the picker link

**Files:**
- Create: `src/domain/sotwStaging.ts`
- Create: `src/domain/sotwFragment.ts`
- Test: `test/sotwStaging.test.ts`, `test/sotwFragment.test.ts`

**Interfaces:**
- Consumes: `cooldownRemainingMs` (Task 5), `formatColourCode`, `parseColourCode` (Task 4).
- Produces (`sotwStaging.ts`): `STAGE_TTL_MS`, `stageColour(discordId: string, colour: SotwColour | null, now?: number): void`, `stagedColour(discordId: string, now?: number): { colour: SotwColour | null } | null`, `clearStaged(discordId: string): void`, `noteRoleWrite(discordId: string, now?: number): void`, `roleWriteCooldown(discordId: string, now?: number): number`, `stageSet(actorId: string, staffId: string, reason: string | null, now?: number): void`, `takeSet(actorId: string, now?: number): { staffId: string; reason: string | null } | null`, `resetSotwStaging(): void`.
- Produces (`sotwFragment.ts`): `URL_LIMIT = 512`, `interface PickerFragmentInput { nickname: string; userId: string; guildId: string; avatarHash: string | null; guildAvatar: boolean; roleId: string | null; iconHash: string | null; emoji: string | null; colour: SotwColour | null; enhanced: boolean }`, `pickerFragment(input: PickerFragmentInput): string`, `pickerUrl(base: string, input: PickerFragmentInput): string`, `readFragment(fragment: string): PickerFragmentInput | null`.

The fragment keys are `v n u g a ga r i e c x`. The page (Task 19) reads the same keys.

- [ ] **Step 1: Write the failing tests**

`test/sotwStaging.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
    STAGE_TTL_MS,
    clearStaged,
    noteRoleWrite,
    resetSotwStaging,
    roleWriteCooldown,
    stageColour,
    stageSet,
    stagedColour,
    takeSet
} from "../src/domain/sotwStaging.js";

beforeEach(() => resetSotwStaging());

describe("a staged colour", () => {
    it("is held for ten minutes for the person who staged it", () => {
        stageColour("u1", { style: "solid", primary: 1 }, 0);
        expect(stagedColour("u1", STAGE_TTL_MS - 1)).toEqual({ colour: { style: "solid", primary: 1 } });
        expect(stagedColour("u2", 1)).toBeNull();
        expect(stagedColour("u1", STAGE_TTL_MS)).toBeNull();
    });

    it("can stage no colour at all, which is different from nothing staged", () => {
        stageColour("u1", null, 0);
        expect(stagedColour("u1", 1)).toEqual({ colour: null });
        clearStaged("u1");
        expect(stagedColour("u1", 1)).toBeNull();
    });
});

describe("the role-write cooldown", () => {
    it("runs thirty seconds from the last write", () => {
        expect(roleWriteCooldown("u1", 0)).toBe(0);
        noteRoleWrite("u1", 1000);
        expect(roleWriteCooldown("u1", 21_000)).toBe(10_000);
        expect(roleWriteCooldown("u1", 31_000)).toBe(0);
    });
});

describe("a pending set", () => {
    it("is taken once", () => {
        stageSet("exec", "abc", "Great week", 0);
        expect(takeSet("exec", 1)).toEqual({ staffId: "abc", reason: "Great week" });
        expect(takeSet("exec", 2)).toBeNull();
    });

    it("expires", () => {
        stageSet("exec", "abc", null, 0);
        expect(takeSet("exec", STAGE_TTL_MS)).toBeNull();
    });
});
```

`test/sotwFragment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    URL_LIMIT,
    pickerFragment,
    pickerUrl,
    readFragment,
    type PickerFragmentInput
} from "../src/domain/sotwFragment.js";

const input = (overrides: Partial<PickerFragmentInput> = {}): PickerFragmentInput => ({
    nickname: "Robin",
    userId: "123456789012345678",
    guildId: "223456789012345678",
    avatarHash: "a_0123456789abcdef0123456789abcdef",
    guildAvatar: true,
    roleId: "323456789012345678",
    iconHash: "0123456789abcdef0123456789abcdef",
    emoji: null,
    colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff },
    enhanced: true,
    ...overrides
});

describe("the picker link", () => {
    it("round-trips everything the page needs", () => {
        expect(readFragment(pickerFragment(input()))).toEqual(input());
    });

    it("round-trips a nickname with emoji and symbols", () => {
        const odd = input({ nickname: `Ro<b>&"bin 🌈🏳️‍🌈`, roleId: null, iconHash: null, emoji: "🌈" });
        expect(readFragment(pickerFragment(odd))).toEqual(odd);
    });

    it("carries no colour and no avatar when there are none", () => {
        const bare = input({ avatarHash: null, guildAvatar: false, roleId: null, iconHash: null, colour: null });
        expect(readFragment(pickerFragment(bare))).toEqual(bare);
    });

    it("replaces any fragment already on the configured address", () => {
        const url = pickerUrl("https://colour.example.nz/pick#stale", input());
        expect(url.startsWith("https://colour.example.nz/pick#v=1&")).toBe(true);
        expect(url).not.toContain("stale");
    });

    it("keeps the link within Discord's limit by shortening the nickname, never the ids", () => {
        const long = input({ nickname: "🌈".repeat(32) + "ǅ".repeat(32) });
        const url = pickerUrl("https://colour.example.nz/a/rather/long/path/to/the/picker/page", long);
        expect(url.length).toBeLessThanOrEqual(URL_LIMIT);
        const read = readFragment(url.split("#")[1]);
        expect(read?.userId).toBe(long.userId);
        expect(read?.iconHash).toBe(long.iconHash);
        expect(long.nickname.startsWith(read?.nickname ?? "x")).toBe(true);
    });

    it("refuses a fragment of an unknown version", () => {
        expect(readFragment("v=9&n=x")).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests and check they fail**

Run: `pnpm vitest run test/sotwStaging.test.ts test/sotwFragment.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

`src/domain/sotwStaging.ts`:

```ts
import type { SotwColour } from "../db/types.js";
import { cooldownRemainingMs } from "./staffOfWeek.js";

/**
 * What a member has chosen but not saved, and when they last changed the role.
 *
 * In memory, like the config import: a restart forgets a staged colour, which
 * costs somebody pasting a code again and nothing more. Keyed by Discord id, so
 * only the person who staged a choice can save it.
 */

export const STAGE_TTL_MS = 10 * 60_000;

const staged = new Map<string, { colour: SotwColour | null; expiresAt: number }>();
const lastRoleWrite = new Map<string, number>();
const pendingSets = new Map<string, { staffId: string; reason: string | null; expiresAt: number }>();

export function stageColour(discordId: string, colour: SotwColour | null, now = Date.now()): void {
    staged.set(discordId, { colour, expiresAt: now + STAGE_TTL_MS });
}

/** Null when nothing is staged; `{ colour: null }` when "no colour" is. */
export function stagedColour(
    discordId: string,
    now = Date.now()
): { colour: SotwColour | null } | null {
    const entry = staged.get(discordId);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        staged.delete(discordId);
        return null;
    }
    return { colour: entry.colour };
}

export function clearStaged(discordId: string): void {
    staged.delete(discordId);
}

export function noteRoleWrite(discordId: string, now = Date.now()): void {
    lastRoleWrite.set(discordId, now);
}

/** Milliseconds until this member may change the role's colour again. */
export function roleWriteCooldown(discordId: string, now = Date.now()): number {
    return cooldownRemainingMs(lastRoleWrite.get(discordId), now);
}

/** A `/sotw set` waiting on "rest of this week" or "next week". */
export function stageSet(
    actorId: string,
    staffId: string,
    reason: string | null,
    now = Date.now()
): void {
    pendingSets.set(actorId, { staffId, reason, expiresAt: now + STAGE_TTL_MS });
}

export function takeSet(
    actorId: string,
    now = Date.now()
): { staffId: string; reason: string | null } | null {
    const entry = pendingSets.get(actorId);
    pendingSets.delete(actorId);
    if (!entry || entry.expiresAt <= now) return null;
    return { staffId: entry.staffId, reason: entry.reason };
}

/** Test seam. */
export function resetSotwStaging(): void {
    staged.clear();
    lastRoleWrite.clear();
    pendingSets.clear();
}
```

`src/domain/sotwFragment.ts`:

```ts
import type { SotwColour } from "../db/types.js";
import { formatColourCode, parseColourCode } from "./sotwColour.js";

/**
 * The link to the colour picker page.
 *
 * Everything personal rides in the fragment, which a browser never sends to
 * the host: the page reads it locally and draws the member's own name, badge
 * and avatar. Ids and hashes rather than URLs, so it fits Discord's
 * 512-character limit on a link button. The page reads the same keys; a test
 * holds the two together.
 */

export const URL_LIMIT = 512;
const VERSION = "1";

export interface PickerFragmentInput {
    /** Public-guild nickname: the name the colour will actually be seen on. */
    nickname: string;
    userId: string;
    guildId: string;
    avatarHash: string | null;
    /** The avatar hash is the member's server avatar rather than their global one. */
    guildAvatar: boolean;
    /** The highest role with an uploaded icon, if that is the badge. */
    roleId: string | null;
    iconHash: string | null;
    /** A unicode emoji badge, if that is the badge instead. */
    emoji: string | null;
    colour: SotwColour | null;
    /** The server supports gradient and holographic roles. */
    enhanced: boolean;
}

export function pickerFragment(input: PickerFragmentInput): string {
    const params = new URLSearchParams();
    params.set("v", VERSION);
    params.set("n", input.nickname);
    params.set("u", input.userId);
    params.set("g", input.guildId);
    if (input.avatarHash) {
        params.set("a", input.avatarHash);
        if (input.guildAvatar) params.set("ga", "1");
    }
    if (input.roleId && input.iconHash) {
        params.set("r", input.roleId);
        params.set("i", input.iconHash);
    } else if (input.emoji) {
        params.set("e", input.emoji);
    }
    if (input.colour) params.set("c", formatColourCode(input.colour));
    params.set("x", input.enhanced ? "1" : "0");
    return params.toString();
}

/** The configured page with a fresh fragment, shortened to fit by trimming the nickname. */
export function pickerUrl(base: string, input: PickerFragmentInput): string {
    const page = base.split("#")[0];
    let nickname = [...input.nickname];
    for (;;) {
        const url = `${page}#${pickerFragment({ ...input, nickname: nickname.join("") })}`;
        if (url.length <= URL_LIMIT || nickname.length === 0) return url;
        nickname = nickname.slice(0, -1);
    }
}

export function readFragment(fragment: string): PickerFragmentInput | null {
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    if (params.get("v") !== VERSION) return null;
    const code = params.get("c");
    const parsed = code ? parseColourCode(code) : null;
    return {
        nickname: params.get("n") ?? "",
        userId: params.get("u") ?? "",
        guildId: params.get("g") ?? "",
        avatarHash: params.get("a"),
        guildAvatar: params.get("ga") === "1",
        roleId: params.get("r"),
        iconHash: params.get("i"),
        emoji: params.get("e"),
        colour: parsed?.ok ? parsed.colour : null,
        enhanced: params.get("x") === "1"
    };
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwStaging.test.ts test/sotwFragment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/sotwStaging.ts src/domain/sotwFragment.ts test/sotwStaging.test.ts test/sotwFragment.test.ts
git commit -m "Stage colour choices, cool the role down, and build the picker link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The name preview image

**Files:**
- Create: `src/render/sotwPreview.ts`
- Test: `test/sotwPreview.test.ts`

**Interfaces:**
- Consumes: `HOLOGRAPHIC`, `hexOf` (`render/sotwPalette.ts`), `SotwColour`.
- Produces: `interface SotwPreviewInput { name: string; colour: SotwColour | null; avatar: string | null; badge: string | null }` (avatar and badge are `data:` URIs), `sotwPreviewSvg(input: SotwPreviewInput): string`, `describePreview(input: SotwPreviewInput): string`, `renderSotwPreview(input: SotwPreviewInput, cacheKey?: string): Buffer`, `PREVIEW_FILE = "sotw-preview.png"`.

- [ ] **Step 1: Write the failing test**

`test/sotwPreview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describePreview, sotwPreviewSvg } from "../src/render/sotwPreview.js";
import { HOLOGRAPHIC, hexOf } from "../src/render/sotwPalette.js";

const base = { name: "Robin", avatar: null, badge: null };
const count = (svg: string, needle: string) => svg.split(needle).length - 1;

describe("the name preview", () => {
    it("draws the message on a dark and a light theme", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "solid", primary: 0xff66aa } });
        expect(count(svg, 'class="sotw-name"')).toBe(2);
        expect(svg).toContain('fill="#FF66AA"');
    });

    it("draws a gradient with its two stops", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff } });
        expect(count(svg, "<stop ")).toBe(4); // two stops, once per theme
        expect(svg).toContain('stop-color="#3366FF"');
    });

    it("draws holographic with Discord's three stops", () => {
        const svg = sotwPreviewSvg({ ...base, colour: { style: "holographic" } });
        expect(count(svg, "<stop ")).toBe(6);
        for (const stop of Object.values(HOLOGRAPHIC)) expect(svg).toContain(`stop-color="${hexOf(stop)}"`);
    });

    it("leaves a name without a colour in the theme's own name colour", () => {
        const svg = sotwPreviewSvg({ ...base, colour: null });
        expect(svg).not.toContain("<stop ");
        expect(svg).toContain('fill="#F2F3F5"');
        expect(svg).toContain('fill="#060607"');
    });

    it("omits the badge when there is none, and draws it when there is", () => {
        expect(sotwPreviewSvg({ ...base, colour: null })).not.toContain("sotw-badge");
        const withBadge = sotwPreviewSvg({ ...base, colour: null, badge: "data:image/png;base64,AAAA" });
        expect(count(withBadge, 'class="sotw-badge"')).toBe(2);
    });

    it("draws a placeholder avatar when none could be fetched", () => {
        const svg = sotwPreviewSvg({ ...base, colour: null });
        expect(count(svg, 'class="sotw-avatar"')).toBe(2);
        expect(svg).not.toContain("<image ");
    });

    it("escapes a hostile nickname", () => {
        const svg = sotwPreviewSvg({ ...base, name: `<script>&"x"`, colour: null });
        expect(svg).not.toContain("<script>");
        expect(svg).toContain("&lt;script&gt;&amp;");
    });

    it("says what it shows in words", () => {
        expect(describePreview({ ...base, colour: { style: "holographic" } })).toBe(
            "Robin's name in Holographic, on Discord's dark and light themes."
        );
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwPreview.test.ts`
Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement**

`src/render/sotwPreview.ts`:

```ts
import { Resvg } from "@resvg/resvg-js";
import type { SotwColour } from "../db/types.js";
import { FONT_OPTIONS } from "./fonts.js";
import { escapeXml, round } from "./svg.js";
import { FONT_STACK } from "./theme.js";
import { HOLOGRAPHIC, hexOf } from "./sotwPalette.js";
import { LruCache } from "../util/cache.js";

/**
 * A mock Discord message in the member's chosen colour, on the dark theme and
 * the light one, so they see what everybody else will.
 *
 * The name is the public-guild nickname, not `staffDisplayName`'s staff-server
 * one: the colour only exists in the community server, so that is the name it
 * colours. A still image shows the colours and not Discord's shimmer.
 *
 * Pure: the avatar and badge arrive as data URIs fetched by the service.
 */

export const PREVIEW_FILE = "sotw-preview.png";

export interface SotwPreviewInput {
    name: string;
    colour: SotwColour | null;
    avatar: string | null;
    badge: string | null;
}

const WIDTH = 520;
const PAD = 16;
const ROW = 76;
const GAP = 8;
const HEIGHT = PAD * 2 + ROW * 2 + GAP;
const AVATAR = 40;
const NAME_SIZE = 16;

const THEMES = [
    { id: "dark", ground: "#313338", body: "#DBDEE1", plainName: "#F2F3F5", muted: "#949BA4", placeholder: "#5865F2" },
    { id: "light", ground: "#FFFFFF", body: "#313338", plainName: "#060607", muted: "#5C5E66", placeholder: "#5865F2" }
] as const;

/** A bold 16px Inter glyph averages about 9px; close enough to seat the badge. */
const approxNameWidth = (name: string) => [...name].length * 9.2;

function nameFill(colour: SotwColour | null, theme: (typeof THEMES)[number]): { defs: string; fill: string } {
    if (!colour) return { defs: "", fill: theme.plainName };
    if (colour.style === "solid") return { defs: "", fill: hexOf(colour.primary) };
    const id = `sotw-name-${theme.id}`;
    const stops =
        colour.style === "gradient"
            ? [colour.primary, colour.secondary]
            : [HOLOGRAPHIC.primary, HOLOGRAPHIC.secondary, HOLOGRAPHIC.tertiary];
    const stopMarkup = stops
        .map((stop, index) => {
            const offset = round((index / (stops.length - 1)) * 100);
            return `<stop offset="${offset}%" stop-color="${hexOf(stop)}"/>`;
        })
        .join("");
    return {
        defs: `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stopMarkup}</linearGradient>`,
        fill: `url(#${id})`
    };
}

function row(input: SotwPreviewInput, theme: (typeof THEMES)[number], top: number): { defs: string; body: string } {
    const fill = nameFill(input.colour, theme);
    const clipId = `sotw-avatar-${theme.id}`;
    const cx = PAD + 16 + AVATAR / 2;
    const cy = top + 18 + AVATAR / 2;
    const nameX = PAD + 16 + AVATAR + 16;
    const nameY = top + 34;
    const badgeX = round(nameX + approxNameWidth(input.name) + 6);

    const avatar = input.avatar
        ? `<image class="sotw-avatar" href="${input.avatar}" x="${cx - AVATAR / 2}" y="${cy - AVATAR / 2}" ` +
          `width="${AVATAR}" height="${AVATAR}" clip-path="url(#${clipId})"/>`
        : `<circle class="sotw-avatar" cx="${cx}" cy="${cy}" r="${AVATAR / 2}" fill="${theme.placeholder}"/>`;

    const badge = input.badge
        ? `<image class="sotw-badge" href="${input.badge}" x="${badgeX}" y="${nameY - 15}" width="18" height="18"/>`
        : "";

    return {
        defs:
            fill.defs +
            `<clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${AVATAR / 2}"/></clipPath>`,
        body:
            `<rect x="${PAD}" y="${top}" width="${WIDTH - PAD * 2}" height="${ROW}" rx="8" fill="${theme.ground}"/>` +
            avatar +
            `<text class="sotw-name" x="${nameX}" y="${nameY}" fill="${fill.fill}" font-size="${NAME_SIZE}" ` +
            `font-weight="bold" font-family="${FONT_STACK}">${escapeXml(input.name)}</text>` +
            badge +
            `<text x="${nameX}" y="${nameY + 22}" fill="${theme.body}" font-size="14" ` +
            `font-family="${FONT_STACK}">Staff of the Week, reporting for duty.</text>`
    };
}

export function describePreview(input: SotwPreviewInput): string {
    const colour =
        !input.colour
            ? "no colour"
            : input.colour.style === "solid"
              ? hexOf(input.colour.primary)
              : input.colour.style === "gradient"
                ? `a gradient from ${hexOf(input.colour.primary)} to ${hexOf(input.colour.secondary)}`
                : "Holographic";
    return `${input.name}'s name in ${colour}, on Discord's dark and light themes.`;
}

export function sotwPreviewSvg(input: SotwPreviewInput): string {
    const rows = THEMES.map((theme, index) => row(input, theme, PAD + index * (ROW + GAP)));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${rows.map((part) => part.defs).join("")}</defs>
    ${rows.map((part) => part.body).join("\n    ")}
    <title>${escapeXml(describePreview(input))}</title>
</svg>`;
}

const cache = new LruCache<string, Buffer>(128);

/** Rasterised at 2x, like the rings. Cached only when the caller supplies a key. */
export function renderSotwPreview(input: SotwPreviewInput, cacheKey?: string): Buffer {
    if (cacheKey) {
        const hit = cache.get(cacheKey);
        if (hit) return hit;
    }
    const resvg = new Resvg(sotwPreviewSvg(input), {
        fitTo: { mode: "width", value: WIDTH * 2 },
        background: "rgba(0,0,0,0)",
        font: FONT_OPTIONS
    });
    const png = Buffer.from(resvg.render().asPng());
    if (cacheKey) cache.set(cacheKey, png);
    return png;
}
```

`describePreview` for holographic in the test expects "in Holographic". The implementation above yields "Robin's name in Holographic, …", which matches.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/sotwPreview.ts test/sotwPreview.test.ts
git commit -m "Draw a member's name in their Staff of the Week colour on both themes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Cards, congratulations and modals

**Files:**
- Create: `src/render/sotwMessages.ts`
- Create: `src/render/sotwCards.ts`
- Modify: `src/render/modals.ts` (constants block and two builders at the end)
- Test: `test/sotwCards.test.ts`

**Interfaces:**
- Consumes: `noticeCard`, `text`, `separator`, `V2_FLAGS`, `RenderedMessage` (`render/cards.ts`); `COLOUR`; `EMOJI`; `PREVIEW_FILE`.
- Produces (`sotwMessages.ts`): `SOTW_CONGRATULATIONS: readonly string[]`, `pickCongratulation(rng: () => number): string`.
- Produces (`sotwCards.ts`):
  - `sotwCard(title: string, body: string, options?: { ephemeral?: boolean }): RenderedMessage`
  - `interface Leader { name: string; minutes: number; pendingLeave: boolean }`
  - `reminderCard(input: { nextWeekLabel: string; decision: string; barred: string[]; leaders: Leader[]; target: number; setCommand: string }): RenderedMessage`
  - `weekChoiceCard(input: { name: string; currentLabel: string; nextLabel: string }): RenderedMessage` with buttons `sotw:rest`, `sotw:next`, `sotw:cancel`
  - `type HandoffSummary = { kind: "picked"; holder: string; by: string } | { kind: "random"; holder: string; pool: string[]; failedPick: string | null } | { kind: "skipped"; by: string } | { kind: "empty"; failedPick: string | null }`
  - `handoffText(summary: HandoffSummary): string`
  - `viewCard(input: { current: string; next: string; history: string[]; eligible: Leader[]; target: number }): RenderedMessage`
  - `type ColourStatusLine = "holding" | "saved" | "executive"`
  - `colourStatusText(status: ColourStatusLine): string`
  - `colourSettingsCard(input: { status: ColourStatusLine; savedLabel: string; staged: { label: string } | null; pickerUrl: string | null; preview: { png: Buffer; alt: string } | null; message: string | null; note: string | null }): RenderedMessage` with buttons `sotwColour:code`, `sotwColour:clear`, `sotwColour:save`, `sotwColour:cancel`
  - `congratsCard(input: { message: string; colourLine: string; preview: { png: Buffer; alt: string } | null }): RenderedMessage`
- Produces (`modals.ts`): `SOTW_CODE_MODAL = "sotwCode"`, `SOTW_REMOVE_MODAL = "sotwRemove"`, `FIELD_CODE = "code"`, `sotwCodeModal(prefill: string | null): ModalBuilder`, `sotwRemoveModal(name: string): ModalBuilder`.

- [ ] **Step 1: Write the failing test**

`test/sotwCards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
    colourSettingsCard,
    colourStatusText,
    congratsCard,
    handoffText,
    reminderCard,
    weekChoiceCard
} from "../src/render/sotwCards.js";
import { SOTW_CONGRATULATIONS, pickCongratulation } from "../src/render/sotwMessages.js";
import { EMOJI } from "../src/render/emoji.js";
import { COLOUR } from "../src/render/theme.js";

const json = (card: { components: { toJSON(): unknown }[] }) =>
    JSON.stringify(card.components.map((component) => component.toJSON()));

describe("the reminder", () => {
    it("says what is decided, who is barred and who did well, and where to act", () => {
        const body = json(
            reminderCard({
                nextWeekLabel: "Mon 5 Oct to Sun 11 Oct",
                decision: "Not decided yet — it will be drawn at random.",
                barred: ["Robin", "Sam"],
                leaders: [
                    { name: "Ashley", minutes: 300, pendingLeave: false },
                    { name: "Kai", minutes: 250, pendingLeave: true }
                ],
                target: 120,
                setCommand: "</sotw set:1>"
            })
        );
        expect(body).toContain(EMOJI.staffOfWeek);
        expect(body).toContain("drawn at random");
        expect(body).toContain("Robin");
        expect(body).toContain("Ashley");
        expect(body).toContain("has leave awaiting a decision");
        expect(body).toContain("</sotw set:1>");
        expect(body).not.toContain("⚠");
    });
});

describe("the week choice", () => {
    it("offers the rest of this week and next week", () => {
        const body = json(weekChoiceCard({ name: "Robin", currentLabel: "this", nextLabel: "next" }));
        expect(body).toContain("sotw:rest");
        expect(body).toContain("sotw:next");
        expect(body).toContain("sotw:cancel");
    });
});

describe("the handoff notice", () => {
    it("says how the holder came to hold it", () => {
        expect(handoffText({ kind: "picked", holder: "Robin", by: "<@1>" })).toContain("picked by <@1>");
        const random = handoffText({ kind: "random", holder: "Robin", pool: ["Robin", "Sam", "Kai"], failedPick: null });
        expect(random).toContain("drawn at random");
        expect(random).toContain("Sam");
        expect(handoffText({ kind: "skipped", by: "<@1>" })).toContain("skipped");
        expect(handoffText({ kind: "empty", failedPick: null })).toContain("Nobody qualified");
    });

    it("says why a pick could not be honoured", () => {
        const text = handoffText({ kind: "random", holder: "Sam", pool: ["Sam"], failedPick: "**Robin** has left." });
        expect(text).toContain("could not be honoured");
        expect(text).toContain("**Robin** has left.");
    });
});

describe("the colour card", () => {
    it("says what saving will do, for each kind of member", () => {
        expect(colourStatusText("holding")).toContain("straight away");
        expect(colourStatusText("saved")).toContain("next time");
        expect(colourStatusText("executive")).toContain("Executives are never");
    });

    it("offers the picker link, a code and clearing when nothing is staged", () => {
        const body = json(
            colourSettingsCard({
                status: "saved",
                savedLabel: "Solid #FF66AA",
                staged: null,
                pickerUrl: "https://colour.example.nz/#v=1",
                preview: null,
                message: null,
                note: null
            })
        );
        expect(body).toContain("https://colour.example.nz/#v=1");
        expect(body).toContain("sotwColour:code");
        expect(body).toContain("sotwColour:clear");
        expect(body).not.toContain("sotwColour:save");
    });

    it("offers save, edit and cancel once something is staged", () => {
        const body = json(
            colourSettingsCard({
                status: "holding",
                savedLabel: "No colour",
                staged: { label: "Holographic" },
                pickerUrl: null,
                preview: null,
                message: null,
                note: "Holographic shows as a single colour here."
            })
        );
        expect(body).toContain("sotwColour:save");
        expect(body).toContain("sotwColour:code");
        expect(body).toContain("sotwColour:cancel");
        expect(body).toContain("Holographic shows as a single colour here.");
    });

    it("is drawn in the feature's colour", () => {
        const card = colourSettingsCard({
            status: "saved",
            savedLabel: "No colour",
            staged: null,
            pickerUrl: null,
            preview: null,
            message: null,
            note: null
        });
        expect((card.components[0].toJSON() as { accent_color: number }).accent_color).toBe(COLOUR.staffOfWeek);
    });
});

describe("the congratulation", () => {
    it("comes from the owner's list and carries the colour line", () => {
        expect(SOTW_CONGRATULATIONS.length).toBeGreaterThan(0);
        expect(SOTW_CONGRATULATIONS).toContain(pickCongratulation(() => 0.5));
        const body = json(congratsCard({ message: "Well done!", colourLine: "Your colour is on the role.", preview: null }));
        expect(body).toContain("Well done!");
        expect(body).toContain("Your colour is on the role.");
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwCards.test.ts`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement**

`src/render/sotwMessages.ts`:

```ts
/**
 * What the new holder is told. One warm, generic message for now; the owner
 * replaces and extends this list, and the bot picks one at random.
 */
export const SOTW_CONGRATULATIONS: readonly string[] = [
    "Congratulations — you're Staff of the Week! Thank you for everything you do for the " +
        "island. The role is yours until the week turns over."
];

export function pickCongratulation(rng: () => number): string {
    const index = Math.min(SOTW_CONGRATULATIONS.length - 1, Math.floor(rng() * SOTW_CONGRATULATIONS.length));
    return SOTW_CONGRATULATIONS[index];
}
```

`src/render/sotwCards.ts`:

```ts
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags
} from "discord.js";
import { noticeCard, separator, text, V2_FLAGS, type RenderedMessage } from "./cards.js";
import { COLOUR } from "./theme.js";
import { EMOJI } from "./emoji.js";
import { PREVIEW_FILE } from "./sotwPreview.js";

/**
 * Every Staff of the Week card. Mint and the trophy, from the palette, so
 * nothing here picks a colour or a mark at the call site.
 */

export function sotwCard(title: string, body: string, options: { ephemeral?: boolean } = {}): RenderedMessage {
    return noticeCard(title, body, { colour: COLOUR.staffOfWeek, ephemeral: options.ephemeral });
}

export interface Leader {
    name: string;
    minutes: number;
    pendingLeave: boolean;
}

const leaderLine = (leader: Leader, index: number) =>
    `${index + 1}. **${leader.name}** ${leader.minutes} min` +
    (leader.pendingLeave ? ` — ${EMOJI.warning} has leave awaiting a decision for that week` : "");

export function reminderCard(input: {
    nextWeekLabel: string;
    decision: string;
    barred: string[];
    leaders: Leader[];
    target: number;
    setCommand: string;
}): RenderedMessage {
    const lines = [
        `### ${EMOJI.staffOfWeek} Staff of the Week: next week`,
        input.nextWeekLabel,
        input.decision,
        "### Cannot hold it next week",
        input.barred.length > 0 ? input.barred.map((name) => `- ${name}`).join("\n") : "Nobody.",
        "### Doing well this week so far",
        input.leaders.length > 0
            ? input.leaders.map(leaderLine).join("\n")
            : "_Nobody eligible has recorded minutes yet._",
        `-# The weekly minimum is ${input.target} minutes. Meeting it is not required for a pick.`,
        `Record the choice with ${input.setCommand}, or skip the week.`
    ];
    return {
        components: [new ContainerBuilder().setAccentColor(COLOUR.staffOfWeek).addTextDisplayComponents(text(lines.join("\n")))],
        files: [],
        flags: V2_FLAGS
    };
}

export function weekChoiceCard(input: { name: string; currentLabel: string; nextLabel: string }): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        .addTextDisplayComponents(
            text(
                `### ${EMOJI.staffOfWeek} Which week for ${input.name}?\n` +
                    "Nobody holds Staff of the Week right now.\n" +
                    `**Rest of this week** gives it to them straight away (${input.currentLabel}).\n` +
                    `**Next week** records them for ${input.nextLabel}.`
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId("sotw:rest").setLabel("Rest of this week").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("sotw:next").setLabel("Next week").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("sotw:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
            )
        );
    return { components: [container], files: [], flags: V2_FLAGS | MessageFlags.Ephemeral };
}

export type HandoffSummary =
    | { kind: "picked"; holder: string; by: string }
    | { kind: "random"; holder: string; pool: string[]; failedPick: string | null }
    | { kind: "skipped"; by: string }
    | { kind: "empty"; failedPick: string | null };

export function handoffText(summary: HandoffSummary): string {
    const failed = (reason: string | null) =>
        reason ? `\n${EMOJI.warning} The recorded pick could not be honoured: ${reason}` : "";
    switch (summary.kind) {
        case "picked":
            return `**${summary.holder}** holds Staff of the Week, picked by ${summary.by}.`;
        case "random":
            return (
                `**${summary.holder}** holds Staff of the Week, drawn at random from ` +
                `${summary.pool.map((name) => `**${name}**`).join(", ")}.` +
                failed(summary.failedPick)
            );
        case "skipped":
            return `Nobody holds Staff of the Week: the week was skipped by ${summary.by}.`;
        case "empty":
            return (
                "Nobody holds Staff of the Week. Nobody qualified for the draw: nobody who may " +
                "hold it met the weekly minimum last week." +
                failed(summary.failedPick)
            );
    }
}

export function viewCard(input: {
    current: string;
    next: string;
    history: string[];
    eligible: Leader[];
    target: number;
}): RenderedMessage {
    const lines = [
        `## ${EMOJI.staffOfWeek} Staff of the Week`,
        "### This week",
        input.current,
        "### Next week",
        input.next,
        "### Recent weeks",
        input.history.length > 0 ? input.history.join("\n") : "Nothing recorded yet.",
        "### Eligible for next week",
        input.eligible.length > 0 ? input.eligible.map(leaderLine).join("\n") : "Nobody.",
        `-# Minutes are this week's so far. The weekly minimum is ${input.target}.`
    ];
    return {
        components: [new ContainerBuilder().setAccentColor(COLOUR.staffOfWeek).addTextDisplayComponents(text(lines.join("\n")))],
        files: [],
        flags: V2_FLAGS | MessageFlags.Ephemeral
    };
}

export type ColourStatusLine = "holding" | "saved" | "executive";

export function colourStatusText(status: ColourStatusLine): string {
    switch (status) {
        case "holding":
            return "You hold Staff of the Week — saving updates the role straight away.";
        case "saved":
            return "Saved for the next time you hold Staff of the Week.";
        case "executive":
            return (
                "Saved for the next time you hold Staff of the Week. Executives are never Staff " +
                "of the Week, so it only applies if that changes."
            );
    }
}

export function colourSettingsCard(input: {
    status: ColourStatusLine;
    savedLabel: string;
    staged: { label: string } | null;
    pickerUrl: string | null;
    preview: { png: Buffer; alt: string } | null;
    message: string | null;
    note: string | null;
}): RenderedMessage {
    const heading = input.staged
        ? `### ${EMOJI.staffOfWeek} Save this colour?\n**${input.staged.label}**`
        : `### ${EMOJI.staffOfWeek} Your Staff of the Week colour\n**${input.savedLabel}**`;

    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        .addTextDisplayComponents(text(`${heading}\n${colourStatusText(input.status)}`));

    const files: AttachmentBuilder[] = [];
    if (input.preview) {
        files.push(new AttachmentBuilder(input.preview.png, { name: PREVIEW_FILE, description: input.preview.alt }));
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${PREVIEW_FILE}`).setDescription(input.preview.alt)
            )
        );
    }

    const notes = [input.note ? `${EMOJI.warning} ${input.note}` : null, input.message].filter(Boolean);
    if (notes.length > 0) container.addTextDisplayComponents(text(notes.join("\n")));

    container.addSeparatorComponents(separator());
    const buttons = input.staged
        ? [
              new ButtonBuilder().setCustomId("sotwColour:save").setLabel("Save").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId("sotwColour:code").setLabel("Edit").setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId("sotwColour:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
          ]
        : [
              ...(input.pickerUrl
                  ? [new ButtonBuilder().setURL(input.pickerUrl).setLabel("Open colour picker ↗").setStyle(ButtonStyle.Link)]
                  : []),
              new ButtonBuilder().setCustomId("sotwColour:code").setLabel("Enter code").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("sotwColour:clear").setLabel("Clear colour").setStyle(ButtonStyle.Secondary)
          ];
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));

    return { components: [container], files, flags: V2_FLAGS | MessageFlags.Ephemeral };
}

export function congratsCard(input: {
    message: string;
    colourLine: string;
    preview: { png: Buffer; alt: string } | null;
}): RenderedMessage {
    const container = new ContainerBuilder()
        .setAccentColor(COLOUR.staffOfWeek)
        .addTextDisplayComponents(text(`## ${EMOJI.staffOfWeek} Staff of the Week\n${input.message}`));
    const files: AttachmentBuilder[] = [];
    if (input.preview) {
        files.push(new AttachmentBuilder(input.preview.png, { name: PREVIEW_FILE, description: input.preview.alt }));
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${PREVIEW_FILE}`).setDescription(input.preview.alt)
            )
        );
    }
    container.addTextDisplayComponents(text(`-# ${input.colourLine}`));
    return { components: [container], files, flags: V2_FLAGS };
}
```

In `src/render/modals.ts`, add to the constants block:

```ts
export const SOTW_CODE_MODAL = "sotwCode";
export const SOTW_REMOVE_MODAL = "sotwRemove";
export const FIELD_CODE = "code";
```

At the end of the file:

```ts
/** A colour code from the picker, or plain hex. Prefilled with what is saved or staged. */
export function sotwCodeModal(prefill: string | null): ModalBuilder {
    const input = new TextInputBuilder()
        .setCustomId(FIELD_CODE)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(40)
        .setPlaceholder("SOTW1-S-FF66AA or #FF66AA");
    if (prefill) input.setValue(prefill);
    return new ModalBuilder()
        .setCustomId(SOTW_CODE_MODAL)
        .setTitle("Staff of the Week colour")
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Colour code")
                .setDescription("Paste the code the colour picker gave you, or a hex colour.")
                .setTextInputComponent(input)
        );
}

/** Taking the role off the current holder. The reason is required and kept. */
export function sotwRemoveModal(name: string): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(SOTW_REMOVE_MODAL)
        .setTitle("Remove Staff of the Week")
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `-# **${name}** loses the role now. They are not barred from the next two weeks and ` +
                    "this week is not counted as theirs."
            )
        )
        .addLabelComponents(
            new LabelBuilder()
                .setLabel("Why is it being removed?")
                .setTextInputComponent(
                    new TextInputBuilder()
                        .setCustomId(FIELD_REASON)
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                        .setMinLength(4)
                        .setMaxLength(1000)
                )
        );
}
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwCards.test.ts test/staffOfWeekMark.test.ts test/tierPresentation.test.ts`
Expected: PASS. The trophy exclusivity test still passes, because every card uses `EMOJI.staffOfWeek`.

- [ ] **Step 5: Commit**

```bash
git add src/render/sotwMessages.ts src/render/sotwCards.ts src/render/modals.ts test/sotwCards.test.ts
git commit -m "Draw the Staff of the Week cards, congratulation and modals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The week store and the saved colour write

**Files:**
- Create: `src/domain/staffOfWeekStore.ts`
- Modify: `src/domain/staff.ts` (after `setRingFace`)

**Interfaces:**
- Consumes: `collections.staffOfWeek()`, doc types (Task 2), `HolderRecord` (Task 5).
- Produces:
  - `sotwEvent(kind: StaffOfWeekEventKind, options: { actorId?: string | null; staffId?: ObjectId | null; reason?: string | null; detail?: Record<string, unknown> | null }, at?: Date): StaffOfWeekEvent`
  - `toHolderRecord(doc: Pick<StaffOfWeekDoc, "holders" | "removedHolders"> | null): HolderRecord | null`
  - `findWeek(weekStart: Date): Promise<StaffOfWeekDoc | null>`
  - `findWeeks(starts: Date[]): Promise<Map<number, StaffOfWeekDoc>>` (keyed by `getTime()`)
  - `anyStaffOfWeek(): Promise<boolean>`
  - `recentWeeks(before: Date, limit: number): Promise<StaffOfWeekDoc[]>` (newest first, `weekStart < before`)
  - `weeksHeldBy(staffId: ObjectId): Promise<StaffOfWeekDoc[]>`
  - `recordPick(weekStart: Date, staffId: ObjectId, actorId: string, reason: string | null, now?: Date): Promise<{ replaced: ObjectId | null }>`
  - `recordSkip(weekStart: Date, actorId: string, reason: string | null, now?: Date): Promise<void>`
  - `recordGrant(weekStart: Date, grant: { staffId: ObjectId; status: "picked" | "random"; decidedBy: string | null; eventKind: "set" | "drawn" | null; reason: string | null; detail: Record<string, unknown> | null }, now?: Date): Promise<void>`
  - `recordEmpty(weekStart: Date, reason: string, detail: Record<string, unknown> | null, now?: Date): Promise<void>`
  - `recordRemoval(weekStart: Date, staffId: ObjectId, actorId: string | null, reason: string, now?: Date): Promise<void>`
  - `appendEvent(weekStart: Date, event: StaffOfWeekEvent): Promise<void>`
  - `markHandedOff(weekStart: Date, detail: Record<string, unknown> | null, now?: Date): Promise<void>`
  - `setSotwColour(staffId: ObjectId, colour: SotwColour | null): Promise<void>` (in `domain/staff.ts`)

This is database code, so there is no unit test. `pnpm typecheck` is the gate, and Task 12's manual check exercises it.

- [ ] **Step 1: Implement the store**

`src/domain/staffOfWeekStore.ts`:

```ts
import { ObjectId } from "mongodb";
import { collections } from "../db/client.js";
import type {
    StaffOfWeekDoc,
    StaffOfWeekEvent,
    StaffOfWeekEventKind,
    StaffOfWeekStatus
} from "../db/types.js";
import type { HolderRecord } from "./staffOfWeek.js";

/**
 * The `staffOfWeek` collection. One document per week, never deleted: a
 * removal is an event. Every write appends to `events`, which is the week's
 * history in order.
 */

export function sotwEvent(
    kind: StaffOfWeekEventKind,
    options: {
        actorId?: string | null;
        staffId?: ObjectId | null;
        reason?: string | null;
        detail?: Record<string, unknown> | null;
    },
    at = new Date()
): StaffOfWeekEvent {
    return {
        kind,
        at,
        actorId: options.actorId ?? null,
        staffId: options.staffId ?? null,
        reason: options.reason ?? null,
        detail: options.detail ?? null
    };
}

export function toHolderRecord(
    doc: Pick<StaffOfWeekDoc, "holders" | "removedHolders"> | null
): HolderRecord | null {
    if (!doc) return null;
    return {
        holders: (doc.holders ?? []).map((id) => id.toHexString()),
        removedHolders: (doc.removedHolders ?? []).map((id) => id.toHexString())
    };
}

export async function findWeek(weekStart: Date): Promise<StaffOfWeekDoc | null> {
    return collections.staffOfWeek().findOne({ weekStart });
}

export async function findWeeks(starts: Date[]): Promise<Map<number, StaffOfWeekDoc>> {
    const docs = await collections.staffOfWeek().find({ weekStart: { $in: starts } }).toArray();
    return new Map(docs.map((doc) => [doc.weekStart.getTime(), doc]));
}

export async function anyStaffOfWeek(): Promise<boolean> {
    return (await collections.staffOfWeek().findOne({}, { projection: { _id: 1 } })) !== null;
}

export async function recentWeeks(before: Date, limit: number): Promise<StaffOfWeekDoc[]> {
    return collections
        .staffOfWeek()
        .find({ weekStart: { $lt: before } })
        .sort({ weekStart: -1 })
        .limit(limit)
        .toArray();
}

export async function weeksHeldBy(staffId: ObjectId): Promise<StaffOfWeekDoc[]> {
    return collections.staffOfWeek().find({ holders: staffId }).sort({ weekStart: 1 }).toArray();
}

type WeekFields = Partial<{
    status: StaffOfWeekStatus;
    staffId: ObjectId | null;
    decidedBy: string | null;
    decidedAt: Date | null;
    handedOffAt: Date | null;
}>;

/**
 * Upsert one week. `$setOnInsert` fills whatever this write does not set, and
 * never names a field an `$addToSet` or `$push` in the same write touches —
 * MongoDB refuses a write that does both to one field.
 */
async function writeWeek(
    weekStart: Date,
    write: { set?: WeekFields; event?: StaffOfWeekEvent; addHolder?: ObjectId; addRemoved?: ObjectId },
    now: Date
): Promise<void> {
    const set: Record<string, unknown> = { ...(write.set ?? {}), updatedAt: now };
    const onInsert: Record<string, unknown> = { _id: new ObjectId(), weekStart, createdAt: now };
    const defaults: Record<string, unknown> = {
        status: "pending",
        staffId: null,
        decidedBy: null,
        decidedAt: null,
        handedOffAt: null
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in set)) onInsert[key] = value;
    }

    const addToSet: Record<string, ObjectId> = {};
    if (write.addHolder) addToSet.holders = write.addHolder;
    else onInsert.holders = [];
    if (write.addRemoved) addToSet.removedHolders = write.addRemoved;
    else onInsert.removedHolders = [];

    const update: Record<string, unknown> = { $set: set, $setOnInsert: onInsert };
    if (write.event) update.$push = { events: write.event };
    else onInsert.events = [];
    if (Object.keys(addToSet).length > 0) update.$addToSet = addToSet;

    await collections.staffOfWeek().updateOne({ weekStart }, update as never, { upsert: true });
}

export async function recordPick(
    weekStart: Date,
    staffId: ObjectId,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<{ replaced: ObjectId | null }> {
    const existing = await findWeek(weekStart);
    const hadPick = existing?.status === "pending" && existing.staffId !== null;
    const replaced = hadPick && existing?.staffId && !existing.staffId.equals(staffId) ? existing.staffId : null;
    await writeWeek(
        weekStart,
        {
            set: { status: "pending", staffId, decidedBy: actorId, decidedAt: now },
            event: sotwEvent(hadPick ? "replaced" : "set", { actorId, staffId, reason }, now)
        },
        now
    );
    return { replaced };
}

export async function recordSkip(
    weekStart: Date,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: { status: "skipped", staffId: null, decidedBy: actorId, decidedAt: now },
            event: sotwEvent("skipped", { actorId, reason }, now)
        },
        now
    );
}

/** Somebody now holds the week: at the handoff, or for the rest of it. */
export async function recordGrant(
    weekStart: Date,
    grant: {
        staffId: ObjectId;
        status: "picked" | "random";
        decidedBy: string | null;
        eventKind: "set" | "drawn" | null;
        reason: string | null;
        detail: Record<string, unknown> | null;
    },
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: {
                status: grant.status,
                staffId: grant.staffId,
                decidedBy: grant.decidedBy,
                // A draw or a rest-of-week grant is decided now. A pick being
                // handed off keeps the time the Executive decided it.
                ...(grant.eventKind !== null ? { decidedAt: now } : {})
            },
            event: grant.eventKind
                ? sotwEvent(
                      grant.eventKind,
                      { actorId: grant.decidedBy, staffId: grant.staffId, reason: grant.reason, detail: grant.detail },
                      now
                  )
                : undefined,
            addHolder: grant.staffId
        },
        now
    );
}

export async function recordEmpty(
    weekStart: Date,
    reason: string,
    detail: Record<string, unknown> | null,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        { set: { status: "empty", staffId: null }, event: sotwEvent("empty", { reason, detail }, now) },
        now
    );
}

export async function recordRemoval(
    weekStart: Date,
    staffId: ObjectId,
    actorId: string | null,
    reason: string,
    now = new Date()
): Promise<void> {
    await writeWeek(
        weekStart,
        {
            set: { status: "empty", staffId: null },
            event: sotwEvent("removed", { actorId, staffId, reason }, now),
            addRemoved: staffId
        },
        now
    );
}

export async function appendEvent(weekStart: Date, event: StaffOfWeekEvent): Promise<void> {
    await collections
        .staffOfWeek()
        .updateOne({ weekStart }, { $push: { events: event }, $set: { updatedAt: event.at } });
}

export async function markHandedOff(
    weekStart: Date,
    detail: Record<string, unknown> | null,
    now = new Date()
): Promise<void> {
    await writeWeek(weekStart, { set: { handedOffAt: now }, event: sotwEvent("handoff", { detail }, now) }, now);
}
```

`writeWeek` checks `key in set` to decide what `$setOnInsert` fills. Because `decidedAt` is left out of `set` rather than set to `undefined`, a handoff of a picked week keeps the Executive's time, and a document created by a grant still gets `decidedAt: null` on insert.

- [ ] **Step 2: Add the colour write to `domain/staff.ts`**

Add `SotwColour` to the type import from `../db/types.js`. After `setRingFace`:

```ts
/**
 * A member's own Staff of the Week colour. Only they change it, whether or not
 * they hold the role; applying it to the role is the service's job.
 */
export async function setSotwColour(staffId: ObjectId, colour: SotwColour | null): Promise<void> {
    const now = new Date();
    await collections
        .staff()
        .updateOne({ _id: staffId }, { $set: { sotwColour: colour, sotwColourUpdatedAt: now, updatedAt: now } });
}
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/domain/staffOfWeekStore.ts src/domain/staff.ts
git commit -m "Record each Staff of the Week in its own document, and save a member's colour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Role ownership, eligibility context and preview assets

**Files:**
- Create: `src/services/sotwRole.ts`
- Create: `src/services/sotwContext.ts`
- Create: `src/services/sotwPreviewService.ts`
- Modify: `src/config/configGuards.ts` (append the role-order guard)
- Test: `test/sotwGuard.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6, 7, 9; `fetchPublicMember`, `resolveTier`, `wearsOnLeaveRole` (`domain/permissions.ts`); `leaveOverlapping`, `pendingSpansOverlapping` (`domain/leave.ts`); `weekLeave` (`domain/leaveDays.ts`); `weekWindowFor`, `previousWeekWindow`, `WeekWindow` (`domain/weekly.ts`); `addRole`, `removeRole`, `fetchMember` (`discord/roles.ts`); `staffDisplayName`.
- Produces (`config/configGuards.ts`): `interface RoleOrderFacts { missing: boolean; roleName: string; aboveBot: boolean; colouredRoleAbove: string | null }`, `colouredRoleAbove(sotwPosition: number, roles: { name: string; position: number; colour: number }[]): string | null`, `staffOfWeekRoleOrder(facts: RoleOrderFacts | null): ConfigWarning[]`.
- Produces (`services/sotwRole.ts`): `sotwRole(client, config): Promise<{ guild: Guild; role: Role } | null>`, `guildHasEnhanced(guild: Guild): boolean`, `interface ColourWrite { ok: boolean; downgraded: boolean }`, `applyRoleColour(client, config, colour: SotwColour | null, reason: string, actorId?: string | null): Promise<ColourWrite>`, `handRoleTo(client, config, holder: StaffDoc | null, reason: string): Promise<{ granted: boolean; colour: ColourWrite }>`, `takeRoleFrom(client, config, holder: StaffDoc, reason: string): Promise<void>`, `staffOfWeekRoleFacts(client, config): Promise<RoleOrderFacts | null>`.
- Produces (`services/sotwContext.ts`): `interface WeekSlots { current: WeekWindow; next: WeekWindow; handedOff: boolean }`, `weekSlots(config, now?): Promise<WeekSlots>`, `candidateFor(client, config, staff: StaffDoc, week: WeekWindow): Promise<Candidate>`, `barredFor(week: WeekWindow, config): Promise<Set<string>>`, `eligibilityOf(client, config, staff, week, barred?): Promise<Eligibility>`, `rosterFor(client, config, week): Promise<{ staff: StaffDoc; eligibility: Eligibility }[]>`, `currentHolder(config, now?): Promise<{ doc: StaffOfWeekDoc; staff: StaffDoc; week: WeekWindow } | null>`, `nameOf(client, config, staff: StaffDoc): Promise<string>`.
- Produces (`services/sotwPreviewService.ts`): `interface PreviewAssets { nickname: string; avatar: string | null; badge: string | null; enhanced: boolean; fragment: Omit<PickerFragmentInput, "colour" | "enhanced"> }`, `previewAssets(client, config, discordId: string): Promise<PreviewAssets>`, `previewFor(client, config, discordId: string, colour: SotwColour | null): Promise<{ png: Buffer; alt: string } | null>`.

- [ ] **Step 1: Write the failing test (the pure guard)**

`test/sotwGuard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { colouredRoleAbove, staffOfWeekRoleOrder } from "../src/config/configGuards.js";

describe("where the Staff of the Week role sits", () => {
    it("says nothing when the feature is off or all is well", () => {
        expect(staffOfWeekRoleOrder(null)).toEqual([]);
        expect(
            staffOfWeekRoleOrder({ missing: false, roleName: "SOTW", aboveBot: false, colouredRoleAbove: null })
        ).toEqual([]);
    });

    it("warns when the bot cannot manage it", () => {
        const [warning] = staffOfWeekRoleOrder({
            missing: false,
            roleName: "SOTW",
            aboveBot: true,
            colouredRoleAbove: null
        });
        expect(warning.key).toBe("staffOfWeekRole");
        expect(warning.text).toMatch(/above the bot/);
    });

    it("warns when a coloured staff role would hide the holder's colour", () => {
        const [warning] = staffOfWeekRoleOrder({
            missing: false,
            roleName: "SOTW",
            aboveBot: false,
            colouredRoleAbove: "Senior Moderator"
        });
        expect(warning.text).toContain("Senior Moderator");
    });

    it("warns when the role no longer exists", () => {
        expect(
            staffOfWeekRoleOrder({ missing: true, roleName: "123", aboveBot: false, colouredRoleAbove: null })[0].text
        ).toMatch(/does not exist/);
    });

    it("finds the highest coloured role above it, ignoring uncoloured ones", () => {
        expect(
            colouredRoleAbove(5, [
                { name: "Plain", position: 9, colour: 0 },
                { name: "Lead", position: 8, colour: 0xff0000 },
                { name: "Senior", position: 7, colour: 0x00ff00 },
                { name: "Below", position: 2, colour: 0x0000ff }
            ])
        ).toBe("Lead");
        expect(colouredRoleAbove(5, [{ name: "Below", position: 2, colour: 1 }])).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwGuard.test.ts`
Expected: FAIL, because the exports do not exist.

- [ ] **Step 3: Implement the guard**

Append to `src/config/configGuards.ts`:

```ts
/**
 * What the bot can see about where the Staff of the Week role sits. Gathered by
 * `staffOfWeekRoleFacts`, because it needs the guild; judged here, purely, so
 * `/config view`, `/config set` and `/dev status` say the same thing.
 */
export interface RoleOrderFacts {
    missing: boolean;
    roleName: string;
    aboveBot: boolean;
    /** The highest coloured staff role above it, which would win the name's colour. */
    colouredRoleAbove: string | null;
}

export function colouredRoleAbove(
    sotwPosition: number,
    roles: { name: string; position: number; colour: number }[]
): string | null {
    return (
        roles
            .filter((role) => role.colour !== 0 && role.position > sotwPosition)
            .sort((left, right) => right.position - left.position)[0]?.name ?? null
    );
}

export function staffOfWeekRoleOrder(facts: RoleOrderFacts | null): ConfigWarning[] {
    if (!facts) return [];
    if (facts.missing) {
        return [
            {
                key: "staffOfWeekRole",
                text:
                    "The Staff of the Week role does not exist in the community server any more, " +
                    "so nobody can be given it. Choose the role again."
            }
        ];
    }
    const warnings: ConfigWarning[] = [];
    if (facts.aboveBot) {
        warnings.push({
            key: "staffOfWeekRole",
            text:
                `**${facts.roleName}** sits above the bot's highest role, so the bot cannot give it, ` +
                "take it back or change its colour. Move the bot's role above it."
        });
    }
    if (facts.colouredRoleAbove) {
        warnings.push({
            key: "staffOfWeekRole",
            text:
                `**${facts.colouredRoleAbove}** is coloured and sits above **${facts.roleName}**. ` +
                "Discord colours a name by the highest coloured role, so a holder with it will " +
                "not show their Staff of the Week colour. Move the Staff of the Week role above it."
        });
    }
    return warnings;
}
```

- [ ] **Step 4: Run the test and check it passes**

Run: `pnpm vitest run test/sotwGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the services**

`src/services/sotwRole.ts`:

```ts
import { GuildFeature, type Client, type Guild, type Role } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour, StaffDoc } from "../db/types.js";
import { roleColoursFor } from "../domain/sotwColour.js";
import { addRole, fetchMember, removeRole } from "../discord/roles.js";
import { audit } from "../domain/audit.js";
import { colouredRoleAbove, type RoleOrderFacts } from "../config/configGuards.js";
import { log } from "../log.js";

/**
 * The bot owns the Staff of the Week role: who wears it and what colour it is.
 * Anyone given it by hand loses it at the next handoff or boot, and a colour
 * edited in Discord's settings is put back, because the holder's saved
 * preference is the source of truth.
 */

export async function sotwRole(
    client: Client,
    config: StaffBotConfig
): Promise<{ guild: Guild; role: Role } | null> {
    if (!config.staffOfWeekRole) return null;
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        const role = await guild.roles.fetch(config.staffOfWeekRole);
        return role ? { guild, role } : null;
    } catch (error) {
        log.warn("Could not fetch the Staff of the Week role", error);
        return null;
    }
}

export function guildHasEnhanced(guild: Guild): boolean {
    return guild.features.includes(GuildFeature.EnhancedRoleColors);
}

export interface ColourWrite {
    ok: boolean;
    downgraded: boolean;
}

export async function applyRoleColour(
    client: Client,
    config: StaffBotConfig,
    colour: SotwColour | null,
    reason: string,
    actorId: string | null = null
): Promise<ColourWrite> {
    const found = await sotwRole(client, config);
    if (!found) return { ok: false, downgraded: false };
    const { colours, downgraded } = roleColoursFor(colour, guildHasEnhanced(found.guild));
    const current = found.role.colors;
    if (
        current.primaryColor === colours.primaryColor &&
        (current.secondaryColor ?? null) === colours.secondaryColor &&
        (current.tertiaryColor ?? null) === colours.tertiaryColor
    ) {
        return { ok: true, downgraded };
    }
    try {
        // `edit` rather than `setColors`: only the edit form accepts null to
        // clear a gradient's second and third stops.
        await found.role.edit({ colors: colours, reason });
        await audit("sotw.roleColour", { actorId, detail: { roleId: found.role.id, ...colours } });
        return { ok: true, downgraded };
    } catch (error) {
        log.warn("Could not set the Staff of the Week role's colour", error);
        return { ok: false, downgraded };
    }
}

/**
 * Give the role to `holder` alone, in their colour, or to nobody. Every cached
 * member wearing it who is not the holder loses it, however they came by it.
 */
export async function handRoleTo(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc | null,
    reason: string
): Promise<{ granted: boolean; colour: ColourWrite }> {
    const found = await sotwRole(client, config);
    if (!found) return { granted: false, colour: { ok: false, downgraded: false } };

    for (const member of found.role.members.values()) {
        if (holder && member.id === holder.discordId) continue;
        await removeRole(member, found.role.id, reason);
    }

    const colour = await applyRoleColour(client, config, holder?.sotwColour ?? null, reason);
    if (!holder) return { granted: false, colour };

    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    const granted = member ? await addRole(member, found.role.id, reason, holder._id) : false;
    if (!granted) log.warn(`Could not give Staff of the Week to ${holder.discordId}`);
    return { granted, colour };
}

export async function takeRoleFrom(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc,
    reason: string
): Promise<void> {
    const found = await sotwRole(client, config);
    if (!found) return;
    const member = await fetchMember(client, config.publicGuildId, holder.discordId);
    if (member) await removeRole(member, found.role.id, reason, holder._id);
    await applyRoleColour(client, config, null, reason);
}

export async function staffOfWeekRoleFacts(
    client: Client,
    config: StaffBotConfig
): Promise<RoleOrderFacts | null> {
    if (!config.staffOfWeekRole) return null;
    try {
        const guild = await client.guilds.fetch(config.publicGuildId);
        const role = await guild.roles.fetch(config.staffOfWeekRole);
        if (!role) {
            return { missing: true, roleName: config.staffOfWeekRole, aboveBot: false, colouredRoleAbove: null };
        }
        const me = await guild.members.fetchMe();
        const staffRoles = [
            config.moderationDepartmentRole,
            config.availabilityRole,
            config.onLeaveRole,
            ...config.staffRankRoles,
            ...config.leadRoles,
            ...config.executiveRoles
        ]
            .filter(Boolean)
            .map((id) => guild.roles.cache.get(id))
            .filter((found): found is Role => Boolean(found));
        return {
            missing: false,
            roleName: role.name,
            aboveBot: role.comparePositionTo(me.roles.highest) >= 0,
            colouredRoleAbove: colouredRoleAbove(
                role.position,
                staffRoles.map((staffRole) => ({
                    name: staffRole.name,
                    position: staffRole.position,
                    colour: staffRole.colors.primaryColor
                }))
            )
        };
    } catch (error) {
        log.debug("Could not read where the Staff of the Week role sits", error);
        return null;
    }
}
```

`src/services/sotwContext.ts`:

```ts
import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc, StaffOfWeekDoc } from "../db/types.js";
import { fetchPublicMember, resolveTier, wearsOnLeaveRole } from "../domain/permissions.js";
import { leaveOverlapping, pendingSpansOverlapping } from "../domain/leave.js";
import { weekLeave } from "../domain/leaveDays.js";
import { findStaffById, listActiveStaff } from "../domain/staff.js";
import { previousWeekWindow, weekWindowFor, type WeekWindow } from "../domain/weekly.js";
import {
    barredIds,
    eligibilityFor,
    handoffSettled,
    isHolding,
    targetWeeks,
    type Candidate,
    type Eligibility
} from "../domain/staffOfWeek.js";
import { findWeek, findWeeks, toHolderRecord } from "../domain/staffOfWeekStore.js";
import { sotwHandedOff } from "./notifications.js";
import { staffDisplayName } from "../discord/displayName.js";

/** The facts `eligibilityFor` needs, gathered from Discord and the database. */

export interface WeekSlots {
    current: WeekWindow;
    next: WeekWindow;
    handedOff: boolean;
}

export async function weekSlots(config: StaffBotConfig, now = new Date()): Promise<WeekSlots> {
    const calendarWeek = weekWindowFor(now, config);
    const previous = previousWeekWindow(now, config);
    const following = weekWindowFor(calendarWeek.end, config);
    const handedOff = handoffSettled({
        claimed: await sotwHandedOff(calendarWeek.start),
        now,
        weekStart: calendarWeek.start
    });
    const slots = targetWeeks({
        previousStart: previous.start,
        currentStart: calendarWeek.start,
        nextStart: following.start,
        currentHandedOff: handedOff
    });
    return {
        current: weekWindowFor(slots.current, config),
        next: weekWindowFor(slots.next, config),
        handedOff
    };
}

export async function candidateFor(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    week: WeekWindow
): Promise<Candidate> {
    const member = await fetchPublicMember(client, config, staff.discordId);
    // Leave removes the department role, which is the role tiers read. Somebody
    // on leave now is still staff, and whether their leave touches the week
    // being assigned is the leave rule's question, not this one's.
    const resolved = resolveTier(staff.discordId, member, config);
    const tier = resolved === "none" && wearsOnLeaveRole(member, config) ? "staff" : resolved;

    const [counting, pending] = await Promise.all([
        leaveOverlapping(staff._id, week.start, week.end),
        pendingSpansOverlapping(staff._id, week.start, week.end)
    ]);
    const exempt = weekLeave(counting, week.start, week.end, config.minimumLeaveDays).exempt;
    const exemptIfApproved = weekLeave(
        [...counting, ...pending],
        week.start,
        week.end,
        config.minimumLeaveDays
    ).exempt;

    return {
        staffId: staff._id.toHexString(),
        active: staff.active,
        tier,
        exemptByLeave: exempt,
        pendingLeave: !exempt && exemptIfApproved
    };
}

/** The credited holders of exactly the two week slots before `week`. */
export async function barredFor(week: WeekWindow, config: StaffBotConfig): Promise<Set<string>> {
    const first = previousWeekWindow(week.start, config).start;
    const second = previousWeekWindow(first, config).start;
    const docs = await findWeeks([first, second]);
    return barredIds([
        toHolderRecord(docs.get(first.getTime()) ?? null),
        toHolderRecord(docs.get(second.getTime()) ?? null)
    ]);
}

export async function eligibilityOf(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    week: WeekWindow,
    barred?: Set<string>
): Promise<Eligibility> {
    return eligibilityFor(
        await candidateFor(client, config, staff, week),
        barred ?? (await barredFor(week, config))
    );
}

export async function rosterFor(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow
): Promise<{ staff: StaffDoc; eligibility: Eligibility }[]> {
    const barred = await barredFor(week, config);
    const roster = [];
    for (const staff of await listActiveStaff()) {
        roster.push({ staff, eligibility: await eligibilityOf(client, config, staff, week, barred) });
    }
    return roster;
}

export async function currentHolder(
    config: StaffBotConfig,
    now = new Date()
): Promise<{ doc: StaffOfWeekDoc; staff: StaffDoc; week: WeekWindow } | null> {
    const week = weekWindowFor(now, config);
    const doc = await findWeek(week.start);
    if (!doc || !doc.staffId || !isHolding(doc.status)) return null;
    const staff = await findStaffById(doc.staffId);
    return staff ? { doc, staff, week } : null;
}

export async function nameOf(client: Client, config: StaffBotConfig, staff: StaffDoc): Promise<string> {
    return staffDisplayName(client, config, staff.discordId, `<@${staff.discordId}>`);
}
```

`src/services/sotwPreviewService.ts`:

```ts
import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour } from "../db/types.js";
import { fetchPublicMember } from "../domain/permissions.js";
import { describeColour, highestIconRole, twemojiUrl } from "../domain/sotwColour.js";
import type { PickerFragmentInput } from "../domain/sotwFragment.js";
import { describePreview, renderSotwPreview } from "../render/sotwPreview.js";
import { guildHasEnhanced } from "./sotwRole.js";
import { LruCache } from "../util/cache.js";
import { log } from "../log.js";

/**
 * Everything the preview and the picker link show about a member, fetched here
 * so the renderer stays a pure function. The name is the public-guild
 * nickname — the documented exception to `staffDisplayName` — because the
 * colour is only ever seen in the community server.
 */

export interface PreviewAssets {
    nickname: string;
    avatar: string | null;
    badge: string | null;
    enhanced: boolean;
    fragment: Omit<PickerFragmentInput, "colour" | "enhanced">;
}

const images = new LruCache<string, string | null>(256);

async function dataUri(url: string): Promise<string | null> {
    const cached = images.get(url);
    if (cached !== undefined) return cached;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const type = response.headers.get("content-type") ?? "image/png";
        const body = Buffer.from(await response.arrayBuffer()).toString("base64");
        const uri = `data:${type};base64,${body}`;
        images.set(url, uri);
        return uri;
    } catch (error) {
        // Omitted rather than failed: a preview without a badge is still a preview.
        log.debug(`Could not fetch ${url} for a Staff of the Week preview`, error);
        images.set(url, null);
        return null;
    }
}

export async function previewAssets(
    client: Client,
    config: StaffBotConfig,
    discordId: string
): Promise<PreviewAssets> {
    const member = await fetchPublicMember(client, config, discordId);
    const user = member?.user ?? (await client.users.fetch(discordId).catch(() => null));
    const nickname = member?.displayName ?? user?.displayName ?? "You";
    const enhanced = member ? guildHasEnhanced(member.guild) : false;

    const badgeRole = member
        ? highestIconRole(
              [...member.roles.cache.values()].map((role) => ({
                  id: role.id,
                  position: role.position,
                  icon: role.icon,
                  unicodeEmoji: role.unicodeEmoji,
                  role
              }))
          )
        : null;

    const avatarUrl =
        member?.displayAvatarURL({ extension: "png", size: 128 }) ??
        user?.displayAvatarURL({ extension: "png", size: 128 }) ??
        null;
    const badgeUrl = badgeRole
        ? badgeRole.icon
            ? badgeRole.role.iconURL({ extension: "png", size: 64 })
            : badgeRole.unicodeEmoji
              ? twemojiUrl(badgeRole.unicodeEmoji)
              : null
        : null;

    const [avatar, badge] = await Promise.all([
        avatarUrl ? dataUri(avatarUrl) : Promise.resolve(null),
        badgeUrl ? dataUri(badgeUrl) : Promise.resolve(null)
    ]);

    return {
        nickname,
        avatar,
        badge,
        enhanced,
        fragment: {
            nickname,
            userId: discordId,
            guildId: config.publicGuildId,
            avatarHash: member?.avatar ?? user?.avatar ?? null,
            guildAvatar: Boolean(member?.avatar),
            roleId: badgeRole?.icon ? badgeRole.id : null,
            iconHash: badgeRole?.icon ?? null,
            emoji: badgeRole && !badgeRole.icon ? badgeRole.unicodeEmoji : null
        }
    };
}

export async function previewFor(
    client: Client,
    config: StaffBotConfig,
    discordId: string,
    colour: SotwColour | null
): Promise<{ png: Buffer; alt: string } | null> {
    if (!colour) return null;
    const assets = await previewAssets(client, config, discordId);
    const input = { name: assets.nickname, colour, avatar: assets.avatar, badge: assets.badge };
    const key = [discordId, assets.nickname, describeColour(colour), assets.avatar?.length ?? 0, assets.badge?.length ?? 0].join(":");
    return { png: renderSotwPreview(input, key), alt: describePreview(input) };
}
```

- [ ] **Step 6: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass. If `role.colors` or `role.edit({ colors })` fail to typecheck, check `node_modules/discord.js/typings/index.d.ts` around `RoleColorsEditResolvable` (line ~6487) and match it. Do not cast to `never`.

- [ ] **Step 7: Commit**

```bash
git add src/config/configGuards.ts src/services/sotwRole.ts src/services/sotwContext.ts src/services/sotwPreviewService.ts test/sotwGuard.test.ts
git commit -m "Own the Staff of the Week role, gather eligibility, and fetch preview assets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Notices and the reminder

**Files:**
- Create: `src/services/sotwNotices.ts`
- Modify: `src/jobs/index.ts` (register `sotw-reminder`; send an overdue reminder at boot)

**Interfaces:**
- Consumes: Tasks 5, 8, 9, 10; `staffChannel` (`services/leaveService.ts`); `tryDm`; `claimSotwReminder`, `claimSotwNotice`; `countMinutesBetween` (`domain/activity.ts`); `env.bootstrapAdminIds`; `tierOf`, `fetchPublicMember`; `cmd`; `sendOptions`; `labelWindow`.
- Produces: `postNotice(client, config, card: RenderedMessage): Promise<void>`, `postNoticeOnce(client, config, key: string, card: RenderedMessage): Promise<void>`, `executiveIds(client, config): Promise<string[]>`, `decisionLine(client, config, doc: StaffOfWeekDoc | null): Promise<string>`, `buildReminder(client, config, now?: Date): Promise<RenderedMessage>`, `sendReminder(client, config, now?: Date): Promise<number>`, `sendReminderIfDue(client, config, now?: Date): Promise<void>`.

- [ ] **Step 1: Implement**

`src/services/sotwNotices.ts`:

```ts
import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffOfWeekDoc } from "../db/types.js";
import { env } from "../config/env.js";
import { fetchPublicMember, tierOf } from "../domain/permissions.js";
import { findStaffById, listActiveStaff } from "../domain/staff.js";
import { countMinutesBetween } from "../domain/activity.js";
import { reminderTimeFor, sotwEnabled } from "../domain/staffOfWeek.js";
import { findWeek } from "../domain/staffOfWeekStore.js";
import { weekWindowFor } from "../domain/weekly.js";
import { reminderCard, type Leader } from "../render/sotwCards.js";
import type { RenderedMessage } from "../render/cards.js";
import { tryDm } from "../discord/roles.js";
import { sendOptions } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { labelWindow } from "../time/format.js";
import { staffChannel } from "./leaveService.js";
import { claimSotwNotice, claimSotwReminder } from "./notifications.js";
import { barredFor, nameOf, rosterFor, weekSlots } from "./sotwContext.js";
import { log } from "../log.js";

/**
 * Notices go to one channel, `staffOfWeekChannelId`, so the Executives share a
 * single record rather than each holding a copy in their DMs. The reminder is
 * the exception: it asks each of them to do something, so it arrives by DM.
 */

export async function postNotice(client: Client, config: StaffBotConfig, card: RenderedMessage): Promise<void> {
    if (!config.staffOfWeekChannelId) {
        log.info("A Staff of the Week notice was not posted: no channel is set.");
        return;
    }
    const channel = await staffChannel(client, config, config.staffOfWeekChannelId);
    if (!channel) {
        log.warn("staffOfWeekChannelId is set but the channel could not be fetched.");
        return;
    }
    try {
        // Names fall back to mentions; a notice pings nobody.
        await channel.send({ ...sendOptions(card), allowedMentions: { parse: [] } });
    } catch (error) {
        log.error("Could not post a Staff of the Week notice", error);
    }
}

/** One notice per subject per week. */
export async function postNoticeOnce(
    client: Client,
    config: StaffBotConfig,
    key: string,
    card: RenderedMessage
): Promise<void> {
    if (await claimSotwNotice(key)) await postNotice(client, config, card);
}

/**
 * Everyone holding an Executive role, found through the staff records rather
 * than by fetching all 110,000 members of the community server, plus the
 * seeded administrators.
 */
export async function executiveIds(client: Client, config: StaffBotConfig): Promise<string[]> {
    const ids = new Set(env.bootstrapAdminIds);
    for (const staff of await listActiveStaff()) {
        const member = await fetchPublicMember(client, config, staff.discordId);
        if (tierOf(member, config) === "executive") ids.add(staff.discordId);
    }
    return [...ids];
}

export async function decisionLine(
    client: Client,
    config: StaffBotConfig,
    doc: StaffOfWeekDoc | null
): Promise<string> {
    if (doc?.status === "skipped") return `Skipped, by <@${doc.decidedBy}>.`;
    if (doc?.status === "pending" && doc.staffId) {
        const staff = await findStaffById(doc.staffId);
        const name = staff ? await nameOf(client, config, staff) : "a member no longer on record";
        return `Picked: **${name}**, by <@${doc.decidedBy}>.`;
    }
    return "Not decided yet — it will be drawn at random.";
}

export async function buildReminder(
    client: Client,
    config: StaffBotConfig,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const nextDoc = await findWeek(slots.next.start);

    const barred = [];
    for (const id of await barredFor(slots.next, config)) {
        const staff = await findStaffById(new ObjectId(id));
        if (staff) barred.push(await nameOf(client, config, staff));
    }

    const leaders: Leader[] = [];
    for (const entry of await rosterFor(client, config, slots.next)) {
        if (!entry.eligibility.eligible) continue;
        leaders.push({
            name: await nameOf(client, config, entry.staff),
            minutes: await countMinutesBetween(entry.staff._id, slots.current.start, now),
            pendingLeave: entry.eligibility.pendingLeave
        });
    }
    leaders.sort((left, right) => right.minutes - left.minutes);

    return reminderCard({
        nextWeekLabel: labelWindow(slots.next.start, slots.next.end, config.accountingTimezone),
        decision: await decisionLine(client, config, nextDoc),
        barred,
        leaders: leaders.slice(0, 5),
        target: config.weeklyTargetMinutes,
        setCommand: cmd("sotw set")
    });
}

/** Built, then claimed, then sent: the recap rule. A failed DM is logged, never retried. */
export async function sendReminder(client: Client, config: StaffBotConfig, now = new Date()): Promise<number> {
    if (!sotwEnabled(config)) return 0;
    const card = await buildReminder(client, config, now);
    if (!(await claimSotwReminder(weekWindowFor(now, config).start))) return 0;

    let sent = 0;
    for (const id of await executiveIds(client, config)) {
        if (await tryDm(client, id, sendOptions(card))) sent += 1;
        else log.warn(`Could not DM the Staff of the Week reminder to ${id}`);
    }
    return sent;
}

/** At boot: send this week's reminder if its time has passed and it never went. */
export async function sendReminderIfDue(client: Client, config: StaffBotConfig, now = new Date()): Promise<void> {
    if (!sotwEnabled(config)) return;
    const due = reminderTimeFor(weekWindowFor(now, config).start, {
        timeZone: config.accountingTimezone,
        offsetMinutes: config.staffOfWeekReminderOffsetMinutes
    });
    if (now >= due) await sendReminder(client, config, now);
}
```

In `src/jobs/index.ts`, add imports:

```ts
import { nextReminderAt } from "../domain/staffOfWeek.js";
import { sendReminder, sendReminderIfDue } from "../services/sotwNotices.js";
```

Register the job after `week-close`:

```ts
    // Staff of the Week's reminder, at a configurable point in the week. Read
    // from the cached config at each re-arm, like week-close, so changing the
    // offset or the calendar moves it without a restart.
    schedule(
        "sotw-reminder",
        (from) => {
            const current = cachedConfig();
            return nextReminderAt(from, {
                timeZone: current.accountingTimezone,
                weekStartDay: current.weekStartDay,
                offsetMinutes: current.staffOfWeekReminderOffsetMinutes
            });
        },
        async (at) => {
            const sent = await sendReminder(client, await loadConfig(), at);
            if (sent > 0) log.info(`Sent the Staff of the Week reminder to ${sent} Executive(s)`);
        }
    );
```

At the end of `registerJobs`, after `await processLeaveTransitions(client, config);`:

```ts
    // A reminder that fell due while the process was down still goes, once.
    await sendReminderIfDue(client, config);
```

- [ ] **Step 2: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/sotwNotices.ts src/jobs/index.ts
git commit -m "Remind the Executives to pick Staff of the Week, and post its notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The handoff, catch-up and boot

**Files:**
- Create: `src/services/sotwHandoff.ts`
- Modify: `src/jobs/weeklyRollup.ts` (`closeWeek`, `catchUpMissedWeeks`)

**Interfaces:**
- Consumes: everything above.
- Produces: `drawPoolFor(client, config, week: WeekWindow, standings: Standing[]): Promise<Standing[]>`, `runHandoff(client, config, week: WeekWindow, now?: Date, rng?: () => number): Promise<boolean>`, `runHandoffSafely(client, config, week, now?): Promise<void>`, `handoffOnBoot(client, config, coldStart: boolean, now?: Date): Promise<void>`, `reassertRole(client, config, now?: Date): Promise<void>`, `congratulate(client, config, holder: StaffDoc, colour: ColourWrite, rng?: () => number): Promise<boolean>`.

- [ ] **Step 1: Implement**

`src/services/sotwHandoff.ts`:

```ts
import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { collections } from "../db/client.js";
import { findStaffById } from "../domain/staff.js";
import { previousWeekWindow, weekWindowFor, type WeekWindow } from "../domain/weekly.js";
import {
    decideHandoff,
    drawPool,
    refusalText,
    sotwEnabled,
    type Eligibility,
    type Standing
} from "../domain/staffOfWeek.js";
import {
    anyStaffOfWeek,
    appendEvent,
    findWeek,
    markHandedOff,
    recordEmpty,
    recordGrant,
    sotwEvent
} from "../domain/staffOfWeekStore.js";
import { downgradeNote } from "../domain/sotwColour.js";
import { congratsCard, handoffText, sotwCard, type HandoffSummary } from "../render/sotwCards.js";
import { pickCongratulation } from "../render/sotwMessages.js";
import { tryDm } from "../discord/roles.js";
import { sendOptions } from "../discord/respond.js";
import { cmd } from "../discord/commandMentions.js";
import { labelWindow } from "../time/format.js";
import { claimSotwHandoff, sotwHandedOff } from "./notifications.js";
import { currentHolder, eligibilityOf, nameOf, rosterFor } from "./sotwContext.js";
import { handRoleTo, type ColourWrite } from "./sotwRole.js";
import { previewFor } from "./sotwPreviewService.js";
import { postNotice } from "./sotwNotices.js";
import { log } from "../log.js";

/**
 * The week boundary. Runs inside `closeWeek` after the rollup, because the draw
 * reads the closed week's frozen figures, and before the team recap, which
 * names the new holder.
 */

export async function drawPoolFor(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    standings: Standing[]
): Promise<Standing[]> {
    const eligibility = new Map<string, Eligibility>(
        (await rosterFor(client, config, week)).map((entry) => [entry.staff._id.toHexString(), entry.eligibility])
    );
    return drawPool(standings, config.weeklyTargetMinutes, eligibility);
}

async function closedStandings(week: WeekWindow, config: StaffBotConfig): Promise<Standing[]> {
    const closed = previousWeekWindow(week.start, config);
    const rows = await collections.weeklyStats().find({ weekStart: closed.start }).toArray();
    return rows.map((row) => ({ staffId: row.staffId.toHexString(), minutes: row.activityMinutes }));
}

export async function congratulate(
    client: Client,
    config: StaffBotConfig,
    holder: StaffDoc,
    colour: ColourWrite,
    rng: () => number = Math.random
): Promise<boolean> {
    const saved = holder.sotwColour ?? null;
    const colourLine = !saved
        ? `The role has no colour yet — choose one with ${cmd("settings sotw-colour")} and it will ` +
          "be kept for next time."
        : !colour.ok
          ? "Your colour is saved and goes on the role as soon as the bot can reach it."
          : colour.downgraded
            ? (downgradeNote(saved) ?? "Your colour is on the role.")
            : "Your colour is on the role.";
    const card = congratsCard({
        message: pickCongratulation(rng),
        colourLine,
        preview: await previewFor(client, config, holder.discordId, saved)
    });
    const delivered = await tryDm(client, holder.discordId, sendOptions(card));
    if (!delivered) log.warn(`Could not DM the Staff of the Week congratulation to ${holder.discordId}`);
    return delivered;
}

export async function runHandoff(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    now = new Date(),
    rng: () => number = Math.random
): Promise<boolean> {
    if (!sotwEnabled(config)) return false;
    if (!(await claimSotwHandoff(week.start))) return false;

    const doc = await findWeek(week.start);
    let pickStaff: StaffDoc | null = null;
    let pickEligibility: Eligibility | null = null;
    if (doc?.status === "pending" && doc.staffId) {
        pickStaff = await findStaffById(doc.staffId);
        pickEligibility = pickStaff
            ? await eligibilityOf(client, config, pickStaff, week)
            : { eligible: false, reason: "inactive" };
    }

    const needsDraw = doc?.status !== "skipped";
    const pool = needsDraw ? await drawPoolFor(client, config, week, await closedStandings(week, config)) : [];
    const { decision, pickFailed } = decideHandoff({
        week: doc ? { status: doc.status, staffId: doc.staffId?.toHexString() ?? null } : null,
        pickEligibility,
        pool,
        rng
    });

    const pickName = pickStaff ? await nameOf(client, config, pickStaff) : "The recorded pick";
    const failedText = pickFailed ? refusalText(pickFailed, pickName) : null;
    if (pickFailed) {
        await appendEvent(
            week.start,
            sotwEvent("pickFailed", { staffId: doc?.staffId ?? null, reason: pickFailed }, now)
        );
    }

    const poolDetail = { pool: pool.map((row) => ({ staffId: row.staffId, minutes: row.minutes })) };
    let holder: StaffDoc | null = null;
    if (decision.kind === "picked") {
        holder = pickStaff;
        await recordGrant(
            week.start,
            { staffId: new ObjectId(decision.staffId), status: "picked", decidedBy: doc?.decidedBy ?? null, eventKind: null, reason: null, detail: null },
            now
        );
    } else if (decision.kind === "random") {
        holder = await findStaffById(new ObjectId(decision.staffId));
        await recordGrant(
            week.start,
            { staffId: new ObjectId(decision.staffId), status: "random", decidedBy: null, eventKind: "drawn", reason: null, detail: poolDetail },
            now
        );
    } else if (decision.kind === "empty") {
        await recordEmpty(week.start, "Nobody qualified for the draw.", poolDetail, now);
    }

    const label = labelWindow(week.start, week.end, config.accountingTimezone);
    const role = await handRoleTo(client, config, holder, `Staff of the Week for ${label}`);
    if (holder) await congratulate(client, config, holder, role.colour, rng);

    const poolNames: string[] = [];
    for (const row of pool) {
        const member = await findStaffById(new ObjectId(row.staffId));
        if (member) poolNames.push(await nameOf(client, config, member));
    }
    const holderName = holder ? await nameOf(client, config, holder) : "";
    const summary: HandoffSummary =
        decision.kind === "picked"
            ? { kind: "picked", holder: holderName, by: `<@${doc?.decidedBy}>` }
            : decision.kind === "random"
              ? { kind: "random", holder: holderName, pool: poolNames, failedPick: failedText }
              : decision.kind === "skipped"
                ? { kind: "skipped", by: `<@${doc?.decidedBy}>` }
                : { kind: "empty", failedPick: failedText };
    await postNotice(client, config, sotwCard(`Staff of the Week, ${label}`, handoffText(summary)));

    await markHandedOff(week.start, { decision: decision.kind, colourOk: role.colour.ok, granted: role.granted }, now);
    return true;
}

/** Never lets the handoff stop the recap or the assessment that follow it. */
export async function runHandoffSafely(
    client: Client,
    config: StaffBotConfig,
    week: WeekWindow,
    now = new Date()
): Promise<void> {
    try {
        if (await runHandoff(client, config, week, now)) log.info("Handed Staff of the Week over.");
    } catch (error) {
        log.error("The Staff of the Week handoff failed", error);
    }
}

/** The holder keeps the role and their colour; everyone else loses it. Idempotent. */
export async function reassertRole(client: Client, config: StaffBotConfig, now = new Date()): Promise<void> {
    const holder = await currentHolder(config, now);
    await handRoleTo(client, config, holder?.staff ?? null, "Staff of the Week: re-asserted on boot");
}

/**
 * At boot, after the catch-up. The current week only: a missed week in the
 * past cannot usefully be handed off. A first run — no rollups, or no Staff of
 * the Week record at all — records the week as empty without a draw, so the
 * first real handoff is the next week boundary.
 */
export async function handoffOnBoot(
    client: Client,
    config: StaffBotConfig,
    coldStart: boolean,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const week = weekWindowFor(now, config);
        if (await sotwHandedOff(week.start)) {
            await reassertRole(client, config, now);
            return;
        }
        if (coldStart || !(await anyStaffOfWeek())) {
            if (await claimSotwHandoff(week.start)) {
                await recordEmpty(week.start, "Staff of the Week started mid-week.", null, now);
                await markHandedOff(week.start, { decision: "coldStart" }, now);
            }
            await reassertRole(client, config, now);
            return;
        }
        await runHandoff(client, config, week, now);
    } catch (error) {
        log.error("The Staff of the Week boot handoff failed", error);
    }
}
```

- [ ] **Step 2: Wire it into the week close**

In `src/jobs/weeklyRollup.ts`, import:

```ts
import { handoffOnBoot, runHandoffSafely } from "../services/sotwHandoff.js";
import { weekWindowFor } from "../domain/weekly.js";
```

(merge `weekWindowFor` into the existing `../domain/weekly.js` import rather than adding a second import line).

In `closeWeek`, directly after the `log.info(\`Closed week starting …\`)` line and before the team recap block:

```ts
    // Staff of the Week changes hands for the week that has just begun. After
    // the rollup, because the draw reads the closed week's frozen figures; before
    // the recap, which names the new holder.
    await runHandoffSafely(client, config, weekWindowFor(closing.end, config), at);
```

In `catchUpMissedWeeks`:

1. Replace the early return:

```ts
    if (missing.length === 0) {
        log.info("No missing weekly rollups.");
        await handoffOnBoot(client, config, coldStart, at);
        return;
    }
```

2. Inside the loop, directly after `await rebuildWeekForAll(window, config, at);`:

```ts
        // The week that has just closed hands Staff of the Week over before its
        // recap is posted, as the live close does. Older weeks never do.
        if (!coldStart && window.end.getTime() === weekWindowFor(at, config).start.getTime()) {
            await runHandoffSafely(client, config, weekWindowFor(window.end, config), at);
        }
```

3. After the loop ends (the last statement of the function):

```ts
    await handoffOnBoot(client, config, coldStart, at);
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 4: Manual check against a local Mongo (no Discord needed)**

Start Mongo only: `docker-compose up -d mongo`. In a scratchpad script (not in the repo), connect with `connectDatabase()`, call `recordPick`, `recordGrant`, `recordRemoval` and `markHandedOff` against one test `weekStart`, then `findWeek` and print it. Check that:

- `holders` and `removedHolders` are arrays;
- `events` lists `set`, `removed` and `handoff` in order;
- the upsert never errors with "conflict at 'holders'".

Remove that test week with `mongosh` afterwards: `db.staffOfWeek.deleteOne({ weekStart: ISODate("…") })`.

- [ ] **Step 5: Commit**

```bash
git add src/services/sotwHandoff.ts src/jobs/weeklyRollup.ts
git commit -m "Hand Staff of the Week over at the week boundary, and on boot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `/sotw` for the Executives

**Files:**
- Create: `src/services/sotwDecisions.ts`
- Create: `src/commands/sotw.ts`
- Create: `src/events/sotwButtons.ts` (the `sotw` namespace and the remove modal; Task 14 adds the colour half)
- Modify: `src/commands/index.ts` (register `sotwCommand`)
- Modify: `src/events/interactionCreate.ts` (route `sotw:*` buttons and `sotwRemove` modal)
- Modify: `test/commandRequirements.test.ts`

**Interfaces:**
- Consumes: everything above; `getStoredWeek` (`domain/weekly.ts`); `findStaffByDiscordId`; `audit`.
- Produces (`sotwDecisions.ts`): `setNextWeek(client, config, actorId: string, subject: StaffDoc, reason: string | null, now?: Date): Promise<RenderedMessage>`, `skipNextWeek(client, config, actorId: string, reason: string | null, now?: Date): Promise<RenderedMessage>`, `grantRestOfWeek(client, config, actorId: string, subject: StaffDoc, reason: string | null, now?: Date): Promise<RenderedMessage>`, `removeHolder(client, config, actorId: string, reason: string, now?: Date): Promise<RenderedMessage>`, `viewFor(client, config, now?: Date): Promise<RenderedMessage>`, `offerOrSet(client, config, actorId: string, subject: StaffDoc, reason: string | null, now?: Date): Promise<RenderedMessage>`.
- Produces (`sotwButtons.ts`): `handleSotwButton(client, config, interaction: ButtonInteraction, action: string): Promise<void>`, `handleSotwRemoveModal(client, config, interaction: ModalSubmitInteraction): Promise<void>`.

- [ ] **Step 1: Write the failing test**

In `test/commandRequirements.test.ts`, change the "registers exactly one command per subject" list to:

```ts
            ["admin", "config", "coverage", "dev", "leave", "settings", "shift", "sotw", "stats", "warnings"]
```

Add inside `describe("the registered layout", …)`:

```ts
    it("keeps /sotw for Executives and leaves the colour to every member", async () => {
        const { commandsByName } = await import("../src/commands/index.js");
        const sotw = commandsByName.get("sotw")!;
        for (const sub of ["set", "skip", "remove", "view"]) {
            expect(requirementsFor(sotw, sub).tier).toBe("executive");
        }
        expect(sotw.seededOnly).not.toBe(true);
    });
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/commandRequirements.test.ts`
Expected: FAIL, because there is no `sotw` command.

- [ ] **Step 3: Implement the decisions**

`src/services/sotwDecisions.ts`:

```ts
import type { Client } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { StaffDoc } from "../db/types.js";
import { findStaffById } from "../domain/staff.js";
import { getStoredWeek, previousWeekWindow } from "../domain/weekly.js";
import { countMinutesBetween } from "../domain/activity.js";
import { audit } from "../domain/audit.js";
import {
    PENDING_LEAVE_NOTE,
    creditedHolders,
    refusalText,
    restOfWeekOffered
} from "../domain/staffOfWeek.js";
import {
    findWeek,
    recentWeeks,
    recordGrant,
    recordPick,
    recordRemoval,
    recordSkip,
    toHolderRecord
} from "../domain/staffOfWeekStore.js";
import { stageSet } from "../domain/sotwStaging.js";
import { errorCard, type RenderedMessage } from "../render/cards.js";
import { sotwCard, viewCard, weekChoiceCard, type Leader } from "../render/sotwCards.js";
import { EMOJI } from "../render/emoji.js";
import { labelWindow } from "../time/format.js";
import { currentHolder, eligibilityOf, nameOf, rosterFor, weekSlots } from "./sotwContext.js";
import { handRoleTo, takeRoleFrom } from "./sotwRole.js";
import { congratulate } from "./sotwHandoff.js";
import { decisionLine, postNotice } from "./sotwNotices.js";

/**
 * What an Executive can decide. Each returns the card they see; each posts a
 * notice to the channel so the others have the same record.
 */

const label = (config: StaffBotConfig, week: { start: Date; end: Date }) =>
    labelWindow(week.start, week.end, config.accountingTimezone);

/** `/sotw set`: straight to next week, or ask first when nobody holds this one. */
export async function offerOrSet(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const current = await findWeek(slots.current.start);
    const offered = restOfWeekOffered(
        current ? { status: current.status, staffId: current.staffId?.toHexString() ?? null } : null,
        slots.handedOff
    );
    if (!offered) return setNextWeek(client, config, actorId, subject, reason, now);

    stageSet(actorId, subject._id.toHexString(), reason);
    return weekChoiceCard({
        name: await nameOf(client, config, subject),
        currentLabel: label(config, slots.current),
        nextLabel: label(config, slots.next)
    });
}

export async function setNextWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const name = await nameOf(client, config, subject);
    const verdict = await eligibilityOf(client, config, subject, slots.next);
    if (!verdict.eligible) return errorCard(refusalText(verdict.reason, name));

    const { replaced } = await recordPick(slots.next.start, subject._id, actorId, reason, now);
    await audit("sotw.set", {
        actorId,
        targetStaffId: subject._id,
        detail: { weekStart: slots.next.start, reason, replaced: replaced?.toHexString() ?? null }
    });

    // The closed week is the one before `current`; its minutes are shown and
    // never required.
    const closed = previousWeekWindow(slots.current.start, config);
    const stored = await getStoredWeek(subject._id, closed.start);
    const minutes = stored?.activityMinutes ?? (await countMinutesBetween(subject._id, closed.start, closed.end));
    const replacedName = replaced ? await findStaffById(replaced).then((staff) => (staff ? nameOf(client, config, staff) : null)) : null;

    const body =
        `**${name}** will be Staff of the Week for ${label(config, slots.next)}.\n` +
        (replacedName ? `This replaces **${replacedName}**.\n` : "") +
        (verdict.pendingLeave ? `${EMOJI.warning} ${name} ${PENDING_LEAVE_NOTE}.\n` : "") +
        `-# Last week: ${minutes} of ${config.weeklyTargetMinutes} minutes. For information only; ` +
        "meeting the minimum is not required for a pick. They are told when the week begins.";

    await postNotice(
        client,
        config,
        sotwCard(
            "Staff of the Week picked",
            `<@${actorId}> picked **${name}** for ${label(config, slots.next)}.` +
                (replacedName ? ` This replaces **${replacedName}**.` : "") +
                (reason ? `\n> ${reason}` : "")
        )
    );
    return sotwCard("Staff of the Week picked", body, { ephemeral: true });
}

export async function skipNextWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    await recordSkip(slots.next.start, actorId, reason, now);
    await audit("sotw.skip", { actorId, detail: { weekStart: slots.next.start, reason } });
    const week = label(config, slots.next);
    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week skipped", `<@${actorId}> skipped ${week}: nobody will hold it, and there is no draw.` + (reason ? `\n> ${reason}` : ""))
    );
    return sotwCard(
        "Week skipped",
        `Nobody will hold Staff of the Week for ${week}, and there will be no draw. A pick before the ` +
            "week begins replaces this.",
        { ephemeral: true }
    );
}

export async function grantRestOfWeek(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    subject: StaffDoc,
    reason: string | null,
    now = new Date()
): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const current = await findWeek(slots.current.start);
    if (current?.staffId) return errorCard("Somebody already holds Staff of the Week this week.");

    const name = await nameOf(client, config, subject);
    const verdict = await eligibilityOf(client, config, subject, slots.current);
    if (!verdict.eligible) return errorCard(refusalText(verdict.reason, name));

    await recordGrant(
        slots.current.start,
        { staffId: subject._id, status: "picked", decidedBy: actorId, eventKind: "set", reason, detail: { restOfWeek: true } },
        now
    );
    const role = await handRoleTo(client, config, subject, `Staff of the Week for the rest of ${label(config, slots.current)}`);
    await congratulate(client, config, subject, role.colour);
    await audit("sotw.restOfWeek", { actorId, targetStaffId: subject._id, detail: { weekStart: slots.current.start, reason } });

    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week given", `<@${actorId}> gave **${name}** Staff of the Week for the rest of this week.` + (reason ? `\n> ${reason}` : ""))
    );
    return sotwCard(
        "Staff of the Week given",
        `**${name}** holds Staff of the Week for the rest of this week, and has been told.` +
            (role.granted ? "" : `\n${EMOJI.warning} The role could not be given in the community server.`),
        { ephemeral: true }
    );
}

export async function removeHolder(
    client: Client,
    config: StaffBotConfig,
    actorId: string,
    reason: string,
    now = new Date()
): Promise<RenderedMessage> {
    const holder = await currentHolder(config, now);
    if (!holder) return errorCard("Nobody holds Staff of the Week right now.");

    await recordRemoval(holder.week.start, holder.staff._id, actorId, reason, now);
    await takeRoleFrom(client, config, holder.staff, `Staff of the Week removed: ${reason}`.slice(0, 500));
    await audit("sotw.remove", { actorId, targetStaffId: holder.staff._id, detail: { weekStart: holder.week.start, reason } });

    const name = await nameOf(client, config, holder.staff);
    await postNotice(
        client,
        config,
        sotwCard("Staff of the Week removed", `<@${actorId}> took Staff of the Week from **${name}**.\n> ${reason}`)
    );
    return sotwCard(
        "Staff of the Week removed",
        `**${name}** no longer holds it. They are not barred from the next two weeks, and this week ` +
            "is not counted as theirs. Pick somebody for the rest of the week with the set command.",
        { ephemeral: true }
    );
}

export async function viewFor(client: Client, config: StaffBotConfig, now = new Date()): Promise<RenderedMessage> {
    const slots = await weekSlots(config, now);
    const [currentDoc, nextDoc] = await Promise.all([findWeek(slots.current.start), findWeek(slots.next.start)]);

    const describe = async (doc: typeof currentDoc) => {
        if (!doc) return "Nothing recorded.";
        const holder = doc.staffId ? await findStaffById(doc.staffId) : null;
        const who = holder ? `**${await nameOf(client, config, holder)}**` : "Nobody";
        switch (doc.status) {
            case "picked":
                return `${who}, picked by <@${doc.decidedBy}>.`;
            case "random":
                return `${who}, drawn at random.`;
            case "skipped":
                return `Nobody: skipped by <@${doc.decidedBy}>.`;
            case "empty":
                return (doc.removedHolders?.length ?? 0) > 0 ? "Nobody: the holder was removed." : "Nobody: nobody qualified.";
            case "pending":
                return await decisionLine(client, config, doc);
        }
    };

    const history: string[] = [];
    for (const doc of await recentWeeks(slots.current.start, 4)) {
        const names = [];
        for (const id of creditedHolders(toHolderRecord(doc))) {
            const staff = await findStaffById(new ObjectId(id));
            if (staff) names.push(await nameOf(client, config, staff));
        }
        history.push(`- ${label(config, weekWindowFor(doc.weekStart, config))}: ${names.join(", ") || "nobody"}`);
    }

    const eligible: Leader[] = [];
    for (const entry of await rosterFor(client, config, slots.next)) {
        if (!entry.eligibility.eligible) continue;
        eligible.push({
            name: await nameOf(client, config, entry.staff),
            minutes: await countMinutesBetween(entry.staff._id, slots.current.start, now),
            pendingLeave: entry.eligibility.pendingLeave
        });
    }
    eligible.sort((left, right) => right.minutes - left.minutes);

    return viewCard({
        current: await describe(currentDoc),
        next: nextDoc ? await describe(nextDoc) : await decisionLine(client, config, null),
        history,
        eligible: eligible.slice(0, 10),
        target: config.weeklyTargetMinutes
    });
}
```

Add `weekWindowFor` to the `../domain/weekly.js` import at the top of `sotwDecisions.ts`; the history line uses it so each entry is labelled with its own week.

- [ ] **Step 4: Implement the command**

`src/commands/sotw.ts`:

```ts
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { sotwEnabled } from "../domain/staffOfWeek.js";
import { errorCard } from "../render/cards.js";
import { sotwRemoveModal } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { defer, respond } from "../discord/respond.js";
import { currentHolder, nameOf } from "../services/sotwContext.js";
import { offerOrSet, skipNextWeek, viewFor } from "../services/sotwDecisions.js";

/**
 * Staff of the Week, for the Executives. The discussion happens in their own
 * chat; this records what they decided. Wholly Executive, so a pending pick is
 * never shown to anybody it might be about.
 */
export const sotwCommand: Command = {
    tier: "executive",
    data: new SlashCommandBuilder()
        .setName("sotw")
        .setDescription("Staff of the Week: pick, skip, remove or view (Executive)")
        .addSubcommand((sub) =>
            sub
                .setName("set")
                .setDescription("Pick next week's Staff of the Week")
                .addUserOption((option) => option.setName("user").setDescription("Who").setRequired(true))
                .addStringOption((option) =>
                    option.setName("reason").setDescription("Why, for the other Executives").setMaxLength(500)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName("skip")
                .setDescription("Nobody holds it next week, and there is no draw")
                .addStringOption((option) => option.setName("reason").setDescription("Why").setMaxLength(500))
        )
        .addSubcommand((sub) => sub.setName("remove").setDescription("Take it from this week's holder"))
        .addSubcommand((sub) => sub.setName("view").setDescription("Who holds it, who is next, who is eligible")),

    async execute({ client, config, interaction }) {
        if (!sotwEnabled(config)) {
            await respond(
                interaction,
                sotwCard(
                    "Staff of the Week is not set up",
                    "Its role has not been chosen yet, so there is nothing to pick. A deployment " +
                        "administrator sets it in the configuration.",
                    { ephemeral: true }
                )
            );
            return;
        }

        const sub = interaction.options.getSubcommand();

        if (sub === "remove") {
            // A modal cannot follow a defer, so this checks and opens only.
            const holder = await currentHolder(config);
            if (!holder) {
                await respond(interaction, errorCard("Nobody holds Staff of the Week right now."));
                return;
            }
            await interaction.showModal(sotwRemoveModal(await nameOf(client, config, holder.staff)));
            return;
        }

        await defer(interaction, true);

        if (sub === "view") {
            await respond(interaction, await viewFor(client, config));
            return;
        }

        const reason = interaction.options.getString("reason");
        if (sub === "skip") {
            await respond(interaction, await skipNextWeek(client, config, interaction.user.id, reason));
            return;
        }

        const user = interaction.options.getUser("user", true);
        const subject = await findStaffByDiscordId(user.id);
        if (!subject) {
            await respond(interaction, errorCard(`<@${user.id}> is not tracked as Moderation staff.`));
            return;
        }
        await respond(interaction, await offerOrSet(client, config, interaction.user.id, subject, reason));
    }
};
```

`showModal` has a three-second window, and `nameOf` fetches up to two guild members. If the manual check (Step 8) shows it is too slow, open the modal with `holder.staff.discordId` rendered as `<@id>` instead of fetching the name.

- [ ] **Step 5: Implement the buttons and the remove modal**

`src/events/sotwButtons.ts`:

```ts
import type { ButtonInteraction, Client, ModalSubmitInteraction } from "discord.js";
import { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { findStaffById } from "../domain/staff.js";
import { takeSet } from "../domain/sotwStaging.js";
import { errorCard } from "../render/cards.js";
import { FIELD_REASON } from "../render/modals.js";
import { sotwCard } from "../render/sotwCards.js";
import { deferOntoOwnCard, respond } from "../discord/respond.js";
import { grantRestOfWeek, removeHolder, setNextWeek } from "../services/sotwDecisions.js";

/** Every rule re-derived on the click, never carried from the card. */
async function isExecutive(client: Client, config: StaffBotConfig, userId: string): Promise<boolean> {
    return resolveTier(userId, await fetchPublicMember(client, config, userId), config) === "executive";
}

export async function handleSotwButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string
): Promise<void> {
    if (!(await isExecutive(client, config, interaction.user.id))) {
        await respond(interaction, errorCard("Staff of the Week is decided by the Executives."));
        return;
    }
    await interaction.deferUpdate();

    const pending = takeSet(interaction.user.id);
    if (action === "cancel") {
        await respond(interaction, sotwCard("Nothing recorded", "Staff of the Week is unchanged."));
        return;
    }
    if (!pending) {
        await respond(interaction, errorCard("That choice has expired. Run the set command again."));
        return;
    }
    const subject = await findStaffById(new ObjectId(pending.staffId));
    if (!subject) {
        await respond(interaction, errorCard("That member no longer has a staff record."));
        return;
    }
    const card =
        action === "rest"
            ? await grantRestOfWeek(client, config, interaction.user.id, subject, pending.reason)
            : await setNextWeek(client, config, interaction.user.id, subject, pending.reason);
    await respond(interaction, card);
}

export async function handleSotwRemoveModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    if (!(await isExecutive(client, config, interaction.user.id))) {
        await respond(interaction, errorCard("Staff of the Week is decided by the Executives."));
        return;
    }
    await deferOntoOwnCard(interaction);
    const reason = interaction.fields.getTextInputValue(FIELD_REASON).trim();
    await respond(interaction, await removeHolder(client, config, interaction.user.id, reason));
}
```

- [ ] **Step 6: Register and route**

In `src/commands/index.ts`, import `sotwCommand` from `./sotw.js` and add it to `commands` after `devCommand`.

In `src/events/interactionCreate.ts`:

- Import `SOTW_REMOVE_MODAL` from `../render/modals.js`, and `handleSotwButton` and `handleSotwRemoveModal` from `./sotwButtons.js`.
- In `routeModal`, before the conduct-warning branch:

```ts
    if (interaction.customId === SOTW_REMOVE_MODAL) {
        await handleSotwRemoveModal(client, config, interaction);
        return;
    }
```

- In `routeButton`, before the `leave` branch:

```ts
    if (namespace === "sotw") {
        await handleSotwButton(client, config, interaction, first);
        return;
    }
```

- Add `sotw` to the list of namespaces in the `CLAUDE.md` "Interaction routing" paragraph. That happens in Task 20.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass, including the updated `commandRequirements` test.

- [ ] **Step 8: Manual check**

With a dev deployment (`docker-compose up -d --build`):

1. Set `staffOfWeekRole`.
2. Run `/sotw view`.
3. Run `/sotw set` for a Moderator.
4. Check the notice lands in `staffOfWeekChannelId` and `/sotw view` shows the pending pick.
5. Run `/sotw set` for an Executive and check it is refused with the words from `refusalText`.

- [ ] **Step 9: Commit**

```bash
git add src/services/sotwDecisions.ts src/commands/sotw.ts src/events/sotwButtons.ts src/commands/index.ts src/events/interactionCreate.ts test/commandRequirements.test.ts
git commit -m "Let the Executives pick, skip, remove and view Staff of the Week

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `/settings sotw-colour` and the export

**Files:**
- Create: `src/services/sotwColourService.ts`
- Modify: `src/events/sotwButtons.ts` (add the colour handlers)
- Modify: `src/commands/settings.ts` (subcommand, handler, export)
- Modify: `src/events/interactionCreate.ts` (route `sotwColour:*` and `sotwCode`)
- Modify: `test/commandRequirements.test.ts`

**Interfaces:**
- Consumes: Tasks 4–10; `setSotwColour`; `forgetStaffLookup`.
- Produces (`sotwColourService.ts`): `colourCardFor(client, config, staff: StaffDoc, options?: { staged?: { colour: SotwColour | null } | null; message?: string | null }): Promise<RenderedMessage>`, `saveStagedColour(client, config, staff: StaffDoc, now?: number): Promise<string>`.
- Produces (`sotwButtons.ts`): `handleSotwColourButton(client, config, interaction: ButtonInteraction, action: string): Promise<void>`, `handleSotwCodeModal(client, config, interaction: ModalSubmitInteraction): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Add to `test/commandRequirements.test.ts`, inside the registered layout block:

```ts
    it("lets every member set their own Staff of the Week colour", async () => {
        const { commandsByName } = await import("../src/commands/index.js");
        const settings = commandsByName.get("settings")!;
        const json = settings.data.toJSON() as { options: { name: string }[] };
        expect(json.options.map((option) => option.name)).toContain("sotw-colour");
        expect(requirementsFor(settings, "sotw-colour").tier).toBe("staff");
    });
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/commandRequirements.test.ts`
Expected: FAIL, because `/settings` has no `sotw-colour` subcommand yet.

- [ ] **Step 3: Implement the service**

`src/services/sotwColourService.ts`:

```ts
import type { Client } from "discord.js";
import type { StaffBotConfig } from "../config/guildConfig.js";
import type { SotwColour, StaffDoc } from "../db/types.js";
import { fetchPublicMember, resolveTier } from "../domain/permissions.js";
import { forgetStaffLookup, setSotwColour } from "../domain/staff.js";
import { colourStatus } from "../domain/staffOfWeek.js";
import { describeColour, downgradeNote } from "../domain/sotwColour.js";
import { pickerUrl } from "../domain/sotwFragment.js";
import { clearStaged, noteRoleWrite, roleWriteCooldown, stagedColour } from "../domain/sotwStaging.js";
import { appendEvent, sotwEvent } from "../domain/staffOfWeekStore.js";
import { audit } from "../domain/audit.js";
import { describePreview, renderSotwPreview } from "../render/sotwPreview.js";
import { colourSettingsCard } from "../render/sotwCards.js";
import type { RenderedMessage } from "../render/cards.js";
import { currentHolder } from "./sotwContext.js";
import { previewAssets } from "./sotwPreviewService.js";
import { applyRoleColour } from "./sotwRole.js";

/**
 * A member's own Staff of the Week colour: a preference on their record, set
 * whenever they like, holder or not. Saving it also recolours the role only if
 * they hold it at the moment they press Save.
 */

export async function colourCardFor(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    options: { staged?: { colour: SotwColour | null } | null; message?: string | null } = {}
): Promise<RenderedMessage> {
    const member = await fetchPublicMember(client, config, staff.discordId);
    const tier = resolveTier(staff.discordId, member, config);
    const holder = await currentHolder(config);
    const holding = holder?.staff._id.equals(staff._id) ?? false;

    const saved = staff.sotwColour ?? null;
    const shown = options.staged ? options.staged.colour : saved;
    const assets = await previewAssets(client, config, staff.discordId);
    const preview = shown
        ? (() => {
              const input = { name: assets.nickname, colour: shown, avatar: assets.avatar, badge: assets.badge };
              return { png: renderSotwPreview(input), alt: describePreview(input) };
          })()
        : null;

    return colourSettingsCard({
        status: colourStatus({ holding, tier }),
        savedLabel: saved ? describeColour(saved) : "No colour saved — the role would have no colour",
        staged: options.staged ? { label: describeColour(options.staged.colour) } : null,
        pickerUrl: config.staffOfWeekColourPickerUrl
            ? pickerUrl(config.staffOfWeekColourPickerUrl, { ...assets.fragment, colour: saved, enhanced: assets.enhanced })
            : null,
        preview,
        message: options.message ?? null,
        note: shown && !assets.enhanced ? downgradeNote(shown) : null
    });
}

/** Save what is staged. Returns the line the card shows afterwards. */
export async function saveStagedColour(
    client: Client,
    config: StaffBotConfig,
    staff: StaffDoc,
    now = Date.now()
): Promise<string> {
    const staged = stagedColour(staff.discordId, now);
    if (!staged) return "That choice has expired. Enter the code again.";

    // Re-derived at the click, never carried from the card.
    const holder = await currentHolder(config, new Date(now));
    const holding = holder?.staff._id.equals(staff._id) ?? false;

    if (holding) {
        const wait = roleWriteCooldown(staff.discordId, now);
        if (wait > 0) {
            return `Wait ${Math.ceil(wait / 1000)} seconds before changing the role's colour again. Your choice is still here.`;
        }
    }

    await setSotwColour(staff._id, staged.colour);
    forgetStaffLookup(staff.discordId);
    clearStaged(staff.discordId);
    await audit("sotw.colourSaved", {
        actorId: staff.discordId,
        targetStaffId: staff._id,
        detail: { colour: staged.colour }
    });

    if (!holding || !holder) return "Saved. It goes on the role the next time you hold Staff of the Week.";

    noteRoleWrite(staff.discordId, now);
    const write = await applyRoleColour(client, config, staged.colour, "Staff of the Week colour changed by its holder", staff.discordId);
    await appendEvent(
        holder.week.start,
        sotwEvent(staged.colour ? "colour" : "colourCleared", { actorId: staff.discordId, staffId: staff._id, detail: { colour: staged.colour } })
    );
    if (!write.ok) {
        return "Saved. The role could not be updated just now; your colour goes on it at the next restart or handoff.";
    }
    return write.downgraded && staged.colour
        ? `Saved, and on the role. ${downgradeNote(staged.colour)}`
        : "Saved, and the role now wears it.";
}
```

- [ ] **Step 4: Add the colour handlers**

Append to `src/events/sotwButtons.ts` (and add the imports):

```ts
import { MessageFlags } from "discord.js";
import { findStaffByDiscordId } from "../domain/staff.js";
import { parseColourCode, formatColourCode } from "../domain/sotwColour.js";
import { clearStaged, stageColour, stagedColour } from "../domain/sotwStaging.js";
import { FIELD_CODE, sotwCodeModal } from "../render/modals.js";
import type { RenderedMessage } from "../render/cards.js";
import { colourCardFor, saveStagedColour } from "../services/sotwColourService.js";

/** Replace the card and its image, rather than stacking a second attachment. */
async function redraw(interaction: ButtonInteraction | ModalSubmitInteraction, card: RenderedMessage): Promise<void> {
    await interaction.editReply({
        components: card.components,
        files: card.files,
        attachments: [],
        flags: MessageFlags.IsComponentsV2
    } as never);
}

export async function handleSotwColourButton(
    client: Client,
    config: StaffBotConfig,
    interaction: ButtonInteraction,
    action: string
): Promise<void> {
    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return;

    if (action === "code") {
        const staged = stagedColour(staff.discordId);
        const current = staged ? staged.colour : (staff.sotwColour ?? null);
        await interaction.showModal(sotwCodeModal(current ? formatColourCode(current) : null));
        return;
    }

    await interaction.deferUpdate();
    if (action === "clear") {
        stageColour(staff.discordId, null);
        await redraw(interaction, await colourCardFor(client, config, staff, { staged: { colour: null } }));
        return;
    }
    if (action === "cancel") {
        clearStaged(staff.discordId);
        await redraw(interaction, await colourCardFor(client, config, staff));
        return;
    }
    if (action === "save") {
        const message = await saveStagedColour(client, config, staff);
        const fresh = (await findStaffByDiscordId(staff.discordId)) ?? staff;
        const still = stagedColour(staff.discordId);
        await redraw(interaction, await colourCardFor(client, config, fresh, { staged: still, message }));
    }
}

export async function handleSotwCodeModal(
    client: Client,
    config: StaffBotConfig,
    interaction: ModalSubmitInteraction
): Promise<void> {
    const staff = await findStaffByDiscordId(interaction.user.id);
    if (!staff) return;
    await deferOntoOwnCard(interaction);

    const parsed = parseColourCode(interaction.fields.getTextInputValue(FIELD_CODE));
    if (!parsed.ok) {
        await redraw(interaction, await colourCardFor(client, config, staff, { staged: stagedColour(staff.discordId), message: parsed.error }));
        return;
    }
    stageColour(staff.discordId, parsed.colour);
    await redraw(interaction, await colourCardFor(client, config, staff, { staged: { colour: parsed.colour } }));
}
```

`deferOntoOwnCard` defers an update when the modal came from the ephemeral colour card, so `redraw`'s `editReply` edits that card.

- [ ] **Step 5: Add the subcommand and the export**

In `src/commands/settings.ts`, add after the `face` subcommand:

```ts
        .addSubcommand((sub) =>
            sub
                .setName("sotw-colour")
                .setDescription("The colour your name takes whenever you are Staff of the Week")
        )
```

Update the command description to "Your timezone, ring colours, Staff of the Week colour, privacy and data". Check it stays within 100 characters; the existing test asserts that.

In `execute`, before the `export` branch:

```ts
        if (sub === "sotw-colour") {
            if (!sotwEnabled(context.config)) {
                await respond(
                    interaction,
                    noticeCard(
                        "Staff of the Week is not set up",
                        "There is no Staff of the Week role yet, so there is no colour to choose.",
                        { ephemeral: true, colour: COLOUR.staffOfWeek }
                    )
                );
                return;
            }
            await defer(interaction, true);
            await respond(interaction, await colourCardFor(context.client, context.config, staff));
            return;
        }
```

Import `sotwEnabled`, `colourCardFor` and `weeksHeldBy`.

In `exportData`, add to the `Promise.all` a seventh read, `weeksHeldBy(staff._id)`, named `sotwWeeks`. In `profile`, add `sotwColour: staff.sotwColour ?? null, sotwColourUpdatedAt: staff.sotwColourUpdatedAt ?? null`. Add a top-level key after `leave`:

```ts
        staffOfWeek: sotwWeeks.map((week) => ({
            weekStart: week.weekStart,
            status: week.status,
            removed: (week.removedHolders ?? []).some((id) => id.equals(staff._id)),
            events: (week.events ?? [])
                .filter((event) => event.staffId?.equals(staff._id))
                .map((event) => ({ kind: event.kind, at: event.at, reason: event.reason }))
        }))
```

Add `, ${sotwWeeks.length} Staff of the Week records` to the summary sentence, before the full stop after the leave count.

`exportData` destructures `{ interaction, staff }`. Also destructure `context` where needed, or pass `client`/`config` through. The existing signature already receives the whole `CommandContext`.

- [ ] **Step 6: Route**

In `src/events/interactionCreate.ts`:

- Import `SOTW_CODE_MODAL`, and add `handleSotwColourButton` and `handleSotwCodeModal` to the `./sotwButtons.js` import.
- In `routeModal`, beside the remove modal branch:

```ts
    if (interaction.customId === SOTW_CODE_MODAL) {
        await handleSotwCodeModal(client, config, interaction);
        return;
    }
```

- In `routeButton`, beside the `sotw` branch:

```ts
    if (namespace === "sotwColour") {
        await handleSotwColourButton(client, config, interaction, first);
        return;
    }
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 8: Manual check**

On the dev deployment:

1. As a non-holder: `/settings sotw-colour` → Enter code `SOTW1-G-FF66AA-3366FF` → the preview shows the gradient → Save. The card says it is saved for next time.
2. As the holder: Save a solid colour. The role recolours in the community server. Save again within 30 seconds and check the card says how long to wait.
3. Open the picker link and confirm it carries a `#v=1&…` fragment.

- [ ] **Step 9: Commit**

```bash
git add src/services/sotwColourService.ts src/events/sotwButtons.ts src/commands/settings.ts src/events/interactionCreate.ts test/commandRequirements.test.ts
git commit -m "Let every member save their own Staff of the Week colour

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Recognition on the leaderboard, the log, the recap and `/stats`

**Files:**
- Modify: `src/render/cards.ts` (`LeaderboardRowView`, `leaderboardCard.renderRow`, `teamRecapCard`, `RingCardInput`, `ringFigures`)
- Modify: `src/commands/leaderboard.ts` (`renderLeaderboard.toView`)
- Modify: `src/services/leaderboardLogService.ts` (`buildLeaderboardLog`)
- Modify: `src/services/teamRecapService.ts` (`buildTeamRecap`)
- Modify: `src/commands/stats.ts` (`showRings`)
- Test: `test/sotwRecognition.test.ts`

**Interfaces:**
- Consumes: `currentHolder`, `findWeek`, `weeksHeldBy`, `toHolderRecord`, `creditedHolders`, `timesHeld`, `recapHolder`.
- Produces: `LeaderboardRowView.staffOfWeek?: boolean`; `teamRecapCard` input `staffOfWeek?: string | null`; `RingCardInput.staffOfWeek?: { times: number; last: Date | null }`.

- [ ] **Step 1: Write the failing test**

`test/sotwRecognition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leaderboardCard, ringFigures, teamRecapCard } from "../src/render/cards.js";
import { EMOJI } from "../src/render/emoji.js";

const row = (overrides: Record<string, unknown> = {}) => ({
    rank: 1,
    label: "Robin",
    activityMinutes: 300,
    target: 120,
    state: "green" as const,
    isViewer: false,
    onLeave: false,
    ...overrides
});

const text = (card: { components: { toJSON(): unknown }[] }) => JSON.stringify(card.components.map((c) => c.toJSON()));

describe("the holder on the leaderboard", () => {
    const card = (rows: ReturnType<typeof row>[]) =>
        leaderboardCard({
            title: "Activity leaderboard",
            windowLabel: "This week",
            rows,
            viewerRow: null,
            page: 1,
            pageCount: 1,
            scope: "week",
            totalMinutes: 300,
            participants: rows.length
        });

    it("marks the holder's row beside the name", () => {
        expect(text(card([row({ staffOfWeek: true })]))).toContain(`**Robin** ${EMOJI.staffOfWeek}`);
    });

    it("marks nobody else", () => {
        expect(text(card([row()]))).not.toContain(EMOJI.staffOfWeek);
    });

    it("sits beside the padlock on a hidden holder's row", () => {
        expect(text(card([row({ staffOfWeek: true, hidden: true })]))).toContain(
            `**Robin** ${EMOJI.hidden} ${EMOJI.staffOfWeek}`
        );
    });
});

describe("the holder on the team recap", () => {
    const recap = (staffOfWeek: string | null) =>
        teamRecapCard({
            windowLabel: "Week",
            headline: "Headline",
            totalMinutes: "10 hours",
            teamTargetMinutes: "12 hours",
            topStreak: null,
            rings: null,
            rehearsal: false,
            staffOfWeek
        });

    it("names the new holder in the same message", () => {
        expect(text(recap("Robin"))).toContain(`${EMOJI.staffOfWeek} **Staff of the Week:** Robin`);
    });

    it("says nothing when nobody holds it", () => {
        expect(text(recap(null))).not.toContain(EMOJI.staffOfWeek);
    });
});

describe("the holder's own figures", () => {
    const base = {
        staffId: "a",
        displayName: "Robin",
        weekStart: new Date("2026-09-28T00:00:00Z"),
        weekEnd: new Date("2026-10-05T00:00:00Z"),
        activityMinutes: 10,
        activityTarget: 120,
        shiftMs: 0,
        shiftTargetHours: 4,
        activeDays: 1,
        activeDaysTarget: 3,
        state: "red" as const,
        softRingsEnabled: true
    };

    it("counts the weeks they have held it", () => {
        const line = ringFigures({ ...base, staffOfWeek: { times: 3, last: new Date("2026-09-21T00:00:00Z") } });
        expect(line).toContain(`${EMOJI.staffOfWeek} Staff of the Week **3 times**`);
        expect(line).toContain("<t:");
    });

    it("says it once for once", () => {
        expect(ringFigures({ ...base, staffOfWeek: { times: 1, last: new Date("2026-09-21T00:00:00Z") } })).toContain(
            "**once**"
        );
    });

    it("says nothing for somebody who never has", () => {
        expect(ringFigures({ ...base, staffOfWeek: { times: 0, last: null } })).not.toContain(EMOJI.staffOfWeek);
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwRecognition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the render changes**

In `src/render/cards.ts`:

Add to `LeaderboardRowView`:

```ts
    /** The Staff of the Week holder for the window, marked with the trophy. */
    staffOfWeek?: boolean;
```

In `leaderboardCard`'s `renderRow`:

```ts
        const marker =
            (row.hidden ? ` ${EMOJI.hidden}` : "") + (row.staffOfWeek ? ` ${EMOJI.staffOfWeek}` : "");
```

Add to `teamRecapCard`'s input type:

```ts
    /** The new holder's name, when the recap is for the week that just closed. */
    staffOfWeek?: string | null;
```

In `teamRecapCard`, after the headline text display is added and before `if (input.rings)`:

```ts
    if (input.staffOfWeek) {
        container.addTextDisplayComponents(
            text(`${EMOJI.staffOfWeek} **Staff of the Week:** ${input.staffOfWeek}`)
        );
    }
```

Add to `RingCardInput`:

```ts
    /** How many weeks they have been credited with Staff of the Week, and the latest. */
    staffOfWeek?: { times: number; last: Date | null };
```

In `ringFigures`, before `return lines.join("\n");`:

```ts
    if (input.staffOfWeek && input.staffOfWeek.times > 0) {
        const times = input.staffOfWeek.times === 1 ? "once" : `${input.staffOfWeek.times} times`;
        lines.push(
            `${EMOJI.staffOfWeek} Staff of the Week **${times}**` +
                (input.staffOfWeek.last ? `, most recently the week of ${ts(input.staffOfWeek.last, "D")}.` : ".")
        );
    }
```

- [ ] **Step 4: Implement the data changes**

`src/commands/leaderboard.ts`, in `renderLeaderboard` before `toView`:

```ts
    // The trophy marks this week's holder whichever window is shown: it is who
    // holds the role now, not a ranking of the window.
    const holder = await currentHolder(config);
```

In `toView`'s returned object add `staffOfWeek: holder?.staff._id.equals(entry.staff._id) ?? false,`. Import `currentHolder` from `../services/sotwContext.js`.

`src/services/leaderboardLogService.ts`, in `buildLeaderboardLog` after reading `rollups`:

```ts
    // The log is frozen history: it marks whoever held that closed week.
    const credited = new Set(creditedHolders(toHolderRecord(await findWeek(week.start))));
```

In each pushed view add `staffOfWeek: credited.has(row.member.staff._id.toHexString())`. Import `creditedHolders` from `../domain/staffOfWeek.js`, and `findWeek` and `toHolderRecord` from `../domain/staffOfWeekStore.js`.

`src/services/teamRecapService.ts`, in `buildTeamRecap` before `return teamRecapCard(`:

```ts
    // The week that has just begun, named only on the recap of the week that
    // has just closed; a catch-up recap for an older week names nobody.
    const next = await findWeek(week.end);
    const holderId = recapHolder({
        recapWeekEnd: week.end,
        currentWeekStart: weekWindowFor(new Date(), config).start,
        nextWeek: next ? { status: next.status, staffId: next.staffId?.toHexString() ?? null } : null
    });
    const holder = holderId ? await findStaffById(new ObjectId(holderId)) : null;
    const staffOfWeek = holder
        ? await staffDisplayName(client, config, holder.discordId, `<@${holder.discordId}>`)
        : null;
```

Pass `staffOfWeek` into `teamRecapCard({...})`. Imports: `ObjectId` from `mongodb`; `findWeek`; `recapHolder`; `weekWindowFor` (add to the existing `../domain/weekly.js` import); `staffDisplayName` from `../discord/displayName.js`.

`postTeamRecap` sends `{ ...card }`. A fallback mention should not ping, so change it to `{ ...card, allowedMentions: { users: [] } }`.

`src/commands/stats.ts`, in `showRings` before `respond`:

```ts
    const held = timesHeld(
        (await weeksHeldBy(subject._id)).map((doc) => ({ weekStart: doc.weekStart, ...(toHolderRecord(doc) ?? { holders: [], removedHolders: [] }) })),
        subject._id.toHexString()
    );
```

Pass `staffOfWeek: held` into `ringCard({...})`. Imports: `timesHeld` from `../domain/staffOfWeek.js`, and `weeksHeldBy` and `toHolderRecord` from `../domain/staffOfWeekStore.js`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass, including `leaderboardRows`, `teamRecap` and `rings` tests.

- [ ] **Step 6: Commit**

```bash
git add src/render/cards.ts src/commands/leaderboard.ts src/services/leaderboardLogService.ts src/services/teamRecapService.ts src/commands/stats.ts test/sotwRecognition.test.ts
git commit -m "Mark Staff of the Week on the leaderboard, the log, the recap and /stats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Late changes

**Files:**
- Create: `src/services/sotwWatch.ts`
- Create: `src/events/sotwMembers.ts`
- Modify: `src/services/leaveReassess.ts` (end of `reassessAfterLeaveChange`)
- Modify: `src/index.ts` (register the member handler)

**Interfaces:**
- Consumes: `lateCauseFor` (Task 5), `postNoticeOnce` (Task 11), `weekSlots`, `currentHolder`, `nameOf` (Task 10), `weekLeaveFor`, `findWeek`, `tierOf`.
- Produces: `checkLeaveAgainstSotw(client, config, staffId: ObjectId, now?: Date): Promise<void>`, `checkHolderStanding(client, config, discordId: string, cause: LateCause, now?: Date): Promise<void>`, `registerSotwMemberHandler(client: Client): void`.

The pure rule (`lateCauseFor`) is tested in Task 5. This task wires it to events and adds no new pure logic.

**Deviation to confirm with the user before implementing this task.** The spec says these checks run "on the leave/staff/member paths that already observe these". Two gaps:

- No code path observes a member leaving the community server or losing a role. `events/` has no GuildMemberRemove or GuildMemberUpdate handler.
- `setStaffActive` has no callers, so nothing observes deactivation.

This task adds a small member handler scoped to the current holder only. Deactivation is then caught at the handoff (the pick re-check) and by `/sotw view`, and nowhere live.

- [ ] **Step 1: Implement the watch service**

`src/services/sotwWatch.ts`:

```ts
import type { Client } from "discord.js";
import type { ObjectId } from "mongodb";
import type { StaffBotConfig } from "../config/guildConfig.js";
import { findStaffByDiscordId, findStaffById } from "../domain/staff.js";
import { weekLeaveFor } from "../domain/leave.js";
import { sotwEnabled, type LateCause } from "../domain/staffOfWeek.js";
import { findWeek } from "../domain/staffOfWeekStore.js";
import { sotwCard } from "../render/sotwCards.js";
import { cmd } from "../discord/commandMentions.js";
import { currentHolder, nameOf, weekSlots } from "./sotwContext.js";
import { postNoticeOnce } from "./sotwNotices.js";
import { log } from "../log.js";

/**
 * Things that happen to a holder or a pending pick after the Executives
 * decided. Never automatic: the bot tells them, once per subject per week, and
 * `/sotw remove` is theirs to use.
 */

export async function checkLeaveAgainstSotw(
    client: Client,
    config: StaffBotConfig,
    staffId: ObjectId,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const slots = await weekSlots(config, now);
        const holder = await currentHolder(config, now);
        const next = await findWeek(slots.next.start);
        const checks = [
            { week: slots.current, applies: holder?.staff._id.equals(staffId) ?? false, what: "this week's holder" },
            {
                week: slots.next,
                applies: next?.status === "pending" && (next.staffId?.equals(staffId) ?? false),
                what: "next week's pick"
            }
        ];
        for (const check of checks) {
            if (!check.applies) continue;
            const leave = await weekLeaveFor(staffId, check.week.start, check.week.end, config.minimumLeaveDays);
            if (!leave.exempt) continue;
            const staff = await findStaffById(staffId);
            const name = staff ? await nameOf(client, config, staff) : "A member";
            await postNoticeOnce(
                client,
                config,
                `late:${check.week.start.getTime()}:${staffId.toHexString()}:leave`,
                sotwCard(
                    "Staff of the Week and leave",
                    `**${name}**, ${check.what}, now has enough approved leave to be exempt from that ` +
                        `week. Nothing has changed; use ${cmd("sotw remove")} or ${cmd("sotw set")} if it should.`
                )
            );
        }
    } catch (error) {
        log.error("Could not check leave against Staff of the Week", error);
    }
}

const CAUSE_TEXT: Record<LateCause, string> = {
    left: "has left the community server, so Discord has already taken the role",
    notStaff: "is no longer Moderation staff",
    executive: "is now an Executive, and Executives are never Staff of the Week"
};

export async function checkHolderStanding(
    client: Client,
    config: StaffBotConfig,
    discordId: string,
    cause: LateCause,
    now = new Date()
): Promise<void> {
    if (!sotwEnabled(config)) return;
    try {
        const holder = await currentHolder(config, now);
        const staff = await findStaffByDiscordId(discordId);
        if (!holder || !staff || !holder.staff._id.equals(staff._id)) return;
        const name = await nameOf(client, config, staff);
        await postNoticeOnce(
            client,
            config,
            `late:${holder.week.start.getTime()}:${staff._id.toHexString()}:${cause}`,
            sotwCard(
                "Staff of the Week holder changed",
                `**${name}**, this week's holder, ${CAUSE_TEXT[cause]}. The record still says they hold ` +
                    `it; use ${cmd("sotw remove")} to record that and pick somebody for the rest of the week.`
            )
        );
    } catch (error) {
        log.error("Could not check the Staff of the Week holder", error);
    }
}
```

- [ ] **Step 2: Implement the member handler**

`src/events/sotwMembers.ts`:

```ts
import { Events, type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { loadConfig } from "../config/guildConfig.js";
import { tierOf, wearsOnLeaveRole } from "../domain/permissions.js";
import { lateCauseFor } from "../domain/staffOfWeek.js";
import { checkHolderStanding } from "../services/sotwWatch.js";

/**
 * The holder leaving the community server, or their roles changing so they can
 * no longer hold it. Scoped to the holder alone: every other member change in
 * a server of 110,000 is none of this feature's business.
 */
export function registerSotwMemberHandler(client: Client): void {
    client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
        const config = await loadConfig();
        if (member.guild.id !== config.publicGuildId) return;
        await checkHolderStanding(client, config, member.id, "left");
    });

    client.on(Events.GuildMemberUpdate, async (before, after) => {
        const config = await loadConfig();
        if (after.guild.id !== config.publicGuildId) return;
        // Leave takes the department role, which reads here as losing Staff
        // tier. That is leave's to report, through the leave path, not this one.
        if (wearsOnLeaveRole(after, config)) return;
        const was = before.partial ? null : tierOf(before as GuildMember, config);
        const now = tierOf(after, config);
        if (was === now) return;
        const cause = lateCauseFor({ present: true, tier: now });
        if (cause) await checkHolderStanding(client, config, after.id, cause);
    });
}
```

- [ ] **Step 3: Wire it in**

In `src/index.ts`, import `registerSotwMemberHandler` from `./events/sotwMembers.js` and call it after `registerPresenceHandler(client);`.

In `src/services/leaveReassess.ts`, at the very end of `reassessAfterLeaveChange` (after the loop over windows):

```ts
    // Staff of the Week is told, never changed, when leave now exempts the
    // holder's week or next week's pick.
    await checkLeaveAgainstSotw(client, config, staffId, now);
```

Import `checkLeaveAgainstSotw` from `./sotwWatch.js`.

- [ ] **Step 4: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/sotwWatch.ts src/events/sotwMembers.ts src/services/leaveReassess.ts src/index.ts
git commit -m "Tell the Executives when leave or a role change affects Staff of the Week

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: The role-order warning on `/config` and `/dev status`

**Files:**
- Modify: `src/render/configCards.ts:215-268` (`configViewCard` takes extra warnings)
- Modify: `src/commands/config.ts` (`view` branch, `applyChange`)
- Modify: `src/commands/dev.ts` (`status` branch)

**Interfaces:**
- Consumes: `staffOfWeekRoleOrder`, `ConfigWarning` (Task 10), `staffOfWeekRoleFacts` (Task 10).
- Produces: `configViewCard(config, guildNames, setCommand, extraWarnings?: ConfigWarning[])`.

- [ ] **Step 1: Write the failing test**

Add to `test/configView.test.ts` (follow its existing imports and fixture for a config):

```ts
it("shows warnings it was handed alongside its own", () => {
    const card = configViewCard(DEFAULT_CONFIG, new Map(), "/config set", [
        { key: "staffOfWeekRole", text: "The role is above the bot." }
    ]);
    expect(JSON.stringify(card.components.map((c) => c.toJSON()))).toContain("The role is above the bot.");
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/configView.test.ts`
Expected: FAIL. The typecheck in vitest may accept the extra argument, but the text is missing.

- [ ] **Step 3: Implement**

In `configViewCard`, add the parameter `extraWarnings: ConfigWarning[] = []` and change its warnings line to:

```ts
    const warnings = [...configWarnings(config, new Date()), ...extraWarnings];
```

Import `type ConfigWarning` from `../config/configGuards.js`.

In `src/commands/config.ts`, `view` branch:

```ts
            const roleOrder = staffOfWeekRoleOrder(await staffOfWeekRoleFacts(client, fresh));
            await respond(interaction, configViewCard(fresh, guildNames, setCommand, roleOrder));
```

In `applyChange`:

```ts
    const warnings = [
        ...configWarnings(fresh, new Date()),
        ...staffOfWeekRoleOrder(await staffOfWeekRoleFacts(client, fresh))
    ];
```

In `src/commands/dev.ts`, `status` branch, change `warnings:` to:

```ts
                    warnings: [
                        ...configWarnings(fresh, new Date()),
                        ...staffOfWeekRoleOrder(await staffOfWeekRoleFacts(client, fresh))
                    ].map((warning) => ({ key: String(warning.key), text: warning.text })),
```

Imports in both commands: `staffOfWeekRoleOrder` from `../config/configGuards.js`, and `staffOfWeekRoleFacts` from `../services/sotwRole.js`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/render/configCards.ts src/commands/config.ts src/commands/dev.ts test/configView.test.ts
git commit -m "Say on /config and /dev status when the Staff of the Week role sits wrong

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: `/dev sotw`

**Files:**
- Modify: `src/commands/dev.ts`

**Interfaces:**
- Consumes: `buildReminder` (Task 11), `drawPoolFor` (Task 12), `pickCongratulation`, `congratsCard`, `previewFor`, `weekSlots`, `countMinutesBetween`, `listActiveStaff`, `draw`.

`/dev sotw` takes a required choice option `preview` (`reminder`, `draw`, `congrats`). It writes nothing, touches no roles, and sends only to the caller.

- [ ] **Step 1: Add the subcommand**

In the builder, after `status`:

```ts
        .addSubcommand((sub) =>
            sub
                .setName("sotw")
                .setDescription("Preview Staff of the Week. Writes nothing and tells nobody else.")
                .addStringOption((option) =>
                    option
                        .setName("preview")
                        .setDescription("Which part")
                        .setRequired(true)
                        .addChoices(
                            { name: "reminder", value: "reminder" },
                            { name: "draw", value: "draw" },
                            { name: "congrats", value: "congrats" }
                        )
                )
        )
```

- [ ] **Step 2: Handle it**

In `execute`, before the `rehearse` branch:

```ts
        if (sub === "sotw") {
            await defer(interaction, true);
            const what = interaction.options.getString("preview", true);

            if (what === "draw") {
                // If the week closed now: this week's live minutes, eligibility
                // for next week, one sample draw. Nothing is recorded.
                const slots = await weekSlots(config);
                const standings = [];
                for (const member of await listActiveStaff()) {
                    standings.push({
                        staffId: member._id.toHexString(),
                        minutes: await countMinutesBetween(member._id, slots.current.start, new Date())
                    });
                }
                const pool = await drawPoolFor(client, config, slots.next, standings);
                const names = [];
                for (const row of pool) {
                    const member = await findStaffById(new ObjectId(row.staffId));
                    names.push(`- **${member ? await nameOf(client, config, member) : row.staffId}** ${row.minutes} min`);
                }
                const sample = draw(pool, Math.random);
                const sampleMember = sample ? await findStaffById(new ObjectId(sample.staffId)) : null;
                await respond(
                    interaction,
                    sotwCard(
                        "Staff of the Week draw, if the week closed now",
                        (names.length > 0 ? names.join("\n") : "Nobody would qualify.") +
                            (sampleMember ? `\n\nOne sample draw: **${await nameOf(client, config, sampleMember)}**.` : "") +
                            "\n-# Nothing was recorded and nobody was told.",
                        { ephemeral: true }
                    )
                );
                return;
            }

            const card =
                what === "reminder"
                    ? await buildReminder(client, config)
                    : congratsCard({
                          message: pickCongratulation(Math.random),
                          colourLine: staff.sotwColour
                              ? "Your colour is on the role."
                              : `The role has no colour yet — choose one with ${cmd("settings sotw-colour")}.`,
                          preview: await previewFor(client, config, staff.discordId, staff.sotwColour ?? null)
                      });
            const delivered = await tryDm(client, interaction.user.id, sendOptions(card));
            await respond(
                interaction,
                delivered
                    ? sotwCard("Sent to your DMs", "Nothing was recorded and nobody else was told.", { ephemeral: true })
                    : errorCard("Your DMs are closed to the bot, so the preview could not be sent.")
            );
            return;
        }
```

Imports: `ObjectId` (mongodb); `findStaffById`, `listActiveStaff` (`../domain/staff.js`); `countMinutesBetween` (`../domain/activity.js`); `draw` (`../domain/staffOfWeek.js`); `buildReminder` (`../services/sotwNotices.js`); `drawPoolFor` (`../services/sotwHandoff.js`); `weekSlots`, `nameOf` (`../services/sotwContext.js`); `previewFor` (`../services/sotwPreviewService.js`); `sotwCard`, `congratsCard` (`../render/sotwCards.js`); `pickCongratulation` (`../render/sotwMessages.js`); `tryDm` (`../discord/roles.js`); `sendOptions` (`../discord/respond.js`).

- [ ] **Step 3: Run tests and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both pass. The command-limits test checks the new descriptions stay under 100 characters.

- [ ] **Step 4: Commit**

```bash
git add src/commands/dev.ts
git commit -m "Preview the Staff of the Week reminder, draw and congratulation from /dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: The colour picker page

**Files:**
- Create: `site/sotw-colour/index.html`
- Test: `test/sotwPicker.test.ts`

**Interfaces:**
- Consumes: the code format (Task 4) and fragment keys (Task 6).
- Produces: a static page with a `<script id="sotw-core">` block that declares `var SotwCore = { SOTW_CODE_VERSION, HOLOGRAPHIC, formatCode, parseCode, readFragment }` and uses no DOM, so the test can run it in `node:vm`.

Hosting is the owner's own job and happens outside this feature. Nothing here publishes the page.

- [ ] **Step 1: Write the failing test**

`test/sotwPicker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { SOTW_CODE_VERSION, formatColourCode, parseColourCode } from "../src/domain/sotwColour.js";
import { HOLOGRAPHIC } from "../src/render/sotwPalette.js";
import { pickerFragment, type PickerFragmentInput } from "../src/domain/sotwFragment.js";
import type { SotwColour } from "../src/db/types.js";

const html = readFileSync("site/sotw-colour/index.html", "utf8");
const core = /<script id="sotw-core">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const context: Record<string, unknown> = { URLSearchParams };
runInNewContext(core, context);
const page = context.SotwCore as {
    SOTW_CODE_VERSION: string;
    HOLOGRAPHIC: Record<string, number>;
    formatCode(colour: SotwColour): string;
    parseCode(raw: string): SotwColour | null;
    readFragment(hash: string): Record<string, unknown> | null;
};

const colours: SotwColour[] = [
    { style: "solid", primary: 0xff66aa },
    { style: "solid", primary: 0 },
    { style: "gradient", primary: 0x000001, secondary: 0xffffff },
    { style: "holographic" }
];

describe("the picker page and the bot agree", () => {
    it("has its core script", () => {
        expect(core.length).toBeGreaterThan(0);
        expect(page).toBeDefined();
    });

    it("writes the same version and holographic stops", () => {
        expect(page.SOTW_CODE_VERSION).toBe(SOTW_CODE_VERSION);
        expect(page.HOLOGRAPHIC).toEqual({ ...HOLOGRAPHIC });
    });

    it("writes codes the bot reads, and reads codes the bot writes", () => {
        for (const colour of colours) {
            expect(page.formatCode(colour)).toBe(formatColourCode(colour));
            expect(parseColourCode(page.formatCode(colour))).toEqual({ ok: true, colour });
            expect(page.parseCode(formatColourCode(colour))).toEqual(colour);
        }
    });

    it("reads the fragment the bot builds", () => {
        const input: PickerFragmentInput = {
            nickname: "Ro<b>in 🌈",
            userId: "123456789012345678",
            guildId: "223456789012345678",
            avatarHash: "a_abc",
            guildAvatar: true,
            roleId: null,
            iconHash: null,
            emoji: "🌈",
            colour: { style: "gradient", primary: 0xff66aa, secondary: 0x3366ff },
            enhanced: false
        };
        expect(page.readFragment(`#${pickerFragment(input)}`)).toEqual(input);
    });

    it("loads nothing but Discord's CDN", () => {
        const sources = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((match) => match[1]);
        for (const source of sources) expect(source.startsWith("https://cdn.discordapp.com/")).toBe(true);
        expect(html).not.toMatch(/https:\/\/(?!cdn\.discordapp\.com)[a-z0-9.-]+\//i);
    });
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `pnpm vitest run test/sotwPicker.test.ts`
Expected: FAIL, because the file does not exist.

- [ ] **Step 3: Write the page**

`site/sotw-colour/index.html`. The core script must be exactly the functions below, with no DOM access. The UI script below it may use the DOM.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Staff of the Week colour</title>
<style>
  :root {
    --bg: #1e1f22; --panel: #2b2d31; --raised: #313338; --text: #f2f3f5; --muted: #b5bac1;
    --line: #3f4147; --accent: #66d4cf; --focus: #00a8fc;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f2f3f5; --panel: #ffffff; --raised: #ebedef; --text: #060607; --muted: #4e5058; --line: #d4d7dc; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: grid; gap: 14px; }
  .styles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .style { border: 2px solid var(--line); background: var(--raised); color: var(--text); border-radius: 10px; padding: 10px; font: inherit; cursor: pointer; display: grid; gap: 6px; justify-items: center; }
  .style[aria-pressed="true"] { border-color: var(--accent); }
  .style:disabled { opacity: .4; cursor: not-allowed; }
  .chip { width: 40px; height: 24px; border-radius: 6px; }
  .swatches { display: grid; grid-template-columns: repeat(10, 1fr); gap: 6px; }
  .swatch { aspect-ratio: 1; border-radius: 6px; border: 1px solid rgba(0,0,0,.25); cursor: pointer; padding: 0; }
  .picker { display: grid; grid-template-columns: 1fr 22px; gap: 10px; }
  .sv { position: relative; height: 180px; border-radius: 8px; cursor: crosshair; touch-action: none;
        background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent); }
  .hue { writing-mode: vertical-lr; direction: rtl; width: 22px; height: 180px; accent-color: var(--accent); }
  .knob { position: absolute; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px #000; transform: translate(-50%, -50%); pointer-events: none; }
  .stops { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .stop { border: 2px solid var(--line); border-radius: 8px; padding: 6px 10px; background: var(--raised); color: var(--text); font: inherit; cursor: pointer; display: flex; gap: 8px; align-items: center; }
  .stop[aria-pressed="true"] { border-color: var(--accent); }
  input[type=text] { font: 600 15px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--raised); color: var(--text); width: 120px; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .previews { display: grid; gap: 8px; }
  .msg { display: flex; gap: 14px; padding: 12px 14px; border-radius: 8px; }
  .msg.dark { background: #313338; color: #dbdee1; } .msg.light { background: #fff; color: #313338; border: 1px solid #e3e5e8; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: #5865f2; flex: none; object-fit: cover; }
  .name { font-weight: 700; display: inline-flex; gap: 4px; align-items: center; }
  .name-text { background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; }
  .name-text.animated { color: transparent; animation: shimmer 3s linear infinite; }
  .badge { width: 18px; height: 18px; font-size: 16px; line-height: 18px; }
  @keyframes shimmer { from { background-position: 0% 0; } to { background-position: 200% 0; } }
  @media (prefers-reduced-motion: reduce) { .name-text.animated { animation: none; } }
  .code { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .code output { font: 700 16px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px 12px; background: var(--raised); border-radius: 8px; }
  .primary { background: var(--accent); color: #062b29; border: 0; border-radius: 8px; padding: 9px 16px; font: 700 15px inherit; cursor: pointer; }
  .hint { font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Your Staff of the Week colour</h1>
  <p>Choose a colour, copy the code, and paste it into <strong>/settings sotw-colour</strong> with <strong>Enter code</strong>. Nothing leaves this page: your name and picture come from the link you opened.</p>

  <section class="panel" aria-label="Style">
    <div class="styles" role="group" aria-label="Colour style">
      <button class="style" data-style="solid" aria-pressed="true"><span class="chip" id="chip-solid"></span>Solid</button>
      <button class="style" data-style="gradient" aria-pressed="false"><span class="chip" id="chip-gradient"></span>Gradient</button>
      <button class="style" data-style="holographic" aria-pressed="false"><span class="chip" id="chip-holo"></span>Holographic</button>
    </div>
    <p class="hint" id="enhanced-note" hidden>Gradient and holographic are not available on this server yet.</p>
  </section>

  <section class="panel" aria-label="Colour" id="colour-panel">
    <div class="stops" id="stops" hidden>
      <button class="stop" data-stop="0" aria-pressed="true"><span class="chip" id="stop-0" style="width:20px;height:20px"></span>First</button>
      <button class="stop" data-stop="1" aria-pressed="false"><span class="chip" id="stop-1" style="width:20px;height:20px"></span>Second</button>
      <button class="stop" id="swap" aria-label="Swap the two colours">⇄ Swap</button>
    </div>
    <div class="swatches" id="swatches" role="group" aria-label="Preset colours"></div>
    <div class="picker">
      <div class="sv" id="sv" role="slider" aria-label="Saturation and brightness" tabindex="0"><div class="knob" id="knob"></div></div>
      <input class="hue" id="hue" type="range" min="0" max="360" value="330" aria-label="Hue">
    </div>
    <label>Hex <input type="text" id="hex" maxlength="7" spellcheck="false" autocomplete="off"></label>
  </section>

  <section class="panel" aria-label="Preview">
    <div class="previews">
      <div class="msg dark"><img class="avatar" id="avatar-dark" alt=""><div><div class="name"><span class="name-text" id="name-dark">Your name</span><span class="badge" id="badge-dark"></span></div><div>Staff of the Week, reporting for duty.</div></div></div>
      <div class="msg light"><img class="avatar" id="avatar-light" alt=""><div><div class="name"><span class="name-text" id="name-light">Your name</span><span class="badge" id="badge-light"></span></div><div>Staff of the Week, reporting for duty.</div></div></div>
    </div>
  </section>

  <section class="panel" aria-label="Your code">
    <div class="code"><output id="code"></output><button class="primary" id="copy">Copy</button><span class="hint" id="copied" role="status"></span></div>
  </section>
</main>

<script id="sotw-core">
var SotwCore = (function () {
  var SOTW_CODE_VERSION = "SOTW1";
  var HOLOGRAPHIC = { primary: 0xa9ffff, secondary: 0xffcccc, tertiary: 0xffe0a0 };
  function hex(value) { return value.toString(16).padStart(6, "0").toUpperCase(); }
  function formatCode(colour) {
    if (colour.style === "solid") return SOTW_CODE_VERSION + "-S-" + hex(colour.primary);
    if (colour.style === "gradient") return SOTW_CODE_VERSION + "-G-" + hex(colour.primary) + "-" + hex(colour.secondary);
    return SOTW_CODE_VERSION + "-H";
  }
  function parseCode(raw) {
    var value = String(raw || "").trim().toLowerCase();
    var prefix = SOTW_CODE_VERSION.toLowerCase() + "-";
    if (value.indexOf(prefix) !== 0) return null;
    var parts = value.slice(prefix.length).split("-");
    var six = /^[0-9a-f]{6}$/;
    if (parts[0] === "s" && parts.length === 2 && six.test(parts[1])) return { style: "solid", primary: parseInt(parts[1], 16) };
    if (parts[0] === "g" && parts.length === 3 && six.test(parts[1]) && six.test(parts[2])) {
      return { style: "gradient", primary: parseInt(parts[1], 16), secondary: parseInt(parts[2], 16) };
    }
    if (parts[0] === "h" && parts.length === 1) return { style: "holographic" };
    return null;
  }
  function readFragment(hash) {
    var params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
    if (params.get("v") !== "1") return null;
    var code = params.get("c");
    return {
      nickname: params.get("n") || "",
      userId: params.get("u") || "",
      guildId: params.get("g") || "",
      avatarHash: params.get("a"),
      guildAvatar: params.get("ga") === "1",
      roleId: params.get("r"),
      iconHash: params.get("i"),
      emoji: params.get("e"),
      colour: code ? parseCode(code) : null,
      enhanced: params.get("x") === "1"
    };
  }
  return { SOTW_CODE_VERSION: SOTW_CODE_VERSION, HOLOGRAPHIC: HOLOGRAPHIC, formatCode: formatCode, parseCode: parseCode, readFragment: readFragment };
})();
</script>

<script>
(function () {
  var core = SotwCore;
  var PRESETS = ["#1ABC9C","#2ECC71","#3498DB","#9B59B6","#E91E63","#F1C40F","#E67E22","#E74C3C","#95A5A6","#607D8B",
                 "#11806A","#1F8B4C","#206694","#71368A","#AD1457","#C27C0E","#A84300","#992D22","#979C9F","#546E7A"];
  var CDN = "https://cdn.discordapp.com/";
  var info = core.readFragment(location.hash) || { nickname: "", enhanced: true, colour: null };
  var state = { style: "solid", stops: [0xff66aa, 0x3366ff], active: 0 };
  if (info.colour) {
    state.style = info.colour.style;
    if (info.colour.style === "solid") state.stops[0] = info.colour.primary;
    if (info.colour.style === "gradient") state.stops = [info.colour.primary, info.colour.secondary];
  }
  var $ = function (id) { return document.getElementById(id); };
  var css = function (n) { return "#" + n.toString(16).padStart(6, "0"); };

  function hsvToInt(h, s, v) {
    var f = function (n) { var k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255);
  }
  function intToHsv(n) {
    var r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
  }

  function colour() {
    if (state.style === "solid") return { style: "solid", primary: state.stops[0] };
    if (state.style === "gradient") return { style: "gradient", primary: state.stops[0], secondary: state.stops[1] };
    return { style: "holographic" };
  }
  function fillFor(c) {
    if (c.style === "solid") return { color: css(c.primary), image: "none", animated: false };
    var stops = c.style === "gradient" ? [c.primary, c.secondary, c.primary] : [core.HOLOGRAPHIC.primary, core.HOLOGRAPHIC.secondary, core.HOLOGRAPHIC.tertiary, core.HOLOGRAPHIC.primary];
    return { color: "transparent", image: "linear-gradient(90deg," + stops.map(css).join(",") + ")", animated: true };
  }

  function render() {
    var c = colour();
    document.querySelectorAll(".style").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.style === state.style)); });
    $("colour-panel").hidden = state.style === "holographic";
    $("stops").hidden = state.style !== "gradient";
    document.querySelectorAll(".stop[data-stop]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.dataset.stop) === state.active)); });
    $("stop-0").style.background = css(state.stops[0]);
    $("stop-1").style.background = css(state.stops[1]);
    var current = state.stops[state.active];
    var hsv = intToHsv(current);
    $("sv").style.backgroundColor = css(hsvToInt(hsv.h, 1, 1));
    $("knob").style.left = (hsv.s * 100) + "%";
    $("knob").style.top = ((1 - hsv.v) * 100) + "%";
    if (document.activeElement !== $("hue")) $("hue").value = String(Math.round(hsv.h));
    if (document.activeElement !== $("hex")) $("hex").value = css(current).toUpperCase();
    ["dark", "light"].forEach(function (theme) {
      var el = $("name-" + theme), fill = fillFor(c);
      el.style.color = fill.color; el.style.backgroundImage = fill.image;
      el.classList.toggle("animated", fill.animated);
    });
    $("code").textContent = core.formatCode(c);
  }

  function setActive(n) { state.stops[state.active] = n; render(); }

  // Identity from the fragment. Every image is Discord's own CDN.
  var name = info.nickname || "Your name";
  ["dark", "light"].forEach(function (theme) {
    $("name-" + theme).textContent = name;
    var avatar = $("avatar-" + theme);
    if (info.avatarHash && info.userId) {
      avatar.src = info.guildAvatar
        ? CDN + "guilds/" + info.guildId + "/users/" + info.userId + "/avatars/" + info.avatarHash + ".png?size=80"
        : CDN + "avatars/" + info.userId + "/" + info.avatarHash + ".png?size=80";
    } else { avatar.removeAttribute("src"); }
    var badge = $("badge-" + theme);
    if (info.roleId && info.iconHash) {
      var img = document.createElement("img");
      img.src = CDN + "role-icons/" + info.roleId + "/" + info.iconHash + ".png?size=40";
      img.alt = ""; img.width = 18; img.height = 18;
      badge.appendChild(img);
    } else if (info.emoji) { badge.textContent = info.emoji; }
  });
  $("chip-solid").style.background = "#FF66AA";
  $("chip-gradient").style.background = "linear-gradient(90deg,#FF66AA,#3366FF)";
  $("chip-holo").style.background = "linear-gradient(90deg,#A9FFFF,#FFCCCC,#FFE0A0)";
  if (info.enhanced === false) {
    document.querySelectorAll('.style[data-style="gradient"], .style[data-style="holographic"]').forEach(function (b) { b.disabled = true; });
    $("enhanced-note").hidden = false;
    if (state.style !== "solid") state.style = "solid";
  }

  PRESETS.forEach(function (value) {
    var b = document.createElement("button");
    b.className = "swatch"; b.style.background = value; b.setAttribute("aria-label", value);
    b.addEventListener("click", function () { setActive(parseInt(value.slice(1), 16)); });
    $("swatches").appendChild(b);
  });
  document.querySelectorAll(".style").forEach(function (b) {
    b.addEventListener("click", function () { state.style = b.dataset.style; state.active = 0; render(); });
  });
  document.querySelectorAll(".stop[data-stop]").forEach(function (b) {
    b.addEventListener("click", function () { state.active = Number(b.dataset.stop); render(); });
  });
  $("swap").addEventListener("click", function () { state.stops.reverse(); render(); });
  $("hue").addEventListener("input", function () {
    var hsv = intToHsv(state.stops[state.active]);
    setActive(hsvToInt(Number($("hue").value), hsv.s || 1, hsv.v || 1));
  });
  $("hex").addEventListener("input", function () {
    var v = $("hex").value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(v)) setActive(parseInt(v, 16));
  });
  function pick(event) {
    var rect = $("sv").getBoundingClientRect();
    var s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    var v = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setActive(hsvToInt(Number($("hue").value), s, v));
  }
  $("sv").addEventListener("pointerdown", function (e) { $("sv").setPointerCapture(e.pointerId); pick(e); });
  $("sv").addEventListener("pointermove", function (e) { if (e.buttons) pick(e); });
  $("sv").addEventListener("keydown", function (e) {
    var hsv = intToHsv(state.stops[state.active]), step = 0.05;
    if (e.key === "ArrowRight") hsv.s = Math.min(1, hsv.s + step);
    else if (e.key === "ArrowLeft") hsv.s = Math.max(0, hsv.s - step);
    else if (e.key === "ArrowUp") hsv.v = Math.min(1, hsv.v + step);
    else if (e.key === "ArrowDown") hsv.v = Math.max(0, hsv.v - step);
    else return;
    e.preventDefault(); setActive(hsvToInt(hsv.h, hsv.s, hsv.v));
  });
  $("copy").addEventListener("click", function () {
    var text = $("code").textContent;
    var done = function () { $("copied").textContent = "Copied. Paste it into Enter code."; };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { $("copied").textContent = "Select the code and copy it."; });
  });
  render();
})();
</script>
</body>
</html>
```

The last test in Step 1 scans for any `https://…/` other than `cdn.discordapp.com`. `CDN` is the only absolute URL in the file, so it passes.

- [ ] **Step 4: Run the tests and check they pass**

Run: `pnpm vitest run test/sotwPicker.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual check**

Open the page locally, with the fragment from a `/settings sotw-colour` link pasted after `#`: `open "site/sotw-colour/index.html#v=1&n=Robin&u=…&x=1"`.

- Check the preview shows the name.
- Check dragging the square and the hue slider updates the preview and the code.
- Check swapping the gradient stops works.
- Check Copy puts the code on the clipboard.
- Check the page reads correctly at phone width (DevTools, 375px).

- [ ] **Step 6: Commit**

```bash
git add site/sotw-colour/index.html test/sotwPicker.test.ts
git commit -m "Add the Staff of the Week colour picker page, held to the bot's format by a test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `DELETION.md`

- [ ] **Step 1: CLAUDE.md**

Add a section after "**The leaderboard log is the closed week, frozen.**". Write it in the file's own voice, covering in order:

1. **Staff of the Week is one role, owned by the bot.** Say `staffOfWeekRole` empty turns the feature off. Say the handoff runs in `closeWeek` after the rollup and before the team recap, claimed by `sotw-handoff:<ms>` before anything moves. Say the draw is the closed week's top three who met `weeklyTargetMinutes`, plus everyone tied with the third, with pending leave skipping the draw.
2. **Credited versus removed holders.** Say `creditedHolders` is the only reader of `holders`/`removedHolders`. Say a removed holder is neither barred nor credited.
3. **The colour is a preference, not a role setting.** Cover `StaffDoc.sotwColour` and `roleColoursFor` as the one path for every role write. Say the boot re-assert puts back a colour edited by hand.
4. **The nickname exception.** The preview and the picker link use the public-guild nickname, against the `staffDisplayName` rule, because that is the only place the colour is seen.
5. **The picker page and the parser.** Say `test/sotwPicker.test.ts` runs the page's `sotw-core` script against the parser and the fragment builder. Say hosting is the owner's own. Say Twemoji is always `@latest`.
6. **🏆 means Staff of the Week alone**, and standings moved to 📈. Mention `test/staffOfWeekMark.test.ts`.
7. **Late changes are notices, never actions.** Say the member handler (`events/sotwMembers.ts`) watches the holder only.

Update the "Interaction routing" namespace list to include `sotw` (`rest`/`next`/`cancel`) and `sotwColour` (`code`/`clear`/`save`/`cancel`). Update the "Collections" list to include `staffOfWeek`. Update the "One command per subject" list to include `/sotw`.

- [ ] **Step 2: DELETION.md**

In "Full purge of one staff member", after the `db.leave.deleteMany` line:

```javascript
// Staff of the Week records are never deleted: they are each week's history.
// Take the person out of them instead.
db.staffOfWeek.updateMany({}, { $pull: { holders: id, removedHolders: id, events: { staffId: id } } });
db.staffOfWeek.updateMany({ staffId: id }, { $set: { staffId: null } });
```

Add a sentence after the code block. The saved Staff of the Week colour lives on the staff record and goes with `db.staff.deleteOne`. The late-change notice receipts carry the staff id and are covered by the `deliveries` regex below.

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all three pass. Record the test count in the commit message body.

- [ ] **Step 4: End-to-end check on the dev deployment**

1. `docker-compose up -d --build`. `/config set staffOfWeekRole` and `staffOfWeekChannelId`. Check `/config view` shows the role-order warning if the role sits above the bot.
2. `/dev sotw preview:reminder` and `preview:congrats`. Both arrive by DM.
3. `/sotw set` for a Moderator. The notice posts.
4. To exercise the handoff without waiting a week, temporarily set `weekStartDay` to today (it asks for a second click) and restart. The boot catch-up runs the handoff for the current week. Then put `weekStartDay` back. Check:
   - the role moved and wears the holder's saved colour;
   - the congratulation DM arrived;
   - the notice posted;
   - `/stats leaderboard` shows 🏆 beside the holder;
   - `/sotw view` shows "picked by".
5. `/sotw remove` with a reason. The role is gone, `/sotw set` offers the rest of the week, and choosing it grants and congratulates.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md DELETION.md
git commit -m "Document Staff of the Week, and how to take somebody out of its records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** Each spec section maps to a task:

  | Spec section | Task |
  |---|---|
  | Config | 3 |
  | Config guard | 10, 17 |
  | Data and personal colour | 2, 9 |
  | Eligibility | 5, 10 |
  | Target week | 5, 10 |
  | `/sotw` subcommands | 13 |
  | Reminder | 11 |
  | Handoff, random draw, downtime and cold start | 12 |
  | Leave and the role | handled by not touching it; documented in 20 |
  | Late changes | 16 |
  | Recognition | 15 |
  | `/settings sotw-colour` and Save | 14 |
  | Applying | 4, 10, 14 |
  | Colour code | 4 |
  | Preview | 7, 10 |
  | Picker page | 19 |
  | `/dev sotw` | 18 |
  | Copy rules | 1, and throughout |
  | Testing list | 1, 3–8, 10, 13–15, 17, 19 |
  | Documentation | 20 |
  | Export | 14 |

- **Deviation flagged for the user:** Task 16 adds a GuildMemberRemove/GuildMemberUpdate handler. The spec assumed such paths already existed; they did not. Deactivation has no live path because `setStaffActive` has no callers, so it is caught at the handoff and in `/sotw view` only.
- **Clarification made in the plan:** a handoff counts as settled once claimed or an hour into the week (`HANDOFF_GRACE_MS`). Without this, switching the feature on mid-week would leave `/sotw set` targeting a week that had already begun. It refines the spec's target-week rule and does not change it.
- **Clarification made in the plan:** somebody on active leave resolves as Staff tier for eligibility (`wearsOnLeaveRole`). Otherwise leave would refuse them as "not staff" for next week, before the leave rule was asked at all.
