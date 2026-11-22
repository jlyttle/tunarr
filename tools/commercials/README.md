# commercials

Downloads YouTube commercial compilations, splits them into individual ads, and syncs them into Tunarr filler lists.

## Setup

```
brew install chromaprint ffmpeg
uv sync --extra dev
```

## Locations

- Media: `$COMMERCIALS_MEDIA` (default `~/Media/tunarr-commercials`)
- State (catalog.json, reports/): `$COMMERCIALS_STATE` (default `~/.local/share/tunarr-commercials`)

Neither is committed.

## Sources and downloads

`config/sources.json` lists the channels, the title patterns that map a compilation to a pool, and the default pool. `discover.py` lists recent uploads with `yt-dlp --flat-playlist -j --extractor-args youtubetab:approximate_date`; flat entries that lack `upload_date` fall back to a per-video metadata fetch. `download.py` fetches up to 1080p, removes SponsorBlock segments, and merges to MKV.

### Watermark check (2026-11-22)

Sample: `g1XxVSvCJpI` (Disney XD, 8m17s, AV1 1920x1080 + Opus), frames at 20%, 50%, 80% in `~/Media/tunarr-commercials/downloads/g1XxVSvCJpI-frame{20,50,80}.png`.

- No persistent uploader watermark or logo in any of the three frames (corners and edges are clean). Only in-ad content (a faint brand mark, a legal line, a network bumper) appeared.
- The 50% frame is end credits ("Sound Effect Editors ... ") inside a 116 s chapter, so compilations can contain non-ad material between spots. Splitting must reject it.
- yt-dlp shows 16 chapters with per-spot titles (for example "Kiff - They Got Tails commercial", "Pet Smart - Hank, the Good Boy commercial"), apart from an untitled first chapter. Chapter boundaries are not always one spot each (the credits sit inside one long chapter).
- Three frames cannot prove absence of an intermittent logo; a different channel video may differ.
