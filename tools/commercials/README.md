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

Thresholds: black `d=0.03:pix_th=0.10`, silence `n=-50dB:d=0.03` (unchanged from the starting values). The only change is the minimum black/silence overlap, 0.04 s to 0.02 s. Real cuts are often a single black frame (0.033 s at 30 fps) over a 0.03 s silence, so a 0.04 s minimum can never fire (Disney XD: 1 of 8 segments accepted at 0.04, 7 of 13 at 0.02; 0.01 gave the same result as 0.02).

Chapters come from `yt-dlp --dump-json` (the MKV has none embedded) and were used only to evaluate, not to split. Chapter times are rounded to whole seconds, so a boundary counts as matching within 1.5 s.

| Compilation | Segments | Accepted | Rejected | Rejection rate | Accepted with both ends on a chapter boundary |
| --- | --- | --- | --- | --- | --- |
| `g1XxVSvCJpI` Disney XD, 497 s, 16 chapters | 13 | 7 | 6 | 46% | 5 (3 are exactly one chapter; 2 span two chapters) |
| `casEKKNFTrM` Comedy Central, 317 s, 14 chapters | 7 | 5 | 2 | 29% | 4 (1 is exactly one chapter; 3 span two or more) |

Findings:

- The 116 s credits chapter in the Disney XD video falls in the rejected 154 s segment (318.6 s to 473.1 s), as required.
- Recall is the weak point. Several real cuts have no black frame (Comedy Central at 83, 143, 248 s: silence only) or no silence (173 s: black only), so adjacent spots merge. A merge is accepted when the sum is a standard length (30+15+15 = 60 s, 30+30 = 60 s, and a 90 s run). The output is then a short pod, not a single spot. Merges with other sums are rejected, which is the safe direction. Requiring both signals is kept per the design ("when unsure, reject"); a later stage (fingerprint dedupe or a max-length-per-pool rule) can cull pods.
- A long black gap (more than about 0.5 s) puts the midpoint up to half the gap away from the true cut, so a real 30 s spot can measure 30.7 s and be rejected (Disney XD 227.3 s to 258.0 s).
- A leading intro or trailing bumper shows up as a short rejected segment.
