import hashlib
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

Seg = tuple[str, float]

SIZE = "640x360"
FPS = "30000/1001"
AUDIO_RATE = 48000
SINE = f"aevalsrc=0.1*sin(2*PI*440*t):s={AUDIO_RATE}:c=stereo"
SILENCE = f"anullsrc=r={AUDIO_RATE}:cl=stereo"
TESTSRC = f"testsrc2=s={SIZE}:r={FPS}"
BLACK = f"color=c=black:s={SIZE}:r={FPS}"
DARK = "lutyuv=y=val*0.24"


def _video_source(kind: str, duration: float) -> tuple[str, str | None]:
    if kind in ("content", "noaudio"):
        return TESTSRC, None
    if kind == "black":
        return BLACK, None
    if kind == "fadeout":
        return TESTSRC, f"fade=t=out:st=0:d={duration}"
    if kind == "fadein":
        return TESTSRC, f"fade=t=in:st=0:d={duration}"
    if kind == "darkscene":
        return TESTSRC, DARK
    raise ValueError(f"unknown segment kind: {kind}")


def _audio_source(kind: str, duration: float) -> tuple[str, str | None]:
    if kind == "black":
        return SILENCE, None
    if kind == "fadeout":
        return SINE, f"afade=t=out:st=0:d={duration}"
    if kind == "fadein":
        return SINE, f"afade=t=in:st=0:d={duration}"
    return SINE, None



def _render_segment(kind: str, duration: float, with_audio: bool, out: Path) -> None:
    video, vfilter = _video_source(kind, duration)
    args = ["ffmpeg", "-v", "error", "-y", "-t", str(duration)]
    args += ["-f", "lavfi", "-i", video if vfilter is None else f"{video},{vfilter}"]
    if with_audio:
        audio, afilter = _audio_source(kind, duration)
        args += ["-t", str(duration), "-f", "lavfi", "-i", audio if afilter is None else f"{audio},{afilter}"]
        args += ["-c:a", "aac", "-b:a", "96k"]
    else:
        args += ["-an"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-g", "30", str(out)]
    subprocess.run(args, check=True)


def _write_chapters(chapters_ms: list[int], total_ms: int, out: Path) -> Path:
    starts = [0, *chapters_ms]
    ends = [*chapters_ms, total_ms]
    lines = [";FFMETADATA1"]
    for start, end in zip(starts, ends):
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}"]
    meta = out.with_suffix(".ffmeta")
    meta.write_text("\n".join(lines) + "\n")
    return meta


def _concat(parts: list[Path], out: Path, chapters_meta: Path | None = None) -> None:
    listing = out.with_suffix(".txt")
    listing.write_text("".join(f"file '{p}'\n" for p in parts))
    args = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing)]
    if chapters_meta is not None:
        args += ["-i", str(chapters_meta), "-map", "0", "-map_chapters", "1"]
    subprocess.run([*args, "-c", "copy", str(out)], check=True)


@pytest.fixture(scope="session")
def make_clip(tmp_path_factory: pytest.TempPathFactory) -> Callable[..., Path]:
    root = tmp_path_factory.mktemp("clips")

    def build(segments: list[Seg], chapters_ms: list[int] | None = None) -> Path:
        key = hashlib.sha1(repr((segments, chapters_ms)).encode()).hexdigest()[:16]
        out = root / f"{key}.mkv"
        if out.exists():
            return out
        with_audio = all(kind != "noaudio" for kind, _ in segments)
        parts = []
        for i, (kind, duration) in enumerate(segments):
            part = root / f"{key}-{i}.mkv"
            _render_segment(kind, duration, with_audio, part)
            parts.append(part)
        meta = None
        if chapters_ms:
            total_ms = round(sum(duration for _, duration in segments) * 1000)
            meta = _write_chapters(chapters_ms, total_ms, out)
        _concat(parts, out, meta)
        return out

    return build
