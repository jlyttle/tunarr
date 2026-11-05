# Design: Inter-Episode Commercial Breaks at Detected Act Breaks

## Context / Intent

Goal: a time-slot channel (Nick / Cartoon Network style) you can tune into like real TV. When an episode reaches a spot where a broadcast commercial break was originally intended (fade to black, hard cut to black, bumper/interstitial), Tunarr cuts to filler/commercials and returns.

Why: today a slot's flex piles up at the start or end of the slot — 7–8 min of commercials between episodes in a 30-min slot, more for long shows like MST3K. Spreading it across real act breaks is the point.

A previous attempt (commits `9e4f0141`..`b0f124e7`, detector `conservative-fade-v7`, `server/src/services/break-analysis/`) failed on three fronts: missed real breaks, flagged false ones, and was never wired into scheduling. Root causes (user + recon):
- Pass/fail rule chain (black AND silence AND fade AND visual change AND loud context) — any one strict threshold vetoed real breaks. Buffy, 30 Rock, Animaniacs yielded 0 accepted breaks despite 20+ candidates.
- Thresholds tuned on too few episodes; assumptions about black level, audio level, and fades were wrong (research set: 7 of 8 breaks were fades, 1 hard cut; black gap 0.2–3.0 s).
- Slow: 23–172 s/episode (full software decode, 1 thread, network share, repeated decodes).
- Only 8 of 40 ground-truth episodes ever reviewed; no precision/recall measured.

## Goals

1. Detect intended commercial-break points in TV episodes across `/Volumes/plex/TV` and `/Volumes/plex/Kids TV` (~530 shows; mostly WEB-DL, some DVD rips).
2. **Precision over recall (user's explicit priority).** A commercial cutting in mid-scene is the worst outcome. A missed break is acceptable.
3. Episodes with no confident breaks play straight through, flex at the end — same as today. No guessed/interval fallback.
4. Use cross-episode consistency: episodes of the same show/season have breaks in similar bounded windows and often repeat bumpers. Explore any useful signal (black, silence, fades, scene change, repeated bumper frames, audio cues/stings, chapter markers when present).
5. Per-show calibration: the user confirms breaks on a couple of episodes per show/season; the system uses those to calibrate/verify the rest automatically.
6. Fast enough to scan the whole library on the Unraid box and iterate during development on the Mac.
7. Tunarr consumes the markers through time-slot mid-roll breaks.

## Non-goals

- Ad-content detection inside recorded broadcasts (we're finding where breaks *were intended*, not stripping ads).
- Movies (episodes only for now).
- Changing random-slot or infinite-schedule behavior beyond what falls out of the shared mid-roll code.

## Anti-goals (failure even if it "works")

- Any noticeable rate of mid-scene cuts on air.
- A scan that takes days for the library, or minutes per iteration when tuning.
- A detector whose quality is asserted but never measured against labeled episodes.

## Decided (by user)

- Precision over recall; no-confident-breaks ⇒ play through, commercials at end.
- Chapter markers (DVD rips) are a hint, never required.
- Hand-checking: **confirm a couple of episodes per show/season**; system calibrates the rest.
- Compute: develop/iterate on the **Mac over the network share**; full-library scan later on **Unraid** (next to the files, inside or beside Tunarr — SSH available at 192.168.1.227; Tunarr at http://192.168.1.227:4200).
- Flex split: **mostly in breaks** — slot flex is divided across the episode's mid-episode breaks, with a short block left between episodes (e.g., 22-min episode, 2 breaks, 8 min flex ⇒ ~3 + 3 mid, ~2 at end).
- Running late ⇒ skip breaks, like a real station.
- Detection may be developed outside Tunarr and iterated on, then consumed by Tunarr.
- **Fork only.** This work doesn't go upstream, so the upstream design-issue process and the Python-in-image concern don't apply.
- **First scope: one test channel.** Only the shows on a single Nick/CN-style slot channel at first. The user labels 3–4 episodes per show so held-out precision is measured honestly, then the work expands to more shows. *(Claude's call: the user picks which channel and shows during Phase A.)*

## Shape of the solution (Claude's calls — flagged so the user can reject)

Three phases, in this order:

### Phase A — Offline detector (standalone, iterate fast)

- **Standalone tool** outside the Tunarr server process, so the tune loop is: re-score cached features in seconds, not re-decode. *(Claude's call: Python + numpy, extending the existing `research/commercial-break-ground-truth-v1/` work; the user's primary stacks include Python.)*
- **Two stages:** (1) feature extraction once per episode, cached to disk; (2) scoring/selection, cheap and re-runnable.
- **Fast extraction:** decode at low fps/resolution with multiple threads, hardware decode where available, several episodes in parallel, one decode pass per file (also produce review stills from the same pass). Target: well under 30 s per 22-min episode on Unraid. *(Claude's call: the exact budget is the builder's to measure.)*
- **Scoring instead of a veto chain:** each candidate gets a combined confidence from weighted signals; no single signal can veto. Candidates near the expected windows for that show/season (learned from confirmed episodes and from sibling-episode clustering) get boosted; isolated outliers get demoted.
- **Show/season model:** cluster candidate offsets (normalized by runtime and absolute time) across sibling episodes; repeated bumper frames across episodes count as strong evidence.
- **Confirmation workflow:** a lightweight review page (static HTML from cached stills/clips, like the earlier pilot review pages) where the user confirms/rejects candidates for 1–2 episodes per show/season. Confirmed labels serve as both calibration and ground truth.
- **Measured quality:** precision/recall per show against confirmed labels; a show is only "enabled" when its held-out precision meets a high bar. *(Claude's call: target ≥ 95% precision; the builder may propose the exact gate.)*
- **Output:** per-episode break markers (offset ms, confidence, signals) keyed so Tunarr can match them to programs (file path + duration / fingerprint).

### Phase B — Tunarr consumption

- Add a new mid-roll break rule type (e.g., `detected`) alongside `fixed_interval` / `percentage` / `initial_then_interval` in `types/src/api/CommonSlots.ts` → `resolveBreakPoints` in `server/src/services/scheduling/midRollBreakRules.ts`. Follow the existing design for a `chapters` rule in `plans/chapter-marker-mid-roll-breaks-2026-07-12.md` (side-channel map loaded in `SlotSchedulerHelper`, scheduler services stay DB-free).
- No markers / below confidence ⇒ `resolveBreakPoints` returns no points ⇒ program plays whole; existing end-of-slot flex behavior applies.
- Flex split "mostly in breaks": divide the slot's available flex across the detected breaks, reserving a short tail between episodes. Reuse `applyMidRollBreaks` / `buildEagerBreaks` / `buildLazyBreaks` (`slotSchedulerUtil.ts`), whose `maxBreakMs` budget and `nextBreakDuration` already drop later breaks when time runs short (that is the "skip breaks when running late" behavior).
- Playback already supports segments starting mid-file (`startOffsetMs` → `StreamProgramCalculator.ts` → `ProgramStream.ts`); no streaming changes expected beyond verifying clean cuts.
- **Break duration (Claude's call):** with the `detected` rule, offsets come from markers and lengths come from the slot's leftover time. A new duration mode, "split slot flex", divides the flex remaining after the episode across its kept breaks and reserves a tail between episodes. The tail is configurable, defaulting to about 25% of flex with a minimum of 1 min. The eager and lazy builders need the remaining slot time passed in. Breaks are filled from the slot's mid filler list if it has one, otherwise from the slot's normal flex filler, so `applyMidRollBreaks` must stop requiring a mid filler list for this rule. A break shorter than the minimum is dropped, latest first.
- **Separate loader (Claude's call):** the `detected` rule gets its own side-channel loader in `SlotSchedulerHelper`, following the pattern of the chapters design. The `chapters` rule itself is out of scope. Chapters are only an input signal to the detector.
- **Media source:** episodes come from the Plex server "Runewasters" (libraries "Kids TV" and "TV Shows"). The Mac sees them at `/Volumes/plex/...`, and Plex reports its own paths. *(Claude's call)* Markers match programs by Plex item ID (the program's external key). The fallback key is the path relative to the library root plus duration, so the three machines' different mount paths don't matter.
- **Where the detector runs on Unraid (Claude's call):** in its own container or script beside Tunarr, not inside the Tunarr image. Markers are pushed through a Tunarr import API or CLI.
- Markers get into Tunarr via an import path (CLI or API) writing to a DB table. *(Claude's call: reuse/adapt `program_break_analysis` from migration `0046` if it fits, else a new Drizzle table.)*
- **Labels vs. placement (decided by the user, 2026-10-31):** labels and markers record *where the show is structured to break* (act-out fades, the gap between stories, the end of a cold open before the titles), independent of taste. Whether a break is *used* is a per-channel/per-slot placement policy in Tunarr, applied to the detected markers:
  - minimum time before the first break (e.g. 5 min on Nickelodeon drops the cold-open break; ~1 min suits MST3K)
  - minimum time between used breaks (drops a break a few minutes after the previous one)
  - minimum time before the end of the episode
  - maximum breaks per episode
- Slot-scheduler behavior change ⇒ add a row to `architecture/infinite-schedules/parity-checklist.md`; update docs.

### Phase C — Autonomous detection (planned after Phase B is live on Nickelodeon)

**Goal (decided by the user, 2026-11-04):** every show on Nickelodeon gets breaks, then every other channel, then any show or channel added later. This must run without per-show labelling. The tape-archive recordings (`TV & Tape Archive`) are out of scope.

**Where Phases A and B leave it:**
- The model is global. It is trained on every labelled show at once, and its signals don't depend on the show: darkness, silence, fades, whether the whole frame goes dark, recurring bumpers, and offsets shared across sibling episodes.
- Tunarr's `detected` rule doesn't care whether a show's markers came from labels.
- A show without markers plays straight through, so turning the rule on for every slot is safe, and markers can arrive show by show.
- What still needs a person: the per-show gate, which wants labelled held-out episodes, and running scan, train, evaluate and export by hand.

**Steps, in order (Claude's calls):**
1. **Measure label-free quality first.** Add a leave-one-show-out evaluation: train on every other show, then score each show as if it had never been labelled, and report per-show precision and recall. That number is the precision a brand-new show would get, and it decides whether step 2 can work alone. The labelled pool should cover varied styles before the answer is trusted: cartoons, live-action sitcoms, DVD and WEB sources, and shows with stylized fades like Rugrats.
2. **A gate that needs no labels.** Enable an unlabelled show when its predictions agree with each other across its episodes:
   - most episodes predict breaks near the same offsets, with a similar break count
   - the predicted cuts are full-frame dark and silent
   - recurring bumpers back the offsets up
   - scores clear a stricter threshold than labelled shows use, derived from the leave-one-show-out results

   Shows that don't agree, like Rugrats, stay off and play straight through. Labels remain a way to rescue a show that fails or to improve the model, never a requirement.
3. **Spot-check as an interim step.** Until the label-free gate has a track record, a newly enabled show is queued on the spot-check page (8 cuts, a couple of minutes). Spot-check verdicts count toward the show's precision. Drop the step once spot-checks stop finding bad cuts.
4. **Automate the pipeline:**
   - find new or changed episodes, either from Plex/Tunarr library scans or by comparing the feature cache with the libraries
   - extract features: on the Mac by default, or on Unraid only at low priority with few workers and in short batches (see the load limits from the 2026-10-31 hard reset)
   - score and gate each show, then export markers
   - push markers to Tunarr through `POST /api/break-markers`
   - channels using the `detected` rule pick them up the next time their schedule is generated

   A failed scan or import leaves the earlier markers in place.
5. **Rollout:** all Nickelodeon shows first, then other channels a few at a time, with the `detected` rule and placement policy set per channel. A short live watch on each channel before moving on.

**Open questions for later:**
- the exact label-free precision bar
- whether a per-show offset prior learned from predictions (not labels) helps shows like Rugrats
- where the automation runs: a Mac launchd job, a container beside Tunarr, or a Tunarr task

## Left to the builder

- Exact signals, weights, and thresholds (to be learned/tuned from confirmed labels, not guessed).
- Feature cache format, parallelism, ffmpeg flags, hwaccel on the Mac vs Unraid.
- Marker file/JSON schema and program matching key.
- Whether to keep, replace, or delete the existing TS `break-analysis/` code (Claude leans: keep the DB/API scaffolding if useful, retire the v7 detector).
- UI for configuring the `detected` rule in the slot editor.

## Verification

- Phase A: per-show precision/recall report against user-confirmed episodes, with held-out episodes per show; timing report (s/episode) on Mac and Unraid.
- Phase B: Vitest unit tests for the new rule in `resolveBreakPoints` and flex split (no markers ⇒ no split; insufficient flex ⇒ later breaks dropped); `pnpm turbo typecheck`, `pnpm lint-changed`, `pnpm turbo test`; `stream-repro --schedule` to confirm a slot channel splits an episode at detected offsets and the cuts play cleanly; then watch a test channel on the live Tunarr.
