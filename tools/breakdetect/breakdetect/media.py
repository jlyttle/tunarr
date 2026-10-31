import json
import os
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Probe:
    duration_ms: int
    has_audio: bool
    audio_channels: int
    chapters_ms: list[int]
    video_codec: str


def _first_stream(streams: list[dict], codec_type: str) -> dict | None:
    return next((s for s in streams if s.get("codec_type") == codec_type), None)


def _chapter_starts_ms(chapters: list[dict]) -> list[int]:
    starts = (round(float(c["start_time"]) * 1000) for c in chapters)
    return sorted(s for s in starts if s > 0)


def probe(path: Path) -> Probe:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    info = json.loads(out)
    video = _first_stream(info["streams"], "video")
    audio = _first_stream(info["streams"], "audio")
    return Probe(
        duration_ms=round(float(info["format"]["duration"]) * 1000),
        has_audio=audio is not None,
        audio_channels=int(audio["channels"]) if audio else 0,
        chapters_ms=_chapter_starts_ms(info.get("chapters", [])),
        video_codec=video["codec_name"] if video else "",
    )


DEFAULT_ROOT = "/Volumes/plex"
VIDEO_EXTENSIONS = {".mkv", ".mp4", ".avi", ".m4v", ".mpg", ".ts"}
SKIPPED_DIRS = {
    "featurettes", "behind the scenes", "deleted scenes", "interviews", "scenes",
    "shorts", "trailers", "other", "extras", "specials",
}


def default_roots() -> list[Path]:
    configured = os.environ.get("BREAKDETECT_ROOTS")
    if not configured:
        return [Path(DEFAULT_ROOT)]
    return [Path(r) for r in configured.split(os.pathsep) if r]


def relative_path(path: Path, roots: list[Path]) -> str:
    absolute = Path(os.path.abspath(path))
    for root in roots:
        try:
            return unicodedata.normalize("NFC", absolute.relative_to(Path(os.path.abspath(root))).as_posix())
        except ValueError:
            continue
    raise ValueError(f"{path} is not under any root: {[str(r) for r in roots]}")


def file_identity(path: Path) -> str:
    st = path.stat()
    return f"{st.st_size}:{st.st_mtime_ns}"


def identity_key(identity: str) -> str:
    size, _, mtime_ns = identity.partition(":")
    return f"{size}:{int(mtime_ns) // 1_000_000_000}"


def discover_episodes(show_dir: Path) -> list[Path]:
    found = []
    for dirpath, dirnames, filenames in os.walk(show_dir):
        dirnames[:] = sorted(d for d in dirnames if d.lower() not in SKIPPED_DIRS)
        found += [Path(dirpath) / f for f in sorted(filenames) if Path(f).suffix.lower() in VIDEO_EXTENSIONS and not f.startswith(".")]
    return found
