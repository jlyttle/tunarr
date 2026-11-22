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

## Splitting (`split.py`)

One ffmpeg pass (`detect_args`) runs `blackdetect=d=0.03:pix_th=0.10` and `silencedetect=n=-50dB:d=0.03`. A cut point is the midpoint of a black interval that overlaps a silence interval by at least 0.02 s; black alone or silence alone is never a boundary. A segment whose length is not within 0.5 s of 5, 6, 10, 15, 20, 30, 45, 60, 90 or 120 s is rejected as `nonstandard_length`. Cuts re-encode (`cut_args`) to an intermediate MKV (x264 crf 16, PCM audio).

### Tuning (2026-11-22)

Thresholds: black `d=0.03:pix_th=0.10`, silence `n=-50dB:d=0.03`, minimum black/silence overlap 0.02 s (the brief's 0.04 s can never fire on a one-frame cut: 0.033 s at 30 fps).

Boundaries are gap intervals, not midpoints. A segment runs from one gap's end to the next gap's start, so a 0.8 s black gap no longer inflates a 30 s spot. A gap is a black-and-silent overlap, or, when `chapters` is given (`parse_chapters` of the yt-dlp info JSON), the nearest black or silent interval within 0.5 s of a chapter time. Chapters with nothing nearby are ignored.

Chapters come from `yt-dlp --dump-json` (the MKV has none embedded). Agreement counts a segment whose both ends lie within 1.5 s of a chapter boundary (chapter times are whole seconds, so exact matches are rare); "exactly one chapter" excludes segments that span an interior chapter boundary (a merged pod).

| Compilation | Chapters used | Segments | Accepted | Rejected | Rejection rate | Both ends on chapter boundary | Exactly one chapter | Merged pods |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `g1XxVSvCJpI` Disney XD, 497 s, 16 chapters | no | 13 | 9 | 4 | 31% | 5 | 3 | 2 |
| `g1XxVSvCJpI` | yes | 16 | 11 | 5 | 31% | 6 | 5 | 1 |
| `casEKKNFTrM` Comedy Central, 317 s, 14 chapters | no | 7 | 5 | 2 | 29% | 4 | 1 | 3 |
| `casEKKNFTrM` | yes | 14 | 12 | 2 | 14% | 11 | 10 | 1 |

Findings:

- The 116 s credits chapter in the Disney XD video is rejected (it is part of a 94.8 s nonstandard segment).
- Gap edges measure spots to within 0.1 s (a 30 s spot behind a 1 s black gap now reads 30.00 s, where midpoints read 30.7 s and rejected it).
- Merged pods left: Disney XD 117 s to 147 s (15+15 accepted as 30); Comedy Central 248 s to 293 s (45 s, probably 15+30). Both chapter times (131 s, 262 s) were about 1 s from the nearest gap, outside the 0.5 s window; chapter times appear to be rounded from the uploader's description timestamps.
- Without chapters, spots that lack either a black frame or silence still merge, and merges that sum to a standard length are accepted. Chapters fix this only where the chapter time is within 0.5 s of some black or silent interval.
