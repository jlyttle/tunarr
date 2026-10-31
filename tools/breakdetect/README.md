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
Decisions are saved to `data/labels/<show>.json` as you go; clips are cached in `.local/breakdetect/clips/`.

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

Rsyncs this package to `root@192.168.1.227:/mnt/user/appdata/breakdetect/src`, builds `breakdetect:local` there (python:3.12-slim, ffmpeg, `intel-media-va-driver-non-free`, `vainfo`) and runs `<cmd>` with `--rm --device /dev/dri`, `/mnt/user/plex` mounted read-only at `/media/plex` (`BREAKDETECT_ROOTS=/media/plex`), and `/mnt/user/appdata/breakdetect/{cache,data}` mounted read-write at `/cache` and `/data` (`BREAKDETECT_CACHE=/cache/features`, `BREAKDETECT_DATA=/data`). Relative paths are identical to the Mac's (`Kids TV/...`), so cache keys and labels carry across.

    docker/run-unraid.sh vainfo
    docker/run-unraid.sh breakdetect extract "/media/plex/Kids TV/Rugrats" --workers 4

`data/` is not synced by the script; copy labels and the model to `/mnt/user/appdata/breakdetect/data` yourself.

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
