import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

SILENT_DB = -60.0
VIDEO_FILTER = (
    "scale=trunc(iw*sar/2)*2:ih,"
    "scale=1280:720:force_original_aspect_ratio=decrease,"
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1"
)
LOUDNORM = "loudnorm=I=-24:TP=-2:LRA=11"

_MEAN = re.compile(r"mean_volume:\s*(-?[\d.]+|-inf)\s*dB")


@dataclass(frozen=True)
class StreamInfo:
    has_audio: bool
    width: int
    height: int


def probe_streams(path: str | Path) -> StreamInfo:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    streams = json.loads(res.stdout).get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    return StreamInfo(
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        width=int(video["width"]) if video else 0,
        height=int(video["height"]) if video else 0,
    )


def volumedetect_args(path: str | Path) -> list[str]:
    return ["-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "volumedetect", "-f", "null", "-"]


def parse_mean_volume(stderr: str) -> float:
    """Mean volume in dB from volumedetect; -inf (or no reading) counts as silence."""
    m = _MEAN.search(stderr)
    if m is None or m.group(1) == "-inf":
        return float("-inf")
    return float(m.group(1))


def loudnorm_measure_args(path: str | Path) -> list[str]:
    return [
        "-hide_banner", "-nostats", "-i", str(path), "-vn",
        "-af", f"{LOUDNORM}:print_format=json", "-f", "null", "-",
    ]


def parse_loudnorm(stderr: str) -> dict:
    start = stderr.rfind("{")
    end = stderr.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no loudnorm JSON in ffmpeg output")
    return json.loads(stderr[start : end + 1])


def encode_args(src: str | Path, dest: str | Path, measured: dict) -> list[str]:
    ln = (
        f"{LOUDNORM}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )
    return [
        "-hide_banner", "-v", "error", "-y", "-i", str(src),
        "-vf", VIDEO_FILTER, "-af", ln,
        "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", str(dest),
    ]


def precheck(info: StreamInfo, mean_volume_db: float) -> str | None:
    if not info.has_audio:
        return "no_audio"
    if mean_volume_db < SILENT_DB:
        return "silent"
    if info.width == 0 or info.height == 0:
        return "no_video"
    if info.width < info.height:
        return "vertical"
    return None
