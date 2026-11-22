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
