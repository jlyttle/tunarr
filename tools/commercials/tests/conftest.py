import hashlib
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

Seg = tuple[str, float]

SIZE = "640x360"
RATE = 30
AUDIO_RATE = 48000
SINE = f"aevalsrc=0.1*sin(2*PI*440*t):s={AUDIO_RATE}:c=stereo"
SILENCE = f"anullsrc=r={AUDIO_RATE}:cl=stereo"
VIDEO = {
    "bars": f"smptebars=s={SIZE}:r={RATE}",
    "content": f"testsrc2=s={SIZE}:r={RATE}",
    "black": f"color=c=black:s={SIZE}:r={RATE}",
}


def _render_segment(kind: str, duration: float, out: Path) -> None:
    audio = SILENCE if kind == "black" else SINE
    args = ["ffmpeg", "-v", "error", "-y"]
    args += ["-t", str(duration), "-f", "lavfi", "-i", VIDEO[kind]]
    args += ["-t", str(duration), "-f", "lavfi", "-i", audio]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-g", "30"]
    args += ["-c:a", "aac", "-b:a", "96k", str(out)]
    subprocess.run(args, check=True)


@pytest.fixture(scope="session")
def make_clip(tmp_path_factory: pytest.TempPathFactory) -> Callable[[list[Seg]], Path]:
    root = tmp_path_factory.mktemp("clips")

    def build(segments: list[Seg]) -> Path:
        key = hashlib.sha1(repr(segments).encode()).hexdigest()[:16]
        out = root / f"{key}.mkv"
        if out.exists():
            return out
        parts = []
        for i, (kind, duration) in enumerate(segments):
            part = root / f"{key}-{i}.mkv"
            _render_segment(kind, duration, part)
            parts.append(part)
        listing = root / f"{key}.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(out)],
            check=True,
        )
        return out

    return build
