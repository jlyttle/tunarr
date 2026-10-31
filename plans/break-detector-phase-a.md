# Break Detector (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, fast, offline tool that finds intended commercial-break points in TV episodes with high precision. It measures its quality per show against user-confirmed labels and exports break markers for Tunarr to consume in Phase B.

**Architecture:** A Python package at `tools/breakdetect/` with a two-stage pipeline:
1. One ffmpeg decode per episode produces a compact feature file that is cached on disk.
2. Everything after that (candidate finding, sibling-episode context, a learned scoring model, evaluation, export) re-runs in seconds from the cache.

A small local web page collects the user's confirmations. The labels it writes double as training data and as held-out ground truth.

**Tech Stack:** Python 3.12 (venv via `uv`), numpy, pytest, and ffmpeg/ffprobe on the PATH (VideoToolbox on the Mac; VAAPI/QSV on the Unraid i7-8700K). There are no ML frameworks: logistic regression is implemented in numpy.

**Spec:** `plans/use-the-brainstorming-plugin-jolly-crown.md`

## Global Constraints

- **Precision over recall.** A show is "enabled" only when its held-out precision is ≥ 0.95. A false mid-scene cut is the worst outcome.
- **No single signal vetoes a candidate.** Signals are combined into one score.
- **Thresholds are learned from labels, not hand-picked.** Hand-set constants are allowed only for permissive candidate generation.
- **Chapter markers are an input feature only.** They are never required, and they never veto.
- **Episodes with no break above threshold export zero breaks.** There is no interval or guessed fallback.
- **Source media is read-only.** Caches go in `.local/breakdetect/`, which is gitignored. Labels and markers are committed under `tools/breakdetect/data/`.
- **Each episode is decoded once for features.** Review clips are cut on demand using input seeking (`-ss` before `-i`), never by decoding the whole file again.
- **Speed target:** under 30 s per 22-minute episode on Unraid; report the Mac number too.
- **Fork-only work.** No upstream process applies.
- **Python 3.12 or newer.** The system Python is 3.15, so pin 3.12 with `uv` to get numpy wheels.

## Review Focus

1. **Multi-segment files** (e.g., Rugrats `S02E01E02`, Courage's two stories per file). The gap between segments is a legitimate break and must not be suppressed as an "outro". Task 4 adds `test_mid_file_segment_gap_is_candidate`.
2. **No audio stream, or more than one audio stream.** Extraction must still succeed: features carry `audio_rms_db=None`, and the scorer treats audio features as missing rather than silent. Task 2 adds `test_extract_video_only_file`; Task 7 adds `test_missing_audio_features_do_not_score_as_silence`.
3. **Network share drops mid-decode.** A partial feature file must never be cached as complete. Task 3 adds `test_failed_extract_leaves_no_cache_entry`.
4. **Episodes that open or close on black**, such as cold opens, network logos, and credits. Without handling, these produce confident candidates in the first and last 60 s. Task 4 adds `test_edge_candidates_excluded`.
5. **A file that is replaced (re-encoded) after labeling.** The cache key and label key must notice the change. Labels for a changed file are flagged stale and left out of evaluation. Task 5 adds `test_changed_file_marks_labels_stale`.

---

## File Structure

```
tools/breakdetect/
  pyproject.toml              # package + pytest config, console script `breakdetect`
  README.md                   # how to run each command, data layout
  breakdetect/
    __init__.py
    cli.py                    # argparse subcommands: extract, review, train, evaluate, export, import-seeds
    media.py                  # ffprobe wrapper, episode discovery, relative paths, file identity
    features.py               # Features dataclass, single-pass ffmpeg extraction, npz save/load
    cache.py                  # feature cache keyed by file identity + EXTRACTOR_VERSION; batch runner
    candidates.py             # permissive candidate generation from Features
    labels.py                 # label file schema, load/save, staleness, seed import
    review/server.py          # local http server: pages, clip endpoint, label POSTs
    review/static/            # index.html, episode.html, review.js, review.css
    signals.py                # per-candidate feature vector (named columns)
    series.py                 # sibling-episode context: offset clustering, bumper matching
    model.py                  # numpy logistic regression: fit, predict, save/load
    evaluate.py               # matching, leave-one-episode-out, per-show threshold + gate
    export.py                 # markers JSON for enabled shows
  tests/
    conftest.py               # synthetic clip generator (ffmpeg lavfi) fixtures
    test_*.py                 # one per module
  docker/
    Dockerfile                # python:3.12-slim + ffmpeg + intel-media-va-driver
    run-unraid.sh             # ssh helper: build, run extract over /mnt/user/... paths
  data/
    labels/<show-slug>.json   # committed
    markers/<show-slug>.json  # committed
    models/global.json        # committed trained weights
```

---

### Task 1: Scaffold, toolchain, and synthetic clip fixtures

**Files:**
- Create: `tools/breakdetect/pyproject.toml`, `tools/breakdetect/breakdetect/__init__.py`, `tools/breakdetect/tests/conftest.py`, `tools/breakdetect/tests/test_fixtures.py`, `tools/breakdetect/README.md`
- Modify: `.gitignore` (add `.local/breakdetect/`, `tools/breakdetect/.venv/`)

**Interfaces:**
- Produces the pytest fixture `make_clip(tmp_path_factory) -> Callable[[list[Seg]], Path]`, where `Seg = tuple[str, float]`. Kinds:
  - `"content"`: `testsrc2` with a 440 Hz sine at −20 dBFS
  - `"black"`: black frames with silence
  - `"fadeout"`: content fading to black over the given duration
  - `"fadein"`: the reverse
  - `"darkscene"`: dim, moving content at luma ≈ 0.12, with audio
  - `"noaudio"`: used alone, produces a video-only file

  The output is an H.264/AAC MKV, 640×360 at 29.97 fps.

- [ ] **Step 1:** Install the toolchain. Run `brew install uv`, then `cd tools/breakdetect && uv venv --python 3.12 && uv pip install -e '.[dev]'`. Dependencies are `numpy`, plus dev dependency `pytest`. The console script is `breakdetect = breakdetect.cli:main`.
- [ ] **Step 2:** Write `test_make_clip_duration_and_streams`. It builds `[("content",5),("black",1),("content",5)]` and asserts the ffprobe duration is 11.0 ± 0.1 s, with one video stream and one audio stream.
- [ ] **Step 3:** Run `uv run pytest tests/test_fixtures.py -v`. Expect FAIL: fixture not found.
- [ ] **Step 4:** Implement `make_clip` in `conftest.py`. Build each segment with `ffmpeg -f lavfi`, then concatenate with the concat demuxer. Cache by segment-list hash in `tmp_path_factory`.
- [ ] **Step 5:** Run the test again. Expect PASS.
- [ ] **Step 6:** Commit with `chore(breakdetect): scaffold python package and synthetic clip fixtures`.

### Task 2: Single-pass feature extraction

**Files:**
- Create: `breakdetect/media.py`, `breakdetect/features.py`, `tests/test_features.py`

**Interfaces:**
- `probe(path: Path) -> Probe` returns a dataclass with `duration_ms: int`, `has_audio: bool`, `audio_channels: int`, `chapters_ms: list[int]` (chapter start times, excluding 0), and `video_codec: str`.
- `@dataclass Features` has these fields:
  - `duration_ms: int`
  - `fps: float` (always 10.0)
  - `luma: np.ndarray[float32, (T,)]`: mean luma, 0–1
  - `thumbs: np.ndarray[uint8, (T, 36, 64)]`
  - `audio_rms_db: np.ndarray[float32, (A,)] | None`: one value per 100 ms, the maximum across channels
  - `chapters_ms: list[int]`
  - `extractor_version: str`
- `extract_features(path: Path, hwaccel: str | None = None, threads: int = 0) -> Features`
- `save_features(f: Features, dest: Path) -> None` and `load_features(src: Path) -> Features` use npz.
- `EXTRACTOR_VERSION = "1"`

- [ ] **Step 1:** Write `test_extract_finds_black_and_silence`. The clip is `[("content",8),("black",1),("content",8)]`. Assert:
  - `luma[int(8.5*10)] < 0.05`
  - `luma[40] > 0.2`
  - `audio_rms_db[85] < -60`
  - `audio_rms_db[40] > -30`
  - `abs(duration_ms - 17000) < 150`
  - `thumbs.shape[1:] == (36, 64)`
- [ ] **Step 2:** Write `test_extract_video_only_file`. Use a `noaudio` clip and assert `audio_rms_db is None` with `luma` populated.
- [ ] **Step 3:** Write `test_extract_reports_chapters`. Add chapters to the fixture with ffmetadata at 8000 ms, and assert `chapters_ms == [8000]`.
- [ ] **Step 4:** Run the tests. Expect FAIL.
- [ ] **Step 5:** Implement the extraction as one ffmpeg process:
  - Video filter `fps=10,scale=64:36:flags=area,format=gray` writes rawvideo to stdout.
  - Audio `aresample=8000,format=s16` (all channels kept) writes s16le to a second pipe, an `os.pipe()` passed with `pass_fds` as `pipe:3`.
  - Read both pipes concurrently using threads.
  - Add `-hwaccel <x>` only when `hwaccel` is set; `threads=0` means let ffmpeg choose.
  - If the ffmpeg exit code is non-zero, raise `ExtractError` with the tail of stderr.
- [ ] **Step 6:** Run the tests. Expect PASS.
- [ ] **Step 7:** Commit with `feat(breakdetect): single-pass feature extraction`.

### Task 3: Feature cache and batch extract command

**Files:**
- Create: `breakdetect/cache.py`, `breakdetect/cli.py`, `tests/test_cache.py`
- Modify: `breakdetect/media.py` (add discovery helpers)

**Interfaces:**
- `relative_path(path: Path, roots: list[Path]) -> str` returns, for example, `"Kids TV/Rugrats/Season 2/x.mkv"`. The default roots are `/Volumes/plex` and `$BREAKDETECT_ROOTS`.
- `file_identity(path) -> str` returns `f"{size}:{mtime_ns}"`.
- `discover_episodes(show_dir: Path) -> list[Path]` covers video extensions `.mkv .mp4 .avi .m4v .mpg .ts` and skips `Specials`.
- `FeatureCache(root: Path)` provides:
  - `.key(path) -> str`: sha1 of `relative_path|file_identity|EXTRACTOR_VERSION`
  - `.get(path) -> Features | None`
  - `.ensure(path, **extract_kwargs) -> Features`
- `run_batch(paths: list[Path], workers: int, hwaccel: str | None) -> list[BatchResult]`. Each `BatchResult` has `rel_path`, `status` (`"cached"`, `"extracted"` or `"failed"`), `seconds` and `error`.
- CLI: `breakdetect extract <path-or-show-dir>... [--workers N] [--hwaccel auto|videotoolbox|vaapi|qsv]` prints one line per episode plus a summary of total seconds and seconds per minute of media.

- [ ] **Step 1:** Write `test_second_ensure_uses_cache`. Monkeypatch `extract_features` to count calls, run `ensure` twice, and assert one call.
- [ ] **Step 2:** Write `test_failed_extract_leaves_no_cache_entry`. Make `extract_features` raise, assert `cache.get(path) is None`, and assert no file exists under the cache root (atomic write: temp file, then `os.replace`).
- [ ] **Step 3:** Write `test_changed_mtime_misses_cache`.
- [ ] **Step 4:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 5:** Benchmark one 22-minute episode from each of Batman TAS, Rugrats and Courage on the Mac, with and without `--hwaccel videotoolbox`. Record the timings in `tools/breakdetect/README.md`.
- [ ] **Step 6:** Commit with `feat(breakdetect): cached parallel batch extraction`.

### Task 4: Permissive candidate generation

**Files:**
- Create: `breakdetect/candidates.py`, `tests/test_candidates.py`

**Interfaces:**
- `@dataclass Candidate` has these fields:
  - `start_ms`, `end_ms`: the dark/quiet region
  - `cut_ms`: the midpoint, where Tunarr will cut
  - `kind`: `"dark"`, `"quiet"` or `"dark+quiet"`
  - `min_luma: float`
  - `min_rms_db: float | None`
- `find_candidates(f: Features, edge_ms: int = 60_000) -> list[Candidate]`

Rules, which deliberately over-generate:
- Thresholds are relative to the episode. The dark threshold is `max(0.06, p2(luma) + 0.03)`. Quiet means below `p5(rms) − 3 dB` or below −50 dBFS.
- A region counts if it lasts at least 150 ms.
- Regions closer than 1 s are merged.
- Anything with `cut_ms` within `edge_ms` of either end of the file is dropped.

- [ ] **Step 1:** Write `test_black_gap_is_candidate`. The fixture is content 70, black 0.5, content 70. Assert one candidate with `cut_ms` within 150 ms of 70250 and `kind == "dark+quiet"`.
- [ ] **Step 2:** Write `test_fade_gap_is_candidate`. The fixture is content 70, fadeout 1, black 0.3, fadein 1, content 70. Assert one candidate.
- [ ] **Step 3:** Write `test_edge_candidates_excluded`. The fixture is black 2, content 130, black 2. Assert no candidates.
- [ ] **Step 4:** Write `test_mid_file_segment_gap_is_candidate`. The fixture is content 200, fadeout 1, black 2, content 200. Assert one candidate. It is not treated as an outro.
- [ ] **Step 5:** Write `test_dark_scene_with_audio_is_still_candidate_but_kind_dark`. Assert the candidate exists, so the scorer decides rather than a veto.
- [ ] **Step 6:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 7:** Commit with `feat(breakdetect): permissive candidate generation`.

### Task 5: Label store and seed import

**Files:**
- Create: `breakdetect/labels.py`, `tests/test_labels.py`

**Interfaces:**
- The label file is `data/labels/<show-slug>.json`:
  ```json
  {"schema": 1, "show": "Rugrats", "episodes": {"<rel_path>": {
    "identity": "size:mtime_ns", "duration_ms": 0, "complete": false, "held_out": false,
    "decisions": [{"cut_ms": 0, "label": "break|not_break|unsure", "source": "user|seed"}]}}}
  ```
- `load_labels(show_slug) -> ShowLabels`, `save_labels(ShowLabels) -> None` (atomic writes)
- `ShowLabels.ground_truth(rel_path) -> list[int] | None` returns the `cut_ms` of each `label == "break"` decision whose `source == "user"`. It returns `None` unless the episode is `complete` and not stale.
- `is_stale(entry, path) -> bool` compares the stored identity with the current `file_identity`.
- `import_seeds(dataset_json: Path, pilot_review_json: Path) -> dict[str, ShowLabels]`:
  - Research `breaks[].timestamp_s` and pilot `assistant-proposed` decisions become `source: "seed", label: "unsure"`.
  - Pilot `user-confirmed` decisions become `source: "user", label: "break"`.
  - Imported episodes are never marked complete.
- `slugify(show) -> str`

- [ ] **Step 1:** Write `test_round_trip`.
- [ ] **Step 2:** Write `test_seed_labels_are_not_ground_truth`.
- [ ] **Step 3:** Write `test_incomplete_episode_has_no_ground_truth`.
- [ ] **Step 4:** Write `test_changed_file_marks_labels_stale`.
- [ ] **Step 5:** Write `test_import_maps_pilot_user_confirmed_to_user_break`, using a small inline copy of the pilot `review.json` shape.
- [ ] **Step 6:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 7:** Wire up the `breakdetect import-seeds` CLI. Run it against `research/commercial-break-ground-truth-v1/dataset.json` and `server/src/testing/resources/break-analysis/pilot-v1/review.json`, then commit the resulting `data/labels/*.json`.
- [ ] **Step 8:** Commit with `feat(breakdetect): label store and seed import`.

### Task 6: Review web page

**Files:**
- Create: `breakdetect/review/server.py`, `breakdetect/review/static/{index.html,episode.html,review.js,review.css}`, `tests/test_review_server.py`

**Interfaces:**
- `breakdetect review <show-dir> [--port 8765]` starts a `http.server.ThreadingHTTPServer` on localhost.
- Routes:
  - `GET /`: shows with their episodes and label progress.
  - `GET /episode?rel=…`: the episode page.
  - `GET /api/episode?rel=…`: JSON with candidates and current decisions. Scores are included once a model exists; they are hidden until the episode is marked complete, which keeps review blind.
  - `GET /clip?rel=…&ms=…`: an 8 s, 480p mp4 starting at `ms − 5000`, cut with `-ss` before `-i` and cached in `.local/breakdetect/clips/`.
  - `GET /strip?rel=…&ms=…`: a JPEG strip of 9 thumbnails at −4…+4 s taken from the cached `thumbs`, so no decode is needed.
  - `GET /video?rel=…`: the full file with HTTP range support, used to scrub for missed breaks.
  - `POST /api/decision` with body `{rel, cut_ms, label}`.
  - `POST /api/add-break` with body `{rel, ms}`, for a break the generator missed.
  - `POST /api/complete` with body `{rel, complete, held_out}`.
- The page lists candidates in time order, each with its clip and three buttons: **Break**, **Not a break** and **Unsure**. Keyboard shortcuts are `b`, `n` and `u`. **Mark episode complete** is enabled only when every candidate has a decision.

- [ ] **Step 1:** Write `test_post_decision_persists`. Start the server on port 0 in a thread, POST a decision, and assert `load_labels` reflects it with `source == "user"`.
- [ ] **Step 2:** Write `test_complete_rejected_when_undecided_candidates`. Expect HTTP 409.
- [ ] **Step 3:** Write `test_clip_uses_input_seek`. Monkeypatch subprocess and assert `-ss` comes before `-i` in the argv.
- [ ] **Step 4:** Write `test_add_break_records_user_break`.
- [ ] **Step 5:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 6:** Check by hand with `breakdetect review "/Volumes/plex/Kids TV/Rugrats"`. Review one episode end to end in the browser.
- [ ] **Step 7:** Commit with `feat(breakdetect): local review page for confirming breaks`.

### Task 7: Per-candidate signals and scoring model

**Files:**
- Create: `breakdetect/signals.py`, `breakdetect/model.py`, `tests/test_signals.py`, `tests/test_model.py`

**Interfaces:**
- `SIGNAL_NAMES: list[str]`. The columns, in this order:
  1. `dark_depth`: `p50(luma) − min_luma`
  2. `dark_ms`
  3. `quiet_depth_db`
  4. `quiet_ms`
  5. `audio_missing` (0 or 1)
  6. `fade_out_slope`: the luma slope over 1.5 s before `start_ms`
  7. `fade_in_slope`
  8. `scene_change`: the mean absolute difference between thumbnails 2 s before and 2 s after
  9. `context_loudness_db`: median RMS within ±10 s, excluding the gap
  10. `rel_pos`: `cut_ms / duration_ms`
  11. `near_chapter`: 1 if a chapter boundary is within 2 s
  12. `series_offset_support` (from Task 8)
  13. `bumper_match` (from Task 8)
- `candidate_signals(c: Candidate, f: Features, series: SeriesContext | None) -> np.ndarray`. Until Task 8, `series` is `None` and columns 12–13 are 0. Columns that depend on audio are 0 when audio is missing, and `audio_missing` is set to 1.
- `LogisticModel` provides:
  - `fit(X, y, l2=1.0) -> LogisticModel`: standardize the columns, then gradient descent or Newton in numpy
  - `predict(X) -> np.ndarray` returning probabilities
  - `to_json() / from_json()`
- CLI: `breakdetect train` fits on all ground-truth episodes that are not held out, across all shows. Each candidate is matched to labels within ±1500 ms. Candidates with no matching `break` count as negatives, but only in complete episodes. The output is written to `data/models/global.json`.

- [ ] **Step 1:** Write `test_signal_vector_length_matches_names`.
- [ ] **Step 2:** Write `test_fade_slopes_negative_then_positive` using a fade fixture.
- [ ] **Step 3:** Write `test_missing_audio_features_do_not_score_as_silence`. Assert that for a video-only clip, `quiet_depth_db == 0` and `audio_missing == 1`.
- [ ] **Step 4:** Write `test_logistic_separates_synthetic_classes`. The data is two Gaussian blobs; assert AUC > 0.95 and that the `to_json`/`from_json` round trip gives the same predictions.
- [ ] **Step 5:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 6:** Commit with `feat(breakdetect): candidate signals and logistic scoring model`.

### Task 8: Sibling-episode context

**Files:**
- Create: `breakdetect/series.py`, `tests/test_series.py`

**Interfaces:**
- `@dataclass SeriesContext` holds `offsets_by_episode: dict[str, list[int]]` (candidate `cut_ms` per sibling) and `transitions_by_episode: dict[str, list[np.ndarray]]` (the 9 thumbnails just before each candidate's gap).
- `build_series_context(episodes: dict[str, tuple[Features, list[Candidate]]]) -> SeriesContext`. Siblings are the same show directory; same season is weighted 1.0 and other seasons 0.5.
- `offset_support(ctx, rel, c) -> float`: the weighted share of other episodes with a candidate whose `cut_ms` is within ±20 s (absolute) or ±2% of runtime (relative).
- `bumper_match(ctx, rel, c) -> float`: the best similarity, as `1 − mean absolute difference` over the 9-frame sequences, against transitions in other episodes. A transition only counts if it is at least 3 minutes away from the episode's own other candidates.
- Both functions return 0.0 when there are fewer than 2 siblings.

- [ ] **Step 1:** Write `test_offset_support_counts_aligned_siblings`. Use three fake episodes with candidates at about 7:00 and one with a candidate at 3:10. Assert support is about 1.0 for the 7:00 candidate and about 0 for 3:10.
- [ ] **Step 2:** Write `test_bumper_match_detects_repeated_frames`. Give two episodes identical 9-frame sequences and a third random ones; assert above 0.95 versus below 0.7.
- [ ] **Step 3:** Write `test_single_episode_returns_zero`.
- [ ] **Step 4:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 5:** Wire `SeriesContext` into `candidate_signals` (columns 12 and 13) and into `breakdetect train`.
- [ ] **Step 6:** Commit with `feat(breakdetect): sibling-episode offset and bumper signals`.

### Task 9: Evaluation and per-show gate

**Files:**
- Create: `breakdetect/evaluate.py`, `tests/test_evaluate.py`

**Interfaces:**
- `match(pred_ms: list[int], truth_ms: list[int], tol_ms: int = 1500) -> tuple[int, int, int]` returns `(tp, fp, fn)` using greedy one-to-one matching by distance.
- `evaluate_show(show_slug, model_fitter) -> ShowReport`. For each ground-truth episode of the show, it refits the global model with that episode removed (leave-one-episode-out) and scores the episode. Episodes flagged `held_out` are always scored and never trained on.
- `choose_threshold(scored: list[tuple[float, bool]], min_precision=0.95, min_positives=5) -> float | None` returns the lowest threshold whose precision is at least `min_precision`. It returns `None` if fewer than `min_positives` true breaks are above it.
- `ShowReport` holds:
  - `show`, `episodes`
  - `threshold: float | None`
  - `precision`, `recall` at that threshold
  - `enabled: bool`, true only when the threshold is not `None` and held-out precision is at least 0.95 on 3 or more ground-truth episodes
  - `false_positives: list[tuple[rel, cut_ms, score]]`
- CLI: `breakdetect evaluate [show…]` prints a table and writes `.local/breakdetect/reports/<date>.json`.
- Thresholds are kept in `data/models/thresholds.json`, as show slug to threshold, only for enabled shows.

- [ ] **Step 1:** Write `test_match_one_to_one`. Two predictions near one truth should give 1 TP and 1 FP.
- [ ] **Step 2:** Write `test_choose_threshold_meets_precision`.
- [ ] **Step 3:** Write `test_choose_threshold_none_when_too_few_positives`.
- [ ] **Step 4:** Write `test_show_not_enabled_with_two_episodes`.
- [ ] **Step 5:** Write `test_held_out_episode_never_in_training`. Spy on `model_fitter`.
- [ ] **Step 6:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 7:** Commit with `feat(breakdetect): leave-one-out evaluation and precision gate`.

### Task 10: Marker export

**Files:**
- Create: `breakdetect/export.py`, `tests/test_export.py`

**Interfaces:**
- The marker file is `data/markers/<show-slug>.json`. This is the contract Phase B imports:
  ```json
  {"schema": 1, "detector": "breakdetect/<EXTRACTOR_VERSION>/<model sha8>", "show": "Rugrats",
   "threshold": 0.0, "episodes": [{"relativePath": "Kids TV/Rugrats/Season 2/x.mkv",
     "durationMs": 0, "breaks": [{"offsetMs": 0, "score": 0.0}]}]}
  ```
- `export_show(show_slug) -> Path | None` returns `None` and writes nothing for shows that are not enabled.
  - It includes every discovered episode with cached features, including ones with no breaks.
  - Each break is a candidate at or above the threshold, with `offsetMs = cut_ms`.
  - User-confirmed breaks are always included, at score 1.0. User `not_break` candidates are always excluded.
  - Breaks closer than 120 s to each other are deduplicated, keeping the higher score.
- CLI: `breakdetect export [show…|--all-enabled]`.

- [ ] **Step 1:** Write `test_disabled_show_not_exported`.
- [ ] **Step 2:** Write `test_user_rejection_overrides_score`.
- [ ] **Step 3:** Write `test_episode_without_breaks_has_empty_list`.
- [ ] **Step 4:** Write `test_breaks_closer_than_120s_deduped`.
- [ ] **Step 5:** Run the tests. Expect FAIL. Implement, then run again. Expect PASS.
- [ ] **Step 6:** Commit with `feat(breakdetect): export break markers for enabled shows`.

### Task 11: Unraid container and benchmark

**Files:**
- Create: `tools/breakdetect/docker/Dockerfile`, `tools/breakdetect/docker/run-unraid.sh`
- Modify: `tools/breakdetect/README.md`

**Interfaces:**
- The image is `breakdetect:local`, built from `python:3.12-slim` plus `ffmpeg`, `intel-media-va-driver-non-free` and `vainfo`. The package is installed into it.
- `run-unraid.sh <cmd> [args]` rsyncs `tools/breakdetect` to `root@192.168.1.227:/mnt/user/appdata/breakdetect/src`, builds the image over ssh, and runs it with:
  - `--device /dev/dri`
  - the media mounted read-only at `/media/plex`, with `BREAKDETECT_ROOTS=/media/plex`
  - `/mnt/user/appdata/breakdetect/{cache,data}` mounted read-write

  Before writing the script, find the host's media path with `docker inspect plex`.
- Relative paths must come out the same on the Mac (`/Volumes/plex/...`) and in the container (`/media/plex/...`).

- [ ] **Step 1:** Write `test_relative_path_same_across_roots` in `tests/test_cache.py`. The same file under the two roots must give the same `relative_path`.
- [ ] **Step 2:** Run the test. Expect FAIL if roots handling is incomplete. Fix it, then run again. Expect PASS.
- [ ] **Step 3:** Build the image and run `vainfo` in the container. Expect the iHD driver to be listed.
- [ ] **Step 4:** Benchmark the three Task 3 episodes with `--hwaccel vaapi --workers 4` and record the seconds per episode in the README. **Gate:** under 30 s per 22-minute episode. If it misses, try `--hwaccel qsv`, then software decode with `--workers 10`, and record what worked.
- [ ] **Step 5:** Commit with `feat(breakdetect): unraid container and benchmark`.

### Task 12: Pilot on the test channel (human-in-the-loop)

There are no new files beyond labels, models, thresholds and markers.

- [ ] **Step 1:** Ask the user which slot channel is the test channel and list its shows. Read the lineup with `GET http://192.168.1.227:4200/api/channels` and the channel's schedule.
- [ ] **Step 2:** Run `breakdetect extract` for every episode of those shows, on Unraid.
- [ ] **Step 3:** The user reviews 3–4 episodes per show in `breakdetect review`. Mark one per show `held_out`, and pick episodes across different seasons.
- [ ] **Step 4:** Run `breakdetect train`, then `breakdetect evaluate`. For every show that isn't enabled, look at its false positives and missed breaks. Iterate on signals and candidate rules (Tasks 4, 7 and 8), with tests for any new rule. Re-scoring must not need a new decode, so check that the iteration loop takes seconds.
- [ ] **Step 5:** Run `breakdetect export --all-enabled` and commit `data/models/*` and `data/markers/*`.
- [ ] **Step 6:** Report per-show precision, recall and enabled status to the user, and list the shows that couldn't be enabled and why. That report is the input to the Phase B plan.

## Verification

- `cd tools/breakdetect && uv run pytest -v` passes.
- The `breakdetect evaluate` report shows held-out precision ≥ 0.95 for each enabled show on the test channel.
- The benchmark table in the README shows Unraid under 30 s per 22-minute episode.

## Next

The Phase B plan (Tunarr's `detected` mid-roll rule, the "split slot flex" duration mode, and marker import) gets written after Task 12. The marker contract in Task 10 is its input.
