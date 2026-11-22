import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from commercials.catalog import Catalog, Compilation


@dataclass
class Sources:
    channels: list[str]
    patterns: list[tuple[re.Pattern, str]]
    default_pool: str


def load_sources(path: Path) -> Sources:
    raw = json.loads(Path(path).read_text())
    return Sources(
        channels=list(raw["channels"]),
        patterns=[(re.compile(p), pool) for p, pool in raw["patterns"]],
        default_pool=raw["default_pool"],
    )


def pools_for_title(title: str, s: Sources) -> set[str]:
    pools = {pool for pattern, pool in s.patterns if pattern.search(title)}
    return pools or {s.default_pool}


def _parse_date(raw: str) -> date:
    return datetime.strptime(raw, "%Y%m%d").date()


def parse_flat_playlist(jsonl: str) -> list[tuple[str, str, date | None]]:
    """Parse `yt-dlp --flat-playlist -j` output. upload_date is None when the flat entry lacks it."""
    out = []
    for line in jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        raw = d.get("upload_date")
        out.append((d["id"], d["title"], _parse_date(raw) if raw else None))
    return out


def new_compilations(
    entries: list[tuple[str, str, date]], catalog: Catalog, since: date, sources: Sources
) -> list[Compilation]:
    return [
        Compilation(vid, title, uploaded, pools_for_title(title, sources), "new")
        for vid, title, uploaded in entries
        if vid not in catalog.compilations and uploaded >= since
    ]


def _ytdlp(*args: str) -> str:
    return subprocess.run(
        [sys.executable, "-m", "yt_dlp", *args], check=True, capture_output=True, text=True
    ).stdout


def fetch_upload_date(video_id: str) -> date | None:
    """Fallback for flat entries without upload_date: cheap per-video metadata fetch."""
    out = _ytdlp("--skip-download", "--print", "%(upload_date)s", f"https://www.youtube.com/watch?v={video_id}").strip()
    return _parse_date(out) if re.fullmatch(r"\d{8}", out) else None


def discover(sources: Sources, catalog: Catalog, since: date, limit: int = 50) -> list[Compilation]:
    """List recent uploads on each channel and return compilations not yet in the catalog."""
    entries: list[tuple[str, str, date]] = []
    for channel in sources.channels:
        out = _ytdlp(
            "--flat-playlist", "-j", "--playlist-end", str(limit),
            "--extractor-args", "youtubetab:approximate_date", channel,
        )
        for vid, title, uploaded in parse_flat_playlist(out):
            if vid in catalog.compilations:
                continue
            if uploaded is None:
                uploaded = fetch_upload_date(vid)
            if uploaded is not None:
                entries.append((vid, title, uploaded))
    return new_compilations(entries, catalog, since, sources)
