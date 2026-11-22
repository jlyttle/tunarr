import re
from dataclasses import dataclass, replace
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


Gap = tuple[float, float]
CHAPTER_WINDOW_S = 0.5


def parse_chapters(info_json: dict) -> list[float]:
    """Chapter start times from a yt-dlp info dict, excluding the start of the video."""
    starts = [float(c["start_time"]) for c in info_json.get("chapters") or []]
    return sorted(s for s in starts if s > 0)


def boundaries(
    black: list[tuple[float, float]],
    silence: list[tuple[float, float]],
    duration_s: float,
    min_overlap_s: float = 0.02,
    chapters: list[float] | None = None,
) -> list[Gap]:
    """Gap intervals (start, end) between spots, bracketed by (0, 0) and (duration, duration).

    A gap is a black-and-silent overlap, or, for a chapter time, the nearest black or
    silent interval within CHAPTER_WINDOW_S of it (chapters with none nearby are ignored).
    """
    gaps: list[Gap] = []
    for b0, b1 in black:
        for s0, s1 in silence:
            lo, hi = max(b0, s0), min(b1, s1)
            if hi - lo >= min_overlap_s:
                gaps.append((lo, hi))
    for c in chapters or []:
        if any(g0 - CHAPTER_WINDOW_S <= c <= g1 + CHAPTER_WINDOW_S for g0, g1 in gaps):
            continue
        near = [
            (lo, hi)
            for lo, hi in (*black, *silence)
            if hi >= c - CHAPTER_WINDOW_S and lo <= c + CHAPTER_WINDOW_S
        ]
        if near:
            gaps.append(min(near, key=lambda g: 0.0 if g[0] <= c <= g[1] else min(abs(g[0] - c), abs(g[1] - c))))
    inner = sorted(g for g in gaps if g[1] > EDGE_S and g[0] < duration_s - EDGE_S)
    return [(0.0, 0.0), *inner, (duration_s, duration_s)]


def snap_length(d: float) -> int | None:
    best = min(SPOT_LENGTHS, key=lambda s: abs(s - d))
    return best if abs(best - d) <= TOLERANCE_S else None


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    spot_s: int | None
    reject_reason: str | None


def segments(gaps: list[Gap]) -> list[Segment]:
    """Each segment runs from one gap's end to the next gap's start."""
    out = []
    for (_, start), (end, _) in zip(gaps, gaps[1:]):
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


def require_single_chapter(
    segs: list[Segment], chapter_starts: list[float], duration_s: float, tol_s: float = 1.5
) -> list[Segment]:
    """Reject accepted segments that do not coincide with exactly one chapter.

    Per-network compilations carry one chapter per spot, so a segment that spans or sits
    inside a chapter is unbranded show content or a merge. `chapter_starts` is expected
    to include 0 as the first start.
    """
    starts = sorted(chapter_starts)
    spans = list(zip(starts, [*starts[1:], duration_s]))
    out = []
    for seg in segs:
        if seg.reject_reason is not None:
            out.append(seg)
        elif not spans:
            out.append(replace(seg, reject_reason="no_chapters"))
        elif any(abs(seg.start - c0) <= tol_s and abs(seg.end - c1) <= tol_s for c0, c1 in spans):
            out.append(seg)
        else:
            out.append(replace(seg, reject_reason="not_single_chapter"))
    return out
