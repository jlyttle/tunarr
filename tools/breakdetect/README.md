# breakdetect

Offline, ffmpeg-based detector for intended commercial-break points in TV episodes.

## Setup

    uv venv --python 3.12
    uv pip install -e '.[dev]'
    uv run pytest

## Extract

    uv run breakdetect extract <episode-or-show-dir>... [--workers N] [--hwaccel auto|videotoolbox|vaapi|qsv] [--cache DIR]

Features are cached under `<repo>/.local/breakdetect/features/` (override with `BREAKDETECT_CACHE` or `--cache`).
Cache keys use the path relative to the first matching root in `BREAKDETECT_ROOTS` (os.pathsep-separated, default `/Volumes/plex`).

## Review

    uv run breakdetect review <show-dir> [--port 8765] [--cache DIR]

Serves a local review page on 127.0.0.1. Keys: `b` break, `n` not a break, `u` unsure, `j`/`k` or arrows to move.
Use Chrome or Firefox. Safari cannot play `.mkv`, so the full-episode player stays at 0:00 there.
Decisions are saved to `data/labels/<show>.json` as you go; clips are cached in `.local/breakdetect/clips/`.

### What counts as a break

Mark every point where the show itself is built to cut away: an act-out fade, the gap between two stories, the end of a cold open before the title card. Do not decide whether you'd *want* a commercial there; spacing and position preferences (no break in the first minutes, a minimum gap between breaks) are applied per channel in Tunarr. Mark dips inside title cards, credits, or fade-ins that follow a break you already marked as Not a break.

## Precision gate

`breakdetect evaluate` enables a show only when every condition holds. The constants are at the top of `breakdetect/evaluate.py`.

| Constant | Value | Meaning |
|---|---|---|
| `MIN_PRECISION` | 0.95 | Floor for both leave-one-episode-out and held-out precision |
| `MIN_POSITIVES` | 5 | Correct candidates needed above the chosen threshold |
| `MIN_GT_EPISODES` | 3 | Complete, scored ground-truth episodes for the show |
| `MIN_HELD_OUT_PREDICTIONS` | 5 | Held-out predictions (true plus false positives) at the threshold |
| `MIN_GAP_MS` | 120000 | Minimum spacing between exported breaks |

At least one held-out prediction must also be a true positive.

## Unseen-show evaluation

    uv run breakdetect loso [--cache DIR]

Scores each labelled show as if it had never been labelled. The model is trained on every other show. The threshold is chosen from the other shows only, each scored by a model that saw neither it nor the target show. The pooled row is the precision a brand-new show would get. Only shows with complete ground truth take part. The command writes nothing.

2026-11-05, 4 shows: pooled precision 0.93, recall 0.51 (29 predictions). Are You Afraid of the Dark gave 2 false cuts in 3 predictions (S02E05 at 7:34, S04E12 at 12:09), both away from the episode's usual break window.

## Extraction benchmark (Mac, 1 worker, SMB share, cold cache)

| File | Size | Codec / resolution | No hwaccel (s, s/media-min) | videotoolbox (s, s/media-min) |
|---|---|---|---|---|
| Batman TAS S01E01 (22.3 min) | 1.44 GB | h264 1440x1080 | 70.4 / 3.15 | 119.1 / 5.33 |
| Rugrats S01E01 (22.1 min) | 767 MB | h264 720x540 | 33.1 / 1.50 | 60.3 / 2.73 |
| Courage S01E01 (22.5 min) | 260 MB | h264 640x480 | 9.6 / 0.43 | 44.6 / 1.98 |

Timings are noisy (a repeat of the no-hwaccel run gave 93.9 / 32.9 / 10.0 s). Software decode was faster than videotoolbox on every file, so the Mac default is no hwaccel.
The decode is bound by file read speed on the share for the large file; the Unraid target (under 30 s per episode) is not yet measured.

## Unraid container

    docker/run-unraid.sh <cmd> [args]

Rsyncs this package to `root@192.168.1.227:/mnt/user/appdata/breakdetect/src`, builds `breakdetect:local` there (python:3.12-slim, ffmpeg, `intel-media-va-driver-non-free`, `vainfo`) and runs `<cmd>` with `--rm --device /dev/dri`, `/mnt/user/plex` mounted read-only at `/media/plex` (`BREAKDETECT_ROOTS=/media/plex`), and `/mnt/user/appdata/breakdetect/{cache,data}` mounted read-write at `/cache` and `/data` (`BREAKDETECT_CACHE=/cache/features`, `BREAKDETECT_DATA=/data`).

    docker/run-unraid.sh vainfo
    docker/run-unraid.sh breakdetect extract "/media/plex/Kids TV/Rugrats" --workers 4
    docker/run-unraid.sh pull-cache

## Workflow: extract on Unraid, everything else on the Mac

Unraid only extracts features. Labels, `train`, `evaluate` and `export` run on the Mac, against the committed `data/` directory.

1. `docker/run-unraid.sh breakdetect extract "/media/plex/<Library>/<Show>" --workers 4`
2. `docker/run-unraid.sh pull-cache` rsyncs `/mnt/user/appdata/breakdetect/cache/features/` into the Mac's cache (`<repo>/.local/breakdetect/features/`, or `BREAKDETECT_CACHE`). It never deletes Mac entries, and pulled files are mode 0644.
3. On the Mac: `review`, then `train`, `evaluate`, `export`.

Feature cache keys and label staleness compare a file's size and its mtime floored to whole seconds. The macOS SMB client truncates mtimes to 100 ns while Unraid reports full nanoseconds, so an exact comparison would never match across the two machines. Only the feature cache moves between them. The derived signal cache (`.local/breakdetect/signals/`), `data/` and the clip cache stay on the Mac. A cache file that cannot be read or is corrupt counts as a miss and is extracted again.

## Extraction benchmark (Unraid, i7-8700K, 12 threads, cold cache, 1 worker)

Same three files as the Mac benchmark. The host is shared with Plex and other containers.

| Method | Batman TAS S01E01 (22.3 min) | Rugrats S01E01 (22.1 min) | Courage S01E01 (22.5 min) |
|---|---|---|---|
| Software decode | 40.1 s / 1.80 | 25.0 s / 1.13 | 5.5 s / 0.24 |
| `--hwaccel vaapi` | 79.3 s / 3.55 | 21.0 s / 0.95 | 13.9 s / 0.62 |
| `--hwaccel qsv` | fails (ffmpeg: "Error opening output files") | fails | fails |

Each cell is seconds / seconds per media-minute. A repeat of software decode with `-skip_loop_filter all -flags2 +fast` gave 38.3 / 18.3 / 5.9 s against 41.6 / 18.2 / 5.5 s without, and a bare decode of Batman went 39 s to 34 s. That is not a material gain, so there is no fast-decode option.
Software decode is the faster method on every file except Rugrats; the 1440x1080 file misses 30 s alone because decode saturates the CPU, not because of file reads (the file reads in 7 s).

Library-scale throughput matters most: 8 uncached episodes (2 Batman TAS, 3 Rugrats double-episode files, 3 Courage; about 180 media-minutes), one `extract` run each:

| Method | Wall time | Wall s per media-minute | Wall s per 22-min episode |
|---|---|---|---|
| Software, `--workers 4` | 131 s | 0.73 | 16 |
| Software, `--workers 6` | 132 s | 0.73 | 16 |
| Software, `--workers 10` | 135 s | 0.75 | 17 |
| vaapi, `--workers 4` | 160 s | 0.89 | 20 |

The per-episode times inside a parallel run are inflated because the workers share the CPU, so use the wall numbers. Software decode with `--workers 4` is the recommended Unraid setting: it passes the 30 s gate at library scale, and more workers add nothing once the 12 threads are saturated. A single 1080p episode run alone is still about 40 s.

## Import into Tunarr

Marker files written to `data/markers/<show>.json` are imported with one request. Episodes match by path suffix and duration (within 2 s); unmatched episodes are listed in the response.

    curl -X POST -H 'Content-Type: application/json' --data @data/markers/<show>.json http://<tunarr-host>:8000/api/break-markers
