"""Detect network self-promotion (end cards, IDs, channel bugs) by perceptual hash.

References are hand-picked promo clips hashed with a 9x8 difference hash. A segment is
scored on two signals; either one at or above the threshold marks it as a promo.
"""
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HAMMING_MAX = 10
END_WINDOW_S = 1.5
END_STEP_S = 0.5
BUG_STEP_S = 2.0
MIN_INFO_BITS = 8  # a hash with fewer set bits is a flat frame and matches anything dark
BUG_CROPS = (
    "iw/4:ih/4:0:0",
    "iw/4:ih/4:iw*3/4:0",
    "iw/4:ih/4:0:ih*3/4",
    "iw/4:ih/4:iw*3/4:ih*3/4",
)


def dhash(gray9x8: np.ndarray) -> int:
    """64-bit difference hash of an 8-row by 9-column grayscale array."""
    bits = (gray9x8[:, 1:] > gray9x8[:, :-1]).flatten()
    out = 0
    for b in bits:
        out = (out << 1) | int(b)
    return out


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _informative(h: int) -> bool:
    return h.bit_count() >= MIN_INFO_BITS


@dataclass(frozen=True)
class NetworkRefs:
    network: str
    endcards: list[int]
    bugs: list[tuple[str, int]]


def promo_score(
    endcard_hashes: list[int],
    bug_hashes: list[list[int]],
    refs: list[NetworkRefs],
) -> float:
    """0..1: the larger of the end-card match share and the best corner-bug match share.

    `bug_hashes[i]` holds the sampled-frame hashes for BUG_CROPS[i].
    """
    end_score = 0.0
    cards = [c for r in refs for c in r.endcards if _informative(c)]
    if endcard_hashes and cards:
        hits = sum(1 for h in endcard_hashes if any(hamming(h, c) <= HAMMING_MAX for c in cards))
        end_score = hits / len(endcard_hashes)
    bug_score = 0.0
    for r in refs:
        for crop, ref_hash in r.bugs:
            if crop not in BUG_CROPS or not _informative(ref_hash):
                continue
            frames = bug_hashes[BUG_CROPS.index(crop)] if BUG_CROPS.index(crop) < len(bug_hashes) else []
            if frames:
                hits = sum(1 for h in frames if hamming(h, ref_hash) <= HAMMING_MAX)
                bug_score = max(bug_score, hits / len(frames))
    return max(end_score, bug_score)


def promo_verdict(score: float, promo_threshold: float = 0.5, uncertain_floor: float = 0.3) -> str | None:
    if score >= promo_threshold:
        return "network_promo"
    if score >= uncertain_floor:
        return "uncertain_promo"
    return None


def frame_hashes_args(
    path: str | Path, times: list[float], crop: str | None, offset: float = 0.0
) -> list[str]:
    """ffmpeg args emitting one 9x8 gray raw frame (72 bytes) for the first frame at or after each time.

    Times are relative to `offset` (an input -ss in seconds).
    """
    picks = "+".join(f"gte(t,{t:.3f})*(isnan(prev_pts)+lt(prev_pts*TB,{t:.3f}))" for t in times) or "0"
    vf = f"select='{picks}'"
    if crop:
        vf += f",crop={crop}"
    vf += ",scale=9:8:flags=area,format=gray"
    args = ["-hide_banner", "-v", "error"]
    if offset:
        args += ["-ss", f"{offset:.3f}"]
    # Stop shortly after the last wanted time; select alone would decode to the end of the file.
    if times:
        args += ["-t", f"{max(times) + 1.0:.3f}"]
    args += ["-i", str(path), "-vf", vf, "-fps_mode", "passthrough", "-an", "-f", "rawvideo", "-"]
    return args


def hashes_for_frames(
    path: str | Path, times: list[float], crop: str | None, offset: float = 0.0
) -> list[int]:
    proc = subprocess.run(
        ["ffmpeg", *frame_hashes_args(path, sorted(times), crop, offset)],
        capture_output=True,
        check=True,
    )
    raw = proc.stdout
    return [
        dhash(np.frombuffer(raw[i : i + 72], dtype=np.uint8).reshape(8, 9))
        for i in range(0, len(raw) - 71, 72)
    ]


def segment_hashes(path: str | Path, start: float, end: float) -> tuple[list[int], list[list[int]]]:
    """(end-card hashes from the last 1.5 s, per-corner hashes sampled every 2 s) for a segment."""
    dur = end - start
    end_times = [t for t in _frange(max(0.0, dur - END_WINDOW_S), dur - 0.05, END_STEP_S)]
    bug_times = list(_frange(0.0, dur - 0.05, BUG_STEP_S))
    ends = hashes_for_frames(path, end_times, None, offset=start)
    bugs = [hashes_for_frames(path, bug_times, crop, offset=start) for crop in BUG_CROPS]
    return ends, bugs


def _frange(lo: float, hi: float, step: float):
    t = lo
    while t <= hi:
        yield t
        t += step


def score_segment(path: str | Path, start: float, end: float, refs: list[NetworkRefs]) -> float:
    ends, bugs = segment_hashes(path, start, end)
    return promo_score(ends, bugs, refs)


def _slug(network: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", network.lower()).strip("-")


def load_refs(refs_dir: Path) -> list[NetworkRefs]:
    out = []
    for f in sorted(refs_dir.glob("*.json")):
        d = json.loads(f.read_text())
        out.append(
            NetworkRefs(
                d["network"],
                [int(h, 16) for h in d["endcards"]],
                [(c, int(h, 16)) for c, h in d["bugs"]],
            )
        )
    return out


STABLE_HAMMING = 6
STABLE_MIN_FRAMES = 3


def stable_hashes(hashes: list[int], max_dist: int = STABLE_HAMMING,
                  min_frames: int = STABLE_MIN_FRAMES) -> list[int]:
    """One informative hash per corner pattern seen (within max_dist) in at least min_frames frames.

    A real on-screen bug stays put; a corner that only shows changing picture content
    gives no reference.
    """
    out: list[int] = []
    for h in hashes:
        if not _informative(h) or any(hamming(h, o) <= max_dist for o in out):
            continue
        if sum(1 for x in hashes if hamming(h, x) <= max_dist) >= min_frames:
            out.append(h)
    return out


def _clip_duration(clip: Path) -> float:
    return float(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(clip)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    )


def add_reference(network: str, clip: Path, refs_dir: Path) -> None:
    """Hash the last 1.5 s and stable corner crops of a hand-picked promo; merge into the network's refs file."""
    ends, bugs = segment_hashes(clip, 0.0, _clip_duration(clip))
    refs_dir.mkdir(parents=True, exist_ok=True)
    path = refs_dir / f"{_slug(network)}.json"
    existing = json.loads(path.read_text()) if path.exists() else {"network": network, "endcards": [], "bugs": []}
    for h in ends:
        if _informative(h) and f"{h:016x}" not in existing["endcards"]:
            existing["endcards"].append(f"{h:016x}")
    for crop, hs in zip(BUG_CROPS, bugs):
        for h in stable_hashes(hs):
            entry = [crop, f"{h:016x}"]
            if entry not in existing["bugs"]:
                existing["bugs"].append(entry)
    path.write_text(json.dumps(existing, indent=2) + "\n")
