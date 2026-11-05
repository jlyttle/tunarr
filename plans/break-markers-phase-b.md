# Detected Break Markers in Time Slots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tunarr splits time-slot episodes at the breaks breakdetect found, fills those breaks with the slot's spare time, and plays episodes without markers straight through.

**Architecture:** breakdetect's marker JSON is POSTed to a new Tunarr endpoint, which matches each episode to a program by file path and duration and stores the break offsets in a new `program_break_marker` table. `SlotSchedulerHelper` loads the offsets for the programs it collects and passes them as a side-channel map (`ReadonlyMap<programId, number[]>`) to the schedulers, so scheduler services stay DB-free. A new `detected` mid-roll rule turns markers into break points, new placement filters drop unwanted ones, and a new "split slot flex" mode sizes each break from the slot's spare time.

**Tech Stack:** TypeScript, Zod 4 (`types`), Fastify + Drizzle + better-sqlite3 (`server`), React + MUI + React Hook Form (`web`), Vitest.

**Spec:** `plans/use-the-brainstorming-plugin-jolly-crown.md` (Phase B section, including "Labels vs. placement"). Phase A output: `tools/breakdetect/data/markers/*.json`.

## Global Constraints

- Fork only (`feature/aspect-ratio-modes-main`); commit on the current branch, never push or force-push.
- CLAUDE.md code rules: no `as any`; no inline `import()` types; `!== undefined` for `T | undefined`; no unguarded `!`; `pnpm lint-changed` clean; every change ships with Vitest tests.
- Build and typecheck through Turbo (`pnpm turbo typecheck`); single package via its own script (`tsc -p tsconfig.build.json`), never bare `tsc`.
- New queries use Drizzle. Schema changes get a migration via the `new-migration` skill (`pnpm drizzle-kit generate`).
- New API endpoint: define in `server/src/api/`, register in `api/index.ts`, then `cd server && pnpm generate-openapi` and `cd web && pnpm generate-client` (the `regen-api` skill).
- Classic slot-scheduler behavior change ⇒ add a row to `architecture/infinite-schedules/parity-checklist.md`; update `docs/configure/scheduling/mid-roll-breaks.md`.
- Precision over recall: no markers, or no breaks surviving the filters ⇒ the program plays whole (`resolveBreakPoints` returns `null`). No interval fallback for `detected`.
- Running late ⇒ breaks drop; breaks never push a slot past its end (existing `breakBudgetMs` behavior stays).
- Do not run heavy jobs on the Unraid server (192.168.1.227). Deploying the fork image there is the user's call; ask first.
- Marker file format is breakdetect schema 1: `{ schema: 1, detector, show, threshold, episodes: [{ relativePath, durationMs, breaks: [{ offsetMs, score }] }] }`. `relativePath` is relative to the Plex mount root, e.g. `Kids TV/SpongeBob SquarePants/Season 2/…mkv`; Tunarr's `program_media_file.path` is e.g. `/data/Kids TV/SpongeBob SquarePants/Season 2/…mkv`.

## Rulings (Claude's calls, flagged for the user)

- **Matching key:** path suffix plus duration. breakdetect never sees Plex IDs, so the spec's "Plex item ID first" isn't available. A program matches when `program_media_file.path` ends with `'/' + relativePath` (NFC-normalized on both sides) and `|program.duration − durationMs| ≤ 2000`. If several programs match, all of them get the markers, since they are the same file on the same mount. A marker episode that matches no program is reported, not an error.
- **New table, not `program_break_analysis`:** the old table is a job/lease ledger for the retired v7 detector. Markers need one row per program. The old table and code stay untouched.
- **Import replaces by program:** importing a file replaces the stored offsets of every program it matches, including with an empty list. Programs it doesn't mention keep their rows.
- **Breaks without a mid filler list use the lazy strategy:** for `detected`, a slot with no mid filler list emits lazy break placeholders (`fillerListIds` undefined), which the stream fills from the channel's filler at play time. Other rule types keep today's "no mid filler ⇒ no breaks".
- **Split slot flex per program:** the slot's spare time is shared across its programs in proportion to their duration. Each program reserves a tail `max(minTailMs, share × tailShare)` and splits the rest evenly across its kept breaks. Breaks are dropped latest first while an even share is below `minBreakMs`. Defaults: `tailShare` 0.25, `minTailMs` 60 000, `minBreakMs` 60 000. In random slots, where the budget is infinite, each break gets `minBreakMs`.
- **Placement filters apply to every rule type:** `minFirstBreakMs` (no break before this offset) and `minBreakIntervalMs` (drop a break closer than this to the previous kept one). Both are optional, so existing configs don't change. The minimum time before the end is the existing `tailBufferMs`, and the maximum number of breaks is the existing `maxBreaks`. The name `minBreakIntervalMs` matches `plans/chapter-marker-mid-roll-breaks-2026-07-12.md`.

## Review Focus

1. **A marker past the program's playable end, or at offset 0** (a file re-encoded shorter, or a bad marker): it must be ignored. No zero-length or negative segment. Pinned in Task 2.
2. **A program that already has a `startOffsetMs`:** markers are relative to the file, so they must shift by the base offset. A marker before the base is dropped. Pinned in Task 5.
3. **A slot whose spare time is smaller than `minTailMs + minBreakMs`:** no breaks, and the program plays whole with its normal end flex. Pinned in Task 6.
4. **Two programs in one slot, the second without markers:** the first takes only its own share of the spare time, so the second's end-of-slot flex isn't starved. Pinned in Task 6.
5. **Importing the same file twice, or a file whose paths don't match the server's mounts:** a second import is idempotent, and a mismatched file reports `matched: 0` without touching other rows. Pinned in Task 4.

---

### Task 1: Schema for the `detected` rule, split slot flex and placement filters

**Files:**
- Modify: `types/src/api/CommonSlots.ts:43-123`
- Test: `server/src/services/scheduling/midRollBreakRules.test.ts` (create; `types` has no test runner)

**Interfaces:**
- Produces: `MidRollBreakRule` gains `{ type: 'detected' }`. `MidRollConfig` gains `splitSlotFlex?: { tailShare: number; minTailMs: number; minBreakMs: number }` (defaults 0.25 / 60_000 / 60_000), `minFirstBreakMs?: number` and `minBreakIntervalMs?: number` (both nonnegative). The third `.refine` ("At least one of breakDurationMs…") passes when `splitSlotFlex` is set.

- [ ] **Step 1: Write the failing tests** in `midRollBreakRules.test.ts` under `describe('MidRollConfigSchema')`:
  - `accepts a detected rule with split slot flex and no break duration`: parse `{ breakRule: { type: 'detected' }, maxBreaks: 0, minProgramDurationMs: 0, splitSlotFlex: {} }` → success, and `data.splitSlotFlex` equals `{ tailShare: 0.25, minTailMs: 60_000, minBreakMs: 60_000 }`.
  - `still requires a break duration without split slot flex`: the same without `splitSlotFlex` → failure.
  - `rejects tailShare above 1`: `splitSlotFlex: { tailShare: 1.5 }` → failure.
- [ ] **Step 2: Run** `cd server && pnpm test src/services/scheduling/midRollBreakRules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema changes in `CommonSlots.ts` (`tailShare: z.number().min(0).max(1).default(0.25)`).
- [ ] **Step 4: Run** the test again. Expected: PASS. Then `pnpm turbo typecheck`.
- [ ] **Step 5: Commit** `feat(types): detected mid-roll rule, split slot flex, placement filters`.

### Task 2: `resolveBreakPoints` for markers and placement filters

**Files:**
- Modify: `server/src/services/scheduling/midRollBreakRules.ts`
- Test: `server/src/services/scheduling/midRollBreakRules.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `resolveBreakPoints(programDurationMs: number, config: MidRollConfig, markersMs?: readonly number[]): BreakPoint[] | null`. For `detected`, offsets are `markersMs ?? []`, sorted, deduplicated, and kept only in `(0, programDurationMs)`. The tail filter uses break duration `0` when `config.splitSlotFlex` is set (so `resolveBreakDuration` isn't called and can't throw). Filter order after offsets: tail filter, then `minFirstBreakMs`, then `minBreakIntervalMs` (greedy from the start, measured from the previous *kept* offset), then `maxBreaks`.

- [ ] **Step 1: Write the failing tests** (`describe('resolveBreakPoints detected')`). Use the base config `{ breakRule: { type: 'detected' }, maxBreaks: 0, minProgramDurationMs: 0, tailBufferMs: 0, splitSlotFlex: { tailShare: 0.25, minTailMs: 60_000, minBreakMs: 60_000 }, strategy: 'lazy' }` and a 1_320_000 ms program:
  - markers `[660_000]` → `[{ offsetMs: 660_000 }]`
  - no markers / `[]` → `null`
  - markers `[0, 660_000, 1_320_000, 1_400_000]` → `[{ offsetMs: 660_000 }]`
  - markers `[700_000, 660_000, 660_000]` → offsets `[660_000, 700_000]`
  - `minFirstBreakMs: 300_000`, markers `[155_000, 660_000]` → `[660_000]`
  - `minBreakIntervalMs: 240_000`, markers `[300_000, 420_000, 600_000]` → `[300_000, 600_000]`
  - `tailBufferMs: 120_000`, markers `[660_000, 1_250_000]` → `[660_000]`
  - `maxBreaks: 1`, markers `[300_000, 660_000]` → `[300_000]`
  - a `fixed_interval` config with `minFirstBreakMs` larger than the interval drops the first point (filters apply to every rule)
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `detected` case and the two filters as small helpers in `midRollBreakRules.ts`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Also run `pnpm test src/services/scheduling/TimeSlotService.test.ts src/services/scheduling/customShowMidRoll.test.ts` (no regressions).
- [ ] **Step 5: Commit** `feat(scheduling): resolve detected break points with placement filters`.

### Task 3: `program_break_marker` table and repository

**Files:**
- Create: `server/src/db/schema/ProgramBreakMarker.ts`, `server/src/db/BreakMarkerDB.ts`, `server/src/db/BreakMarkerDB.test.ts`
- Modify: `server/src/db/schema/index.ts`, `server/src/db/schema/db.ts`, `server/src/db/DBModule.ts`
- Create (generated): the next migration in `server/src/migration/db/sql/` plus `meta/` journal entries

**Interfaces:**
- Produces: the table `program_break_marker`, with columns `program_id` text PK references `program(uuid)` on delete cascade, `offsets_ms` text JSON `number[]` not null, `detector` text not null, and `imported_at` integer not null.
- Produces: `BreakMarkerDB`, injectable and bound in `DBModule.ts`, taking `@inject(KEYS.DrizzleDB) db: DrizzleDBAccess`, with these methods:
  - `replace(rows: { programId: string; offsetsMs: number[]; detector: string }[]): void`, an upsert in one transaction
  - `offsetsFor(programIds: readonly string[]): Map<string, number[]>`, chunked `inArray` at 500 IDs; programs without a row are absent from the map

- [ ] **Step 1: Write the failing tests** in `BreakMarkerDB.test.ts`. Use an in-memory better-sqlite3 database with `foreign_keys = OFF`, and execute the generated migration SQL file, following `server/src/services/break-analysis/BreakAnalysisRepository.test.ts`:
  - `replace then offsetsFor returns stored offsets`: `[100, 200]` for `p1` → `offsetsFor(['p1', 'p2'])` is `Map { p1 → [100, 200] }`
  - `replace overwrites and accepts an empty list`: `p1` replaced with `[]` → `offsetsFor(['p1']).get('p1')` equals `[]`
  - `offsetsFor handles more than 500 ids`: 1200 rows round-trip
- [ ] **Step 2: Generate the migration** with the `new-migration` skill after adding the schema file. Then run the test. Expected: FAIL until the repository exists.
- [ ] **Step 3: Implement** `BreakMarkerDB`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then `pnpm turbo typecheck`.
- [ ] **Step 5: Commit** `feat(db): program_break_marker table`.

### Task 4: Marker import service and `POST /api/break-markers`

**Files:**
- Create: `server/src/services/break-markers/BreakMarkerImporter.ts`, `server/src/services/break-markers/BreakMarkerImporter.test.ts`, `server/src/api/breakMarkersApi.ts`, `types/src/api/BreakMarkers.ts` (export from `types/src/api/index.ts`)
- Modify: `server/src/api/index.ts`, the services DI module that binds services such as `BreakAnalysisService`, `tools/breakdetect/README.md` (an "Import into Tunarr" section with the `curl` command)
- Regenerate: OpenAPI spec and `web/src/generated/`

**Interfaces:**
- Consumes: `BreakMarkerDB.replace` (Task 3).
- Produces: `BreakMarkerFileSchema`, the Zod schema for breakdetect schema 1 (above), and `BreakMarkerImportResultSchema = { matched: number; unmatched: string[]; programs: number }`. `programs` counts the rows written.
- Produces: a pure function `matchMarkerEpisodes(episodes: BreakMarkerFile['episodes'], candidates: { programId: string; path: string; durationMs: number }[]): { rows: { programId: string; offsetsMs: number[] }[]; unmatched: string[] }`.
- Produces: `BreakMarkerImporter.import(file: BreakMarkerFile): Promise<BreakMarkerImportResult>`. It finds candidates with one Drizzle query: `program` ⋈ `program_version` ⋈ `program_media_file`, `type = 'episode'`, and `path LIKE '%/' || <file name>` for each episode's basename, batched. The query only narrows the search; `matchMarkerEpisodes` makes the decision.
- Produces: route `POST /break-markers` (tag `Programming`), body `BreakMarkerFileSchema`, response 200 `BreakMarkerImportResultSchema`.

- [ ] **Step 1: Write the failing tests** for `matchMarkerEpisodes`:
  - a suffix and duration within 2000 ms match → a row with offsets `[660_000]`
  - a duration off by 2001 ms → unmatched
  - `/data/Kids TV/X/a.mkv` must not match the relativePath `TV/X/a.mkv` (the suffix requires a `/` boundary — `'/data/Kids TV/X/a.mkv'.endsWith('/TV/X/a.mkv')` is false, as wanted)
  - an NFD path in the database matches an NFC relativePath
  - two programs with the same path both get rows
  - an episode with `breaks: []` that matches → a row with `offsetsMs: []`

  Also write an API test using the repo's existing API test harness (see `server/src/api/mediaSourceApi.test.ts`): POST the same file twice → the second response has the same `matched`, and `offsetsFor` is unchanged.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, the importer and the route. Then run the `regen-api` skill.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then `pnpm turbo typecheck` and `pnpm lint-changed`.
- [ ] **Step 5: Commit** `feat(api): import breakdetect break markers`.

### Task 5: Thread markers through the schedulers

**Files:**
- Modify: `server/src/services/scheduling/SlotSchedulerHelper.ts`, `TimeSlotSchedulerService.ts`, `TimeSlotService.ts`, `RandomSlotSchedulerService.ts`, `RandomSlotsService.ts`, `slotSchedulerUtil.ts:1036-1095`
- Test: `server/src/services/scheduling/TimeSlotService.test.ts` (add a `describe('detected breaks')`)

**Interfaces:**
- Consumes: `BreakMarkerDB.offsetsFor` (Task 3) and `resolveBreakPoints(…, markersMs)` (Task 2).
- Produces: `SlotSchedulerHelper.loadBreakMarkers(programs: SlotSchedulerProgram[]): Map<string, number[]>`, which calls `offsetsFor` with the programs' `uuid`s; `BreakMarkerDB` is injected.
- Produces: `scheduleTimeSlots(schedule, programs, seed, discardCount, startTime, breakMarkers: ReadonlyMap<string, number[]> = new Map())`. The random-slot entry point gets the same trailing parameter.
- Produces: `applyMidRollBreaks(paddedProgram, slot, midRollConfig, random, timeCursor, maxBreakMs = Infinity, breakMarkers: ReadonlyMap<string, number[]> = new Map())`. It looks up `breakMarkers.get(program.id)`, shifts each marker by `−(program.startOffsetMs ?? 0)`, and passes the result to `resolveBreakPoints`. For `breakRule.type === 'detected'`, the "no mid filler list ⇒ return" early exit doesn't apply, and with no mid filler list the lazy builder is used whatever `strategy` says.

- [ ] **Step 1: Write the failing tests**, each running `scheduleTimeSlots` on one 30-minute slot, a 22-minute episode with id `ep1`, and the Task 2 base config with `splitSlotFlex` replaced by `breakDurationMs: 180_000` (split slot flex arrives in Task 6):
  - markers `ep1 → [660_000]` → the lineup has two `ep1` segments (`startOffsetMs` 0 and 660_000) with a flex `origin: 'midroll'` between them
  - no entry for `ep1` → one whole `ep1`
  - a program with `startOffsetMs: 600_000` and marker `[660_000]` → it splits at a local offset of 60_000
  - a `fixed_interval` slot with no mid filler list still produces no breaks (the existing behavior)
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** the plumbing.
- [ ] **Step 4: Run** `pnpm test src/services/scheduling`. Expected: PASS, with no regressions.
- [ ] **Step 5: Commit** `feat(scheduling): pass detected break markers to slot schedulers`.

### Task 6: Split slot flex break durations

**Files:**
- Modify: `server/src/services/scheduling/midRollBreakRules.ts`, `slotSchedulerUtil.ts` (`applyMidRollBreaks`, `buildEagerBreaks`, `buildLazyBreaks`), `TimeSlotService.ts:376-409`
- Test: `midRollBreakRules.test.ts`, `TimeSlotService.test.ts`

**Interfaces:**
- Produces: `splitBreakDurations(budgetMs: number, breakCount: number, split: { tailShare: number; minTailMs: number; minBreakMs: number }): number[]`, in `midRollBreakRules.ts`, using this algorithm:
  ```
  if (!Number.isFinite(budgetMs)) return Array(breakCount).fill(split.minBreakMs)
  tail = min(budgetMs, max(split.minTailMs, budgetMs * split.tailShare))
  for n = breakCount down to 1: each = floor((budgetMs - tail) / n); if each >= split.minBreakMs return Array(n).fill(each)
  return []
  ```
- Produces: when `config.splitSlotFlex` is set, `applyMidRollBreaks` computes `planned = splitBreakDurations(maxBreakMs, breakPoints.length, config.splitSlotFlex)`, keeps `breakPoints.slice(0, planned.length)`, and passes `planned` to the builders. The builders take a new trailing parameter `plannedDurations?: number[]` and use it in place of `nextBreakDuration`.
- Produces: in `TimeSlotService`, when `currSlot.midRollConfig?.splitSlotFlex` is set, each program's `maxBreakMs` is `Math.floor(breakBudgetMs * programMs / remainingProgramsMs)`. `programMs = pp.totalDuration − pp.padMs`, and `remainingProgramsMs` is the same sum over this and the later programs in the slot. `breakBudgetMs` is still reduced by what the program spent.

- [ ] **Step 1: Write the failing tests:**
  - `splitBreakDurations(480_000, 2, defaults)` → `[180_000, 180_000]` (tail 120_000)
  - `splitBreakDurations(150_000, 2, defaults)` → `[90_000]` (tail 60_000, two breaks of 45_000 are too short, one break of 90_000)
  - `splitBreakDurations(100_000, 1, defaults)` → `[]`
  - `splitBreakDurations(Infinity, 2, defaults)` → `[60_000, 60_000]`
  - TimeSlot: a 30-minute slot with a 22-minute episode and markers `[300_000, 900_000]` → two breaks of 180_000 each, the slot ends exactly at 30:00, and the remaining 120_000 is flex after the episode
  - TimeSlot (Review Focus 3): a slot whose spare time is 100_000 → no split
  - TimeSlot (Review Focus 4): a 60-minute slot with two 22-minute episodes, markers only on the first → the first episode's breaks total ≤ half the spare time, and the second plays whole
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test src/services/scheduling`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scheduling): split slot flex across detected breaks`.

### Task 7: Slot editor UI

**Files:**
- Modify: `web/src/components/slot_scheduler/MidRollConfigPanel.tsx`
- Test: any web tests next to the panel (if none exist, add `MidRollConfigPanel.test.tsx` using the repo's existing web testing setup); the e2e route sweep must stay clean

**Interfaces:**
- Consumes: Task 1 fields.
- Produces UI with these behaviors:
  - **Break rule:** the select gains `detected` labelled "Detected breaks (breakdetect markers)". It has no fields of its own; helper text: "Episodes without imported markers play straight through."
  - **Break length:** the duration toggle gains a third option, "Split slot flex". Choosing it sets `splitSlotFlex` to the defaults and clears `breakDurationMs`, `breakDurationMinMs` and `breakDurationMaxMs`. It shows three minute fields: tail share as a percent, minimum tail, and minimum break.
  - **Placement:** a "Placement" group with two optional minute fields, "No break before" (`minFirstBreakMs`) and "Minimum gap between breaks" (`minBreakIntervalMs`), next to the existing "max breaks" and tail-buffer fields.

- [ ] **Step 1: Write the failing test(s):** selecting "Split slot flex" sets `splitSlotFlex` to `{ tailShare: 0.25, minTailMs: 60_000, minBreakMs: 60_000 }` and clears the break-duration fields; selecting `detected` hides the interval fields.
- [ ] **Step 2: Run** `cd web && pnpm test <file>`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, then `pnpm turbo typecheck` and `pnpm lint-changed`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(web): detected breaks, split slot flex and placement in the mid-roll panel`.

### Task 8: Docs, parity row, and end-to-end check

**Files:**
- Modify: `docs/configure/scheduling/mid-roll-breaks.md` (the `detected` rule, split slot flex, placement filters, import with `curl`), `architecture/infinite-schedules/parity-checklist.md` (row: "Detected break markers and split slot flex | `midRollBreakRules.ts`, `TimeSlotService.ts` | gap | breakdetect markers via `program_break_marker`")

- [ ] **Step 1:** Write the docs and the parity row.
- [ ] **Step 2: Full check:** `pnpm turbo typecheck`, `pnpm lint-changed`, `pnpm turbo test`. Expected: all pass.
- [ ] **Step 3: `stream-repro --schedule`** (the stream-repro skill) builds a 30-minute time-slot channel from a synthetic 22-minute clip, imports a marker at 11:00 through `POST /api/break-markers`, and uses the `detected` rule with split slot flex. Expected: the saved lineup shows segment, break, segment, tail flex; the HLS capture has no timestamp gaps or A/V offset at the two cut points.
- [ ] **Step 4: Commit** `docs(scheduling): detected break markers`.
- [ ] **Step 5: Hand off to the user** to deploy the fork image to Unraid (`docs/unraid-custom-docker-build.md`), import the three marker files, set the `detected` rule on a few Nickelodeon slots, and watch the channel.
