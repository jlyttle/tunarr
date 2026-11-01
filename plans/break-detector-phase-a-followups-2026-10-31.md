# Break detector phase A — rulings and follow-ups (2026-10-31)

Recorded from the subagent-driven build of plans/break-detector-phase-a.md.

## Rulings
- Ruling: T1 may commit root .gitignore including the user's existing `.local/break-evaluation/` hunk — related, harmless — cost if wrong: one line in a commit user can amend.
- Ruling: T2 uses first audio stream (0:a:0) only — Plex default track is first in nearly all files — cost if wrong: wrong-language track loudness, minor.
- Ruling: Implementers stage only their own files (never `git add -A`/`.`) — checkout has unrelated untracked/modified files — cost if wrong: n/a.
- Ruling: Execute T1–T11 + final review; T12 requires user labeling, so stop and hand over at T12 — cost if wrong: none, T12 can't run unattended.
- Task 2: Ruling: audio uses aformat=sample_fmts=s16 instead of format=s16 — plan typo, equivalent intent — cost if wrong: none
- Task 3: Ruling: NFC-normalize relative_path — carried into Task 5 dispatch (labels key on it) — cost if wrong: none
- Task 4: Ruling: merged spans capped at 5 s; a longer chained span is split back into per-original-run candidates — plan says merge <1 s but spec priority is recall at the right cut point — cost if wrong: a few extra candidates for the scorer
- Task 4: Ruling: dim-episode threshold stays permissive (by design); add a test only — cost if wrong: more candidates
- Task 4: Ruling: truncate luma/audio to common length instead of global-min fallback — cost if wrong: none
- Task 4: Ruling: dark threshold = min(max(0.06, p2+0.03), 0.15) — p2 degenerates when dark frames <2% of episode — cost if wrong: misses breaks whose "black" floor is >0.15 luma (unlikely; research floor ≪0.1)
- Task 4: Ruling: a single dark/quiet run longer than MAX_SPAN_MS (5 s) is dropped as a scene, not a gap — research dark gaps were 0.2–3.0 s — cost if wrong: breaks with >5 s black are missed (recall only, never a false cut)
- Task 7: Ruling: training logic in new breakdetect/train.py (not in plan file list) — keeps model.py pure; T8/T9 consume build_training_set from train.py — cost if wrong: none
- Task 8: Ruling: bumper sequence = 9 thumbs ending 1.5 s before start_ms (before fade window), and sequences whose mean luma is below the dark threshold score 0 — frames right before a fade are black in every episode and would match trivially — cost if wrong: misses bumpers that are themselves dark
- Task 8: Ruling: "≥3 min from own other candidates" clause dropped — matching is only against OTHER episodes' transitions, so the clause (from v6's same-episode matching) is moot — cost if wrong: none
- Task 8: Ruling: siblings = all episodes in the show dir with cached features (labeled or not); season parsed from "Season N" path component, unknown season treated as other-season — cost if wrong: weaker context
- Task 8: Ruling: add per-show signal cache (show_signals) shared by train and T9 evaluate — series columns are label-independent, so compute once per sibling-set fingerprint — cost if wrong: stale cache if key misses an input
- Task 8: Ruling: signals cache key must include sha1 of the source of candidates.py, series.py, signals.py (+SIGNAL_NAMES) so tuning iterations never read stale signals — carried into Task 9 dispatch — cost if wrong: extra recompute after unrelated edits
- Task 9: Ruling: evaluate always evaluates every show with a label file (show_dir args only filter the printed table); shows without scorable GT get a disabled report; thresholds.json is rewritten whole — prevents stale thresholds airing — cost if wrong: evaluate is slower (all shows each run)
- Task 9: Ruling: evaluate writes the global model (fit on all GT non-held-out) to data/models/global.json itself and thresholds.json carries top-level model_sha (sha1 of that model JSON); Task 10 export must refuse a mismatch — ties thresholds to the model they were calibrated on — cost if wrong: none
- Task 9: Ruling: GT-episode count for the gate = scored episodes only — cost if wrong: none
- Task 10: Ruling: user breaks are always exported and never deduped against each other; model candidates within 120 s of any user break are dropped; select_breaks runs on remaining model candidates only — cost if wrong: two user breaks <120 s apart both air (user's explicit call)
- Ruling: add Task 10b (not in plan): review page bulk "mark all undecided as Not a break" (with confirm) — real episodes have ~77 candidates, so deciding each row one by one blocks Task 12 labeling — cost if wrong: a careless bulk click mislabels a missed break as negative (mitigated by confirm + requiring the reviewer to have watched)
- Task 10b: Ruling: a decision "belongs" to the row build_rows attaches it to (nearest candidate within 1500 ms); set_decision and mark-rest replace only decisions belonging to the target row; mark-rest never removes user decisions — fixes T6 deferred minor too — cost if wrong: none
- Task 11: Ruling: speed gate judged on library-scale throughput (4 workers: ~16 s per 22-min episode) rather than single-file latency (Batman 1080p alone 40 s) — the spec's concern is full-library scan time — cost if wrong: none for scanning; single-episode first open in review stays ~40 s for 1080p
- Final: Ruling: show dir = <root>/<library>/<show> (rel paths are Library/Show/...; roots are the Plex mount) — matches all committed labels — cost if wrong: a root set at library level would mis-group (documented)
- Final: Ruling: file identity compared as size + mtime floored to whole seconds (stored size:mtime_ns values normalized on compare) — Mac SMB truncates mtime to 100 ns — cost if wrong: a same-size re-encode within the same second goes unnoticed (negligible)
- Final: Ruling: workflow = Unraid extracts only; `run-unraid.sh pull-cache` rsyncs features to the Mac cache (no --delete); labels/train/evaluate/export run on the Mac only; cache files chmod 0644 — cost if wrong: extra rsync step
- Final: Ruling: gate adds MIN_HELD_OUT_PREDICTIONS = 5 (held-out TP+FP ≥ 5) — 1 held-out episode with ~3 breaks is too thin for "no false cuts"; means ~2 held-out episodes per show — cost if wrong: more labeling per show (user may relax; surfaced at handoff)
- Final: Ruling: thresholds.json stores each enabled show's signals key; export refuses a show whose current signals key differs — cost if wrong: must re-run evaluate after extracting more episodes
- Final: Ruling: export skips user decisions on stale episodes; user "unsure" treated as rejected at export
- Final: Ruling: review page shows stale banner; complete on a stale episode requires explicit acknowledge_stale — cost if wrong: one extra click
- Final: Ruling: add-break rejects ms within 60 s of either end
- Final: Ruling: training positive = each truth's nearest candidate only (within 1500 ms)
- Final: Ruling: discover_episodes skips Plex extras dirs (Featurettes, Behind The Scenes, Deleted Scenes, Interviews, Scenes, Shorts, Trailers, Other, Extras, Specials) case-insensitively

## Deferred minor findings
- Task 1: minor (deferred): fixture kinds fadeout/fadein/darkscene/noaudio not self-tested (T2/T4 tests will exercise them)
- Task 1: minor (deferred): any noaudio segment makes whole clip video-only, undocumented
- Task 1: minor (deferred): per-segment AAC priming may drift timestamps by tens of ms across segments; later tests should use tolerances
- Task 2: minor (deferred): probe() raises CalledProcessError/KeyError instead of ExtractError; no ExtractError-path test
- Task 2: minor (deferred): reader-thread failure gives IndexError; fds not closed explicitly / leak if Popen raises
- Task 2: minor (deferred): duration_ms (container) vs len(luma) (decoded) — consumers must pick one
- Task 2: minor (deferred): _drain reads whole audio pipe at once (~0.5-1 GB for 90-min 5.1); matters with parallel workers on Unraid
- Task 2: minor (deferred): alignment test may not exercise non-zero first pts source
- Task 3: minor (deferred): ensure() loads npz twice on hit; corrupt entry raises instead of miss; mkstemp 0600 mode; summary total is summed not wall time; hidden dirs (@eaDir) not skipped; no CLI/default_roots tests
- Task 4: minor (deferred): empty luma raises; missing quiet-only/merge-boundary/150ms/order/edge-boundary tests; SAMPLE_MS duplicated
- Task 4: minor (deferred): non-None empty audio array makes _aligned return [] (drops dark candidates)
- Task 5: minor (deferred): save_labels temp leaks on json.dump error; no schema check on load; no cross-source dedupe test; missing-file ground_truth test
- Task 6: minor (deferred): parse_range non-ASCII/garbage → 500; _guard misses OSError; clip ms unbounded + key omits CLIP_SECONDS; strips no-store re-fetch; two candidates <1500ms share decision; seeds shown in UI (intended: user must confirm them); missing concurrency/symlink/range tests
- Task 6: minor (deferred): j/k during pending decision is overridden by post-completion focus advance
- Task 7: minor (deferred): Newton has no damping/convergence assert; from_json bare KeyError on malformed file
- Task 7: minor (deferred): train mkdirs models/ before fit; no CLI test for positives-without-negatives
- Task 8: minor (deferred): offset_support rebuilds arrays per call; root-level episodes get no series signals
- Task 8: minor (deferred): stale signals/*.npz accumulate; opaque KeyError path in train
- Task 9: minor (deferred): evaluate duplicates train loader / uses private helpers; missing boundary tests (LOO<0.95 blocks, ==0.95 passes)
- Task 9: minor (deferred): stale global.json left when no model fit; load_thresholds KeyError on old flat format
- Task 10: minor (deferred): --all-enabled + explicit dirs may export twice; model re-read per show
- Task 10b: minor (deferred): relabeling an unattached row deletes another unattached row within 1.5 s
- Task 11: minor (deferred): rsync --exclude data unanchored; base image tag floats (pin bookworm); no .dockerignore
- Final: deferred to before full-library scan: _drain whole-pipe audio read; offset_support array rebuild; stale signals npz accumulation
- Final: fix wave re-review: all addressed (commits f53ef246..5dc2c2a6); minors: null signals_key misleading message; has() existence-only for siblings; broad except in video stream; stale check on un-complete

## Rugrats parked (2026-11-01)

Rugrats stays disabled (plays straight through) by the user's choice; revisit later. What is known:
- Its stylized hard cuts and fades to black mid-story score like act-outs (S01E18E19 8:04, S03E23E24 16:16).
- The break sits before the next story's title card; when the fade runs straight into the card (S01E02E03 10:55) the real cut scores ~0.08 and the black after the card (11:01) wins.
- Tried offline, not built: a per-show "near this show's labelled break offsets" signal (exp(-d/15 s), computed only from other episodes' labels). It removed the stylized-cut false positives and kept SpongeBob and Fresh Prince passing.
- Still needed: a title-card rule (move a cut to before a recurring title-card sequence) and 3–4 more held-out double episodes, since each has only one break and the gate needs 5 found in training and held-out.
