# Offline episode break analysis

This experimental detector reads episode media and stores transition candidates. It does not modify media, create playback sessions, insert filler, or change scheduling. Analysis is explicitly invoked, with one decoder per Tunarr database and one FFmpeg thread by default. It can run independently while channels play.

**An accepted candidate is not yet usable.** Every configuration starts unqualified, so `usableBreaks` is empty. Heuristic confidence (`low`, `medium`, `high`) is not a probability. Real labeled episodes are required before qualification; synthetic fixtures establish behavior, not real-world precision.

## Commands

Use the installed `tunarr` command, or run `pnpm --filter @tunarr/server tunarr` followed by the arguments below from a source checkout. Choose the same global `--database` directory as your server for registered episodes. The repository requires Node 22.

```sh
tunarr break-analysis analyze --file /media/episode.mkv --runtime-ms 1440000 --output episode-breaks.json
tunarr break-analysis analyze --program-id EPISODE_UUID --output episode-breaks.json
tunarr break-analysis batch --input batch.json --output batch-results.json
tunarr break-analysis report --input episode-breaks.json --output episode-breaks.html
tunarr break-analysis evaluate --input episodes.json --output evaluation.json
```

Evaluation also creates `evaluation.json.html`. Paths in an evaluation manifest are relative to the manifest. Output directories must already exist. Standalone analysis does not import a program; it writes an artifact and keeps an unassociated analysis record. Registered analysis uses existing media versions and files. All JSON timestamps, runtimes, intervals, and tolerances are **milliseconds**; labeled HTML reports display seconds.

Optional analysis/evaluation flags: `--config detector.json`, `--force`, `--video-stream-index N`, `--audio-stream-index N`, `--threads 1`, `--timeout-ms 14400000`. For batch, put these settings in the request JSON using camelCase; batch JSON is authoritative. Ctrl-C cancels CLI processing. Incomplete analysis has a failure/interrupted status and never represents a successful zero-break result.

Example batch request (choose exactly one selector):

```json
{"programIds": ["00000000-0000-4000-8000-000000000001"], "force": false}
```

Other selectors are `seriesId`, `libraryId`, or `allEpisodes: true`. Batches process episode versions sequentially and continue past per-episode failures. Missing/multipart files and ambiguous remote versions are skipped, with reasons. Files must be no longer than four hours. No automatic scans or recurring schedule are installed.

## API

After deploying this build, invoke the task with an explicit selection. For example, analyze all registered episodes in the background (replace the host and port for your installation):

```sh
curl -X POST 'http://localhost:8000/api/tasks/AnalyzeEpisodeBreaksTask/run?background=true' \
  -H 'Content-Type: application/json' \
  -d '{"allEpisodes":true}'
```

For a smaller first run, replace the body with `{"programIds":["EPISODE_UUID"]}` or `{"seriesId":"SERIES_UUID"}`. A 202 response means the task was accepted for background execution, not that analysis is complete. Inspect per-episode results using the GET endpoint below. The current Settings → Tasks Run button does not send task arguments, so use the API or CLI for this task.

- `POST /api/tasks/AnalyzeEpisodeBreaksTask/run` accepts the same batch request. Existing task API background behavior applies (202 by default).
- `GET /api/programs/:id/break-analysis?limit=20&offset=0` returns analysis history with current qualification and source freshness. Versions and media files are identified explicitly. An empty array means no stored analysis.
- `DELETE /api/break-analysis/:id` cancels active decoding owned by that server process; `cancelled: false` means it is not active there. Use Ctrl-C for a separate CLI process.

Results include `candidates` with `timestampMs`, `confidence`, `accepted`, `reasons`, and measured `evidence`; `usableBreaks` is a separate projection. A completed result with `candidates: []` is valid. Results also record detector/configuration versions, fingerprint, selected streams, status, and `scanWindow: {startMs, endMs}`. Equal scan endpoints mean there was no eligible interval to decode. Never consume an old exported `usableBreaks` list without checking file identity; a later playout feature must implement that check.

## Rules and tuning

The baseline samples small grayscale frames and per-channel audio RMS every 100 ms. It requires a brief near-black interval, overlapping silence, a fade into black, motion on both sides, audible surrounding context, and different imagery at multiple offsets. It measures each audio channel before combining levels to prevent phase cancellation from becoming false silence. FFmpeg only emits features to pipes; it writes no media output.

Black plus silence alone is insufficient. Continued imagery, long darkness, silent surroundings, static imagery, incomplete context, and excluded regions reject a candidate. Unknown dramatic transitions and animated/title sequences can still resemble commercial breaks; this is why the baseline remains experimental until evaluated on actual episodes.

Defaults: 99% pixels at or below 0.08 normalized brightness; black duration 250–5000 ms; silence below −45 dBFS for at least 200 ms; ten seconds of context; minimum visual difference 0.18; minimum motion 0.008. In `conservative-fade-v3`, fade detection examines up to 1.5 seconds including the first black sample. It requires at least three descending steps, an 80% relative luminance decrease from a starting mean of at least 0.04, and little upward movement. This supports short fades and fades from dark scenes. Scene change must pass either the raw pixel difference threshold or a brightness-normalized spatial comparison (cosine distance, configurable `spatialDifference`, default 0.2) at all three offsets. Black intervals longer than two seconds additionally require one second of overlapping silence, and the spatial comparison. Surrounding audio must exceed the silence threshold by 10 dB in at least 60% of each context window. These fixed extraction/rule details are versioned with the detector.

Starting with `conservative-fade-v2`, the first and last **four minutes** are protected regardless of runtime. FFmpeg seeks to the eligible interval and stops decoding at its end, rather than analyzing the whole episode and filtering afterward. Codec seeking may require a little keyframe preroll. Reported timestamps still refer to the original file. The scan interval is rounded inward to the 100 ms sampling grid. An episode of fifteen minutes or less produces a completed empty analysis without launching FFmpeg or ffprobe.

The ten-second context requirement still applies entirely inside the scan interval, so candidates too near its edges cannot be accepted with incomplete context. `startExclusionMs` and `endExclusionMs` can increase the protected durations; values below 240000 are clamped to that floor. Legacy percentage settings remain readable in historical results but are normalized to zero for new analyses. Existing typed intro/outro intervals retain five-second exclusion margins. Starting with v5, ordinary chapter markers are neutral: they neither create nor veto a candidate. Generic DVD chapters may coincide with commercial breaks and do not reliably identify cartoon/episode segment boundaries. Known segment boundaries can still be supplied as explicit exclusions to file analysis; the detector continues to require independent audiovisual evidence.

Rerunning the task after updating creates v2 results; v1 cached results are not reused and v1 qualification does not qualify v2. This change narrows the scanned region; it does not relax black-duration, fade, or scene-difference requirements.

Cluster spans are limited to three seconds; the strongest actual transition is retained, not an average of unrelated times. Breaks have three-minute minimum spacing. Runtime caps are 0 below 10 minutes, 1 below 20, 3 below 30, 5 below 60, and 6 thereafter. Caps only remove candidates. Defaults and validation live in `BreakDetectorConfigSchema`; a partial JSON object overrides defaults. Runtime cap bands must be increasing. Cross-episode inference is deferred.

The database stores historical runs, separate from chapter metadata. Matching source/configuration/version results can be reused unless forced. Local identity includes path, size, modification time, and file change time. Remote identity uses provider/file metadata plus available HTTP validators. Sources without validators are reanalyzed and remain diagnostic-only. Authenticated URLs and headers are neither persisted nor logged. Readable local/path-replaced media is preferred. Remote sources are direct original streams; ambiguous version selection is rejected rather than silently analyzing another edit.

## Ground truth and qualification

A partially labeled real-episode baseline is saved in `server/src/testing/resources/break-analysis/extended-black-1503.json`: the user-confirmed breaks at 9:24 and 15:03 were found but rejected by v1. See the README in that directory for their measurements and the distinction between archived-output regression tests and replaying the original media.

Copy `server/src/testing/resources/break-analysis/manifest.example.json` and replace the paths/labels. Real media should stay outside the repository. Label every legitimate break in an episode, including zero-break examples. Use explicit exclusion intervals only for known intro/outro/segment regions, never to hide detector errors. Include the known mouth example, scene fades, dark animation, silent scenes, title cards, theme/cold-open transitions, credits, dramatic cuts, and multiple-short-cartoon files.

Reports show expected and detected timestamps, classifications, one-to-one matches, timing errors, false positives, missed breaks, and rejection diagnostics. Matching maximizes the number of matches within the tolerance (default ±2000 ms), then minimizes total timing error. Precision with no detections is undefined. The report evaluates accepted experimental candidates even while `usableBreaks` is empty.

Tune on development episodes and evaluate the frozen configuration on different held-out episodes. Qualification requires a real held-out report, at least one match, zero false positives, no failed/stale results, one detector/configuration, and explicit operator review:

```sh
tunarr break-analysis qualify --input evaluation.json --acknowledge --acknowledged-by "Reviewer name"
```

This records the evaluation digest, dataset, reviewer, detector, and configuration. It does not enable playback. A new detector or configuration needs its own qualification. Results rejected by the rules or invalidated by source changes remain unusable regardless of qualification. A small perfect test set does not establish a population-wide error rate; inspect diverse episodes before relying on results.

Run focused tests with `pnpm --filter @tunarr/server exec vitest run src/services/break-analysis`. FFmpeg integration tests generate a short lossless fixture in a temporary directory and skip when FFmpeg/ffprobe are unavailable. No copyrighted episode media is included.

`conservative-fade-v4` removes the additional near-zero brightness hold introduced in v3. Fade decrease is measured relative to the observed black level rather than digital zero. It uses the configured black-pixel threshold consistently; extended intervals still require a fade, at least one second of overlapping silence, spatial scene change, and the existing context checks. V3 rejected both confirmed transitions on the deployed server solely because of its extra near-zero hold, despite passing local media validation. Portable tests now cover nonzero black pixel floors as well as the original samples.
