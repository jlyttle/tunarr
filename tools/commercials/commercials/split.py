import re
from dataclasses import dataclass
from pathlib import Path

SPOT_LENGTHS = (5, 6, 10, 15, 20, 30, 45, 60, 90, 120)
TOLERANCE_S = 0.5
EDGE_S = 0.5

_BLACK = re.compile(r"black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)")
_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def parse_blackdetect(stderr: str) -> list[tuple[float, float]]:
    return [(float(a), float(b)) for a, b in _BLACK.findall(stderr)]


def parse_silencedetect(stderr: str) -> list[tuple[float, float]]:
    """Pairs each silence_start with the following silence_end; an unterminated start is dropped."""
    out: list[tuple[float, float]] = []
    start: float | None = None
    for line in stderr.splitlines():
        if (m := _SILENCE_START.search(line)) is not None:
            start = float(m.group(1))
        elif (m := _SILENCE_END.search(line)) is not None and start is not None:
            out.append((start, float(m.group(1))))
            start = None
    return out


def boundaries(
    black: list[tuple[float, float]],
    silence: list[tuple[float, float]],
    duration_s: float,
    min_overlap_s: float = 0.02,
) -> list[float]:
    """Midpoints of black-and-silent overlaps, bracketed by 0 and the duration."""
    mids: list[float] = []
    for b0, b1 in black:
        for s0, s1 in silence:
            lo, hi = max(b0, s0), min(b1, s1)
            if hi - lo >= min_overlap_s:
                mids.append((lo + hi) / 2)
    inner = sorted(m for m in mids if EDGE_S < m < duration_s - EDGE_S)
    return [0.0, *inner, duration_s]


def snap_length(d: float) -> int | None:
    best = min(SPOT_LENGTHS, key=lambda s: abs(s - d))
    return best if abs(best - d) <= TOLERANCE_S else None


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    spot_s: int | None
    reject_reason: str | None


def segments(bounds: list[float]) -> list[Segment]:
    out = []
    for start, end in zip(bounds, bounds[1:]):
        spot = snap_length(end - start)
        out.append(Segment(start, end, spot, None if spot is not None else "nonstandard_length"))
    return out


def detect_args(path: str | Path) -> list[str]:
    return [
        "-hide_banner", "-nostats", "-i", str(path),
        "-vf", "blackdetect=d=0.03:pix_th=0.10",
        "-af", "silencedetect=n=-50dB:d=0.03",
        "-f", "null", "-",
    ]


def cut_args(src: str | Path, seg: Segment, dest: str | Path) -> list[str]:
    return [
        "-hide_banner", "-v", "error", "-y",
        "-ss", f"{seg.start:.3f}", "-i", str(src), "-t", f"{seg.end - seg.start:.3f}",
        "-c:v", "libx264", "-crf", "16", "-c:a", "pcm_s16le",
        str(dest),
    ]
