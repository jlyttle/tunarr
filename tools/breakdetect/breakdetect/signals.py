import numpy as np

from breakdetect.candidates import SAMPLE_MS, Candidate, aligned, dark_threshold, quiet_threshold
from breakdetect.features import Features
from breakdetect.series import SeriesContext, bumper_match, offset_support

SIGNALS_VERSION = "2"

SIGNAL_NAMES = [
    "dark_depth",
    "dark_ms",
    "quiet_depth_db",
    "quiet_ms",
    "audio_missing",
    "fade_out_slope",
    "fade_in_slope",
    "scene_change",
    "context_loudness_db",
    "rel_pos",
    "near_chapter",
    "series_offset_support",
    "bumper_match",
]

SLOPE_SAMPLES = 15
SCENE_OFFSET_MS = 2000
CONTEXT_MS = 10_000
CHAPTER_TOLERANCE_MS = 2000


def _span(c: Candidate) -> slice:
    return slice(c.start_ms // SAMPLE_MS, c.end_ms // SAMPLE_MS)


def _slope_per_second(window: np.ndarray) -> float:
    seconds = np.arange(len(window)) * SAMPLE_MS / 1000.0
    return float(np.polyfit(seconds, window, 1)[0])


def _slope_over(luma: np.ndarray, first: int) -> float:
    if first < 0 or first + SLOPE_SAMPLES > len(luma):
        return 0.0
    return _slope_per_second(luma[first : first + SLOPE_SAMPLES].astype(np.float64))


def _scene_change(thumbs: np.ndarray, c: Candidate) -> float:
    last = len(thumbs) - 1
    before = min(max((c.start_ms - SCENE_OFFSET_MS) // SAMPLE_MS, 0), last)
    after = min(max((c.end_ms + SCENE_OFFSET_MS) // SAMPLE_MS, 0), last)
    return float(np.abs(thumbs[before].astype(np.float32) - thumbs[after].astype(np.float32)).mean() / 255.0)


def _context_loudness_db(rms_db: np.ndarray, c: Candidate) -> float:
    span = _span(c)
    lo = max((c.start_ms - CONTEXT_MS) // SAMPLE_MS, 0)
    hi = (c.end_ms + CONTEXT_MS) // SAMPLE_MS
    around = np.concatenate((rms_db[lo : span.start], rms_db[span.stop : hi]))
    return float(np.median(around)) if len(around) else 0.0


def _audio_signals(rms_db: np.ndarray | None, c: Candidate) -> tuple[float, float, float, float]:
    if rms_db is None or c.min_rms_db is None:
        return 0.0, 0.0, 0.0, 1.0
    context = _context_loudness_db(rms_db, c)
    quiet_samples = int((rms_db[_span(c)] < quiet_threshold(rms_db)).sum())
    return context - c.min_rms_db, quiet_samples * SAMPLE_MS, context, 0.0


def _near_chapter(f: Features, c: Candidate) -> float:
    return 1.0 if any(abs(ch - c.cut_ms) <= CHAPTER_TOLERANCE_MS for ch in f.chapters_ms) else 0.0


def _series_signals(series: SeriesContext | None, rel: str | None, c: Candidate) -> tuple[float, float]:
    if series is None:
        return 0.0, 0.0
    if rel is None:
        raise ValueError("rel is required when series is given")
    return offset_support(series, rel, c), bumper_match(series, rel, c)


def candidate_signals(c: Candidate, f: Features, series: SeriesContext | None = None, rel: str | None = None) -> np.ndarray:
    luma, rms_db = aligned(f)
    dark_samples = int((luma[_span(c)] < dark_threshold(luma)).sum())
    quiet_depth, quiet_ms, context_db, audio_missing = _audio_signals(rms_db, c)
    offset_support_value, bumper_match_value = _series_signals(series, rel, c)
    return np.array(
        [
            float(np.median(luma)) - c.min_luma,
            dark_samples * SAMPLE_MS,
            quiet_depth,
            quiet_ms,
            audio_missing,
            _slope_over(luma, c.start_ms // SAMPLE_MS - SLOPE_SAMPLES),
            _slope_over(luma, c.end_ms // SAMPLE_MS),
            _scene_change(f.thumbs, c),
            context_db,
            c.cut_ms / f.duration_ms,
            _near_chapter(f, c),
            offset_support_value,
            bumper_match_value,
        ],
        dtype=np.float64,
    )
