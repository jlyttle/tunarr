from dataclasses import dataclass

import numpy as np

from breakdetect.features import Features

SAMPLE_MS = 100
MIN_REGION_MS = 150
MERGE_GAP_MS = 1000
MAX_SPAN_MS = 5000
DARK_FLOOR = 0.06
DARK_MARGIN = 0.03
DARK_CEILING = 0.15
QUIET_FLOOR_DB = -50.0
QUIET_MARGIN_DB = 3.0

Span = tuple[int, int]


@dataclass
class Candidate:
    start_ms: int
    end_ms: int
    cut_ms: int
    kind: str
    min_luma: float
    min_rms_db: float | None


def _dark_mask(luma: np.ndarray) -> np.ndarray:
    return luma < min(max(DARK_FLOOR, float(np.percentile(luma, 2)) + DARK_MARGIN), DARK_CEILING)


def _quiet_mask(rms_db: np.ndarray) -> np.ndarray:
    return rms_db < max(float(np.percentile(rms_db, 5)) - QUIET_MARGIN_DB, QUIET_FLOOR_DB)


def _runs(mask: np.ndarray) -> list[Span]:
    padded = np.concatenate(([False], mask, [False])).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    spans = [(int(s) * SAMPLE_MS, int(e) * SAMPLE_MS) for s, e in zip(edges[::2], edges[1::2])]
    return [(s, e) for s, e in spans if MIN_REGION_MS <= e - s <= MAX_SPAN_MS]


def _merge(spans: list[Span], max_gap_ms: int) -> list[Span]:
    merged: list[Span] = []
    for start, end in sorted(spans):
        if merged and start - merged[-1][1] <= max_gap_ms:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def _merge_bounded(spans: list[Span]) -> list[Span]:
    result: list[Span] = []
    for chain in _merge(spans, MERGE_GAP_MS):
        if chain[1] - chain[0] <= MAX_SPAN_MS:
            result.append(chain)
            continue
        members = [s for s in spans if s[0] >= chain[0] and s[1] <= chain[1]]
        result.extend(_merge(members, 0))
    return sorted(result)


def _overlaps(span: Span, regions: list[Span]) -> bool:
    return any(s < span[1] and e > span[0] for s, e in regions)


def _kind(span: Span, dark: list[Span], quiet: list[Span]) -> str:
    in_dark, in_quiet = _overlaps(span, dark), _overlaps(span, quiet)
    if in_dark and in_quiet:
        return "dark+quiet"
    return "dark" if in_dark else "quiet"


def _min_over(values: np.ndarray, span: Span) -> float:
    window = values[span[0] // SAMPLE_MS : span[1] // SAMPLE_MS]
    if len(window) == 0:
        raise ValueError(f"empty window for span {span}")
    return float(window.min())


def _build(span: Span, luma: np.ndarray, rms_db: np.ndarray | None, dark: list[Span], quiet: list[Span]) -> Candidate:
    return Candidate(
        start_ms=span[0],
        end_ms=span[1],
        cut_ms=(span[0] + span[1]) // 2,
        kind=_kind(span, dark, quiet),
        min_luma=_min_over(luma, span),
        min_rms_db=_min_over(rms_db, span) if rms_db is not None else None,
    )


def _aligned(f: Features) -> tuple[np.ndarray, np.ndarray | None]:
    if f.audio_rms_db is None:
        return f.luma, None
    n = min(len(f.luma), len(f.audio_rms_db))
    return f.luma[:n], f.audio_rms_db[:n]


def find_candidates(f: Features, edge_ms: int = 60_000) -> list[Candidate]:
    luma, rms_db = _aligned(f)
    if len(luma) == 0:
        return []
    dark = _runs(_dark_mask(luma))
    quiet = _runs(_quiet_mask(rms_db)) if rms_db is not None else []
    candidates = [_build(span, luma, rms_db, dark, quiet) for span in _merge_bounded(dark + quiet)]
    return [c for c in candidates if edge_ms <= c.cut_ms <= f.duration_ms - edge_ms]
