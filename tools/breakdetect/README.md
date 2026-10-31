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

## Extraction benchmark (Mac, 1 worker, SMB share, cold cache)

| File | Size | Codec / resolution | No hwaccel (s, s/media-min) | videotoolbox (s, s/media-min) |
|---|---|---|---|---|
| Batman TAS S01E01 (22.3 min) | 1.44 GB | h264 1440x1080 | 70.4 / 3.15 | 119.1 / 5.33 |
| Rugrats S01E01 (22.1 min) | 767 MB | h264 720x540 | 33.1 / 1.50 | 60.3 / 2.73 |
| Courage S01E01 (22.5 min) | 260 MB | h264 640x480 | 9.6 / 0.43 | 44.6 / 1.98 |

Timings are noisy (a repeat of the no-hwaccel run gave 93.9 / 32.9 / 10.0 s). Software decode was faster than videotoolbox on every file, so the Mac default is no hwaccel.
The decode is bound by file read speed on the share for the large file; the Unraid target (under 30 s per episode) is not yet measured.
