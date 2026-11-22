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

### Single-chapter rule and promo filter

`config/networks.json` lists the networks a title can name (Nickelodeon, Nick Jr, Nicktoons, Nick at Nite, Cartoon Network, Boomerang, the Disney channels, Comedy Central, FX, FXX, Adult Swim, MTV, TBS, TNT, USA Network, Syfy, Food Network, HGTV, ESPN, the broadcast networks and others), each with a slug and case-insensitive title patterns. A compilation whose title names a network is **per-network**:

- It is processed only when `config/network_refs/<slug>.json` exists for every network it names. Otherwise it is marked `skipped` (reason `no_network_refs`, listed once in the report) and the report's `needs_network_refs` counts what is waiting per network. It is not downloaded, and it returns to `new` as soon as the references exist. Seed them with `commercials add-ref <network> <clip>`, where `<network>` is a slug or name from `networks.json` (other names are refused, so the file always lands where the gate looks).
- `require_single_chapter` rejects accepted segments whose start and end are not both within 1.5 s of the same chapter's span (`not_single_chapter`, or `no_chapters` when the video has none). Per-network compilations carry one chapter per spot, so this catches unbranded show content and merged pods that the branded-card filter (`promo_filter.py`) cannot.

Generic uploads (no network in the title, such as "2026 Commercials Vol. 239") skip both gates, except that a generic compilation mapped to `kids` still gets the single-chapter rule.

Every compilation with chapters also rejects a segment as `promo_chapter_text` when its chapter text (`chapter_text_for`: the chapter and its neighbours) contains promo, bumper, coming up, up next, next on or station id, or names any network in `networks.json`. The promo filter then scores each surviving segment against the hand-picked network references (`config/network_refs/`).

The kids title pattern in `config/sources.json` excludes titles naming Nick at Nite, Adult Swim or `[as]`, so those compilations go to `general`.

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

## Delivery (`deliver.py`)

Ads are pushed one at a time by streaming over `/usr/bin/ssh` to `root@192.168.1.227` (`cat > file.part && mv`); the remote side runs `umask 000; mkdir -p` first. Retired ads are removed with `ssh rm -f`, but only after the sync: a file is deleted once its pool's filler list was replaced (`updated`), because until then the old list may still point at it. If the sync fails, is skipped or is not configured, or a pool's list was not updated, its retired files stay on Unraid and in `Ad.delivered` and are retried on a later run (`delete_deferred` in the report). The exception is the kids copy of a kids-blocked ad, which is deleted at once: a missing file in the kids list is better than the ad airing there. Layout: `<unraid_root>/<pool>/<ad_id>.mp4`; an ad in both pools is delivered to both folders. `Ad.delivered` records pool -> remote path, and only successful transfers are recorded, so a failed push stays pending.

Path mapping (from `docker inspect plex`): the Plex container's `/data` is the host's `/mnt/user/plex`. The existing library `/data/Videos/Commercials` is therefore `/mnt/user/plex/Videos/Commercials`, and `unraid_root` in `config/sources.json` is the sibling `/mnt/user/plex/Videos/Modern Commercials` (Plex sees `/data/Videos/Modern Commercials`). The folder is not created until the first delivery.

## Running (`cli.py`, `runner.py`)

```
commercials run [--dry-run] [--no-deliver] [--no-sync] [--limit N] [--since-weeks N]
commercials add-ref <network> <clip>
commercials status
```

`run` discovers uploads from the last `--since-weeks` (default 8) weeks, records them in the catalog, and processes at most `--limit` (default 10) pending compilations, newest first (failed ones are retried after new ones). For each one it downloads `<id>.mkv` and `<id>.info.json` (an existing file is reused; chapters come from the info JSON), splits, applies the single-chapter rule (per-network and kids compilations), rejects promo chapter text, scores accepted segments with the promo filter, cuts, prechecks (probe first; `no_audio` rejects before any volume pass; ffprobe errors reject as `probe_failed`), fingerprints, applies the blocklist to the chapter titles, and encodes. A duplicate of a known ad at no better height is not re-encoded. Any exception marks that compilation `failed` in the report and the run continues. The catalog is saved after each compilation.

Every rejected segment is kept for tuning at `<media>/rejected/<reason>/<video_id>-<start>.mkv` and counted in the report; it never becomes an ad. Reasons: `nonstandard_length`, `not_single_chapter`, `no_chapters`, `promo_chapter_text`, `network_promo`, `uncertain_promo`, `probe_failed`, `no_audio`, `silent`, `no_video`, `vertical`, `cut_failed`, `fingerprint_failed`, `encode_failed`. Kept rejects older than 14 days are pruned at the start of each run (not in `--dry-run`). Encoded ads live in `<media>/ads/`; the source mkv is deleted once its compilation is split (its info JSON stays).

Chapters in the info JSON describe the video before SponsorBlock cuts. They are ignored, and the video is listed under `chapters_unreliable` in the report, when `sponsorblock_chapters` contains a removed category or the file's duration differs from the info JSON's `duration` by more than 0.5 s (1.0 s when YouTube gives whole seconds). A kids compilation then rejects as `no_chapters`; a general one splits without chapters.

Blocklist keywords match whole words and their plurals (`beer` matches "beers"). They are checked on the chapter text of every sighting, kids or general. A hit on any sighting of an ad sets `kids_blocked` in the catalog; from then on the ad is never in the kids pool, whatever later sightings say.

After processing, retention picks the active ads, delivery pushes new files (skip with `--no-deliver`), the sync replaces the filler lists, and then retired files are deleted (see Delivery). Unraid `uptime` is recorded before delivery and after sync whenever delivery or a configured sync runs; if the first check fails, delivery and sync are skipped. Sync runs only when `filler_list_ids` (both pools), `plex.section_key`, `tunarr.media_source_id` and `tunarr.library_id` are all set in `config/sources.json`; otherwise the report says `not_configured`. Sync refreshes Plex (`http://192.168.1.227:32400`) for the Modern Commercials folder only, waits 60 s, scans the Tunarr library, then replaces each pool's filler list. The list holds only programs whose file stem (or title, when Tunarr gives no path) is an ad delivered to that pool; programs Tunarr marks `missing` and ads no longer delivered (retired or kids-blocked) are left out. The scan call only queues a scan, so a pool is written only once the matched ad ids equal the delivered set; until then it retries (3 tries, 120 s apart) and reports `tunarr_behind`. The Plex token comes from `$COMMERCIALS_PLEX_TOKEN`, or is read at run time over ssh from the Plex container's `Preferences.xml` (found with `docker inspect plex`). It is held in memory only and is redacted from errors.

`--dry-run` lists what would be processed and the delivery plan, and writes nothing.

Reports go to `$COMMERCIALS_STATE/reports/<timestamp>.json` and `.md`: added and retired ads, rejections by reason, pool hours, per-compilation segment counts and promo-filter drop share, uptime, delivery and sync results, failures.

### launchd

The daily job runs from a dedicated checkout of this repo at `~/.local/share/tunarr-commercials/app`, not from a development checkout, so switching branches or editing code never changes what runs at 04:00. Code and config both come from that checkout: the config folder is `$COMMERCIALS_CONFIG` when set, else the `config/` folder next to the package that runs. Make config changes (`add-ref`, filler list ids) in the app checkout, or point `COMMERCIALS_CONFIG` at one folder for both.

Install once (as a git worktree of your clone, on the branch that should run):

```
git worktree add ~/.local/share/tunarr-commercials/app feature/modern-commercials
cd ~/.local/share/tunarr-commercials/app/tools/commercials && uv sync
cp launchd/com.tunarr.commercials.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tunarr.commercials.plist
```

To update the job, pull or check out the new commit in the app checkout. `launchd/com.tunarr.commercials.plist` runs `launchd/run-daily.sh` daily at 04:00 (nice 10, low-priority IO), logging to `~/Library/Logs/tunarr-commercials.log`. The wrapper runs `uv sync --upgrade-package yt-dlp` first (YouTube breaks old yt-dlp versions; a failed update posts a notification and the run goes ahead with the installed version), then `commercials run`. It needs the ssh key for `root@192.168.1.227` usable without a prompt, and `uv` on the plist's `PATH` (`~/.local/bin` or `/opt/homebrew/bin`).

### Staying visible

The report's `under_floor` lists pools below the 3 h floor with their hours. After a real run (not `--dry-run`), `commercials run` posts a macOS notification (`osascript`) when there is any failure, a pool is under the floor, or a pool's filler list was not updated (for example `tunarr_behind`). The text has counts and pool names only, never failure messages, so no host, URL or token reaches the notification.
