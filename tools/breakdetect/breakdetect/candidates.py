from dataclasses import dataclass

import numpy as np

from breakdetect.features import Features

SAMPLE_MS = 100
MIN_REGION_MS = 150
MERGE_GAP_MS = 1000
DARK_FLOOR = 0.06
DARK_MARGIN = 0.03
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
    return luma < max(DARK_FLOOR, float(np.percentile(luma, 2)) + DARK_MARGIN)


def _quiet_mask(rms_db: np.ndarray) -> np.ndarray:
    return rms_db < max(float(np.percentile(rms_db, 5)) - QUIET_MARGIN_DB, QUIET_FLOOR_DB)


def _runs(mask: np.ndarray) -> list[Span]:
    padded = np.concatenate(([False], mask, [False])).astype(np.int8)
    edges = np.flatnonzero(np.diff(padded))
    spans = [(int(s) * SAMPLE_MS, int(e) * SAMPLE_MS) for s, e in zip(edges[::2], edges[1::2])]
    return [(s, e) for s, e in spans if e - s >= MIN_REGION_MS]


def _merge(spans: list[Span]) -> list[Span]:
    merged: list[Span] = []
    for start, end in sorted(spans):
        if merged and start - merged[-1][1] <= MERGE_GAP_MS:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def _overlaps(span: Span, regions: list[Span]) -> bool:
    return any(s < span[1] and e > span[0] for s, e in regions)


def _kind(span: Span, dark: list[Span], quiet: list[Span]) -> str:
    in_dark, in_quiet = _overlaps(span, dark), _overlaps(span, quiet)
    if in_dark and in_quiet:
        return "dark+quiet"
    return "dark" if in_dark else "quiet"


def _min_over(values: np.ndarray | None, span: Span) -> float | None:
    if values is None:
        return None
    window = values[span[0] // SAMPLE_MS : span[1] // SAMPLE_MS]
    return float(window.min()) if len(window) else None


def _build(span: Span, f: Features, dark: list[Span], quiet: list[Span]) -> Candidate:
    luma_min = _min_over(f.luma, span)
    return Candidate(
        start_ms=span[0],
        end_ms=span[1],
        cut_ms=(span[0] + span[1]) // 2,
        kind=_kind(span, dark, quiet),
        min_luma=luma_min if luma_min is not None else float(f.luma.min()),
        min_rms_db=_min_over(f.audio_rms_db, span),
    )


def find_candidates(f: Features, edge_ms: int = 60_000) -> list[Candidate]:
    dark = _runs(_dark_mask(f.luma))
    quiet = _runs(_quiet_mask(f.audio_rms_db)) if f.audio_rms_db is not None else []
    candidates = [_build(span, f, dark, quiet) for span in _merge(dark + quiet)]
    return [c for c in candidates if edge_ms <= c.cut_ms <= f.duration_ms - edge_ms]
