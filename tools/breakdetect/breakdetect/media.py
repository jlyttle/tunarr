import json
import subprocess
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
