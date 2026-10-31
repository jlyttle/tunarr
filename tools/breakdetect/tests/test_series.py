import numpy as np
import pytest

from breakdetect.candidates import Candidate
from breakdetect.features import Features
from breakdetect.series import (
    SeriesContext,
    _best_similarity,
    _similarity,
    bumper_match,
    build_series_context,
    offset_support,
    season_of,
)
from breakdetect.signals import SIGNAL_NAMES, candidate_signals

DURATION_MS = 1_320_000
FRAMES = DURATION_MS // 100


def _candidate(cut_ms: int) -> Candidate:
    return Candidate(cut_ms - 200, cut_ms + 200, cut_ms, "dark", 0.0, None)


def _noise(rng: np.random.Generator, frames: int) -> np.ndarray:
    coarse = rng.integers(0, 256, size=(frames, 18, 32), dtype=np.uint8)
    return coarse.repeat(2, axis=1).repeat(2, axis=2)


def _features(rng: np.random.Generator, sequences: dict[int, np.ndarray] | None = None, duration_ms: int = DURATION_MS) -> Features:
    frames = duration_ms // 100
    thumbs = _noise(rng, frames)
    for cut_ms, sequence in (sequences or {}).items():
        gap = (cut_ms - 200) // 100
        thumbs[gap - 24 : gap - 15] = sequence
    return Features(duration_ms, 10.0, (thumbs.mean(axis=(1, 2)) / 255.0).astype(np.float32), thumbs, None, [], "1")


def _show(cuts_by_rel: dict[str, list[int]], sequences=None, seed: int = 0) -> SeriesContext:
    rng = np.random.default_rng(seed)
    episodes = {
        rel: (_features(rng, (sequences or {}).get(rel)), [_candidate(c) for c in cuts])
        for rel, cuts in cuts_by_rel.items()
    }
    return build_series_context(episodes)


def test_offset_support_counts_aligned_siblings():
    ctx = _show({f"Show/Season 1/e{i}.mkv": [420_000] for i in range(3)} | {"Show/Season 1/e3.mkv": [190_000]})
    assert offset_support(ctx, "Show/Season 1/e0.mkv", _candidate(420_000)) == pytest.approx(2 / 3)
    assert offset_support(ctx, "Show/Season 1/e3.mkv", _candidate(190_000)) == 0.0


def test_offset_support_full_when_all_siblings_align():
    ctx = _show({f"Show/Season 1/e{i}.mkv": [420_000 + i * 1000] for i in range(4)})
    assert offset_support(ctx, "Show/Season 1/e0.mkv", _candidate(420_000)) == pytest.approx(1.0)


def test_offset_support_weights_other_seasons_half():
    ctx = _show({"S/Season 1/a.mkv": [420_000], "S/Season 1/b.mkv": [420_000], "S/Season 2/c.mkv": [190_000]})
    assert offset_support(ctx, "S/Season 1/a.mkv", _candidate(420_000)) == pytest.approx(1.0 / 1.5)


def test_offset_support_unknown_season_weighs_half():
    ctx = _show({"S/a.mkv": [420_000], "S/Season 1/b.mkv": [190_000], "S/Season 1/c.mkv": [420_000]})
    assert offset_support(ctx, "S/Season 1/b.mkv", _candidate(190_000)) == 0.0
    assert offset_support(ctx, "S/Season 1/c.mkv", _candidate(420_000)) == pytest.approx(0.5 / 1.5)


def test_offset_support_accepts_relative_match_beyond_absolute_window():
    rng = np.random.default_rng(0)
    long_f = _features(rng, duration_ms=2_400_000)
    short_f = _features(rng)
    other_f = _features(rng)
    ctx = build_series_context(
        {
            "S/Season 1/short.mkv": (short_f, [_candidate(660_000)]),
            "S/Season 1/long.mkv": (long_f, [_candidate(1_200_000)]),
            "S/Season 1/other.mkv": (other_f, [_candidate(100_000)]),
        }
    )
    assert offset_support(ctx, "S/Season 1/short.mkv", _candidate(660_000)) == pytest.approx(0.5)


def test_single_episode_returns_zero():
    ctx = _show({"S/Season 1/a.mkv": [420_000]})
    assert offset_support(ctx, "S/Season 1/a.mkv", _candidate(420_000)) == 0.0
    assert bumper_match(ctx, "S/Season 1/a.mkv", _candidate(420_000)) == 0.0


def test_two_episodes_return_zero():
    ctx = _show({"S/a.mkv": [420_000], "S/b.mkv": [420_000]})
    assert offset_support(ctx, "S/a.mkv", _candidate(420_000)) == 0.0
    assert bumper_match(ctx, "S/a.mkv", _candidate(420_000)) == 0.0


def test_bumper_match_detects_repeated_frames():
    rng = np.random.default_rng(1)
    bumper = _noise(rng, 9)
    ctx = _show(
        {"S/a.mkv": [420_000], "S/b.mkv": [500_000], "S/c.mkv": [300_000]},
        sequences={"S/a.mkv": {420_000: bumper}, "S/b.mkv": {500_000: bumper}},
    )
    assert bumper_match(ctx, "S/a.mkv", _candidate(420_000)) > 0.95
    assert bumper_match(ctx, "S/c.mkv", _candidate(300_000)) < 0.7


def test_bumper_match_never_matches_own_episode():
    rng = np.random.default_rng(1)
    bumper = _noise(rng, 9)
    ctx = _show(
        {"S/a.mkv": [420_000, 800_000], "S/b.mkv": [500_000], "S/c.mkv": [300_000]},
        sequences={"S/a.mkv": {420_000: bumper, 800_000: bumper}},
    )
    assert bumper_match(ctx, "S/a.mkv", _candidate(420_000)) < 0.7


def test_dark_sequences_are_not_matched():
    rng = np.random.default_rng(2)
    dark = np.zeros((9, 36, 64), dtype=np.uint8)
    ctx = _show(
        {"S/a.mkv": [420_000], "S/b.mkv": [500_000], "S/c.mkv": [300_000]},
        sequences={"S/a.mkv": {420_000: dark}, "S/b.mkv": {500_000: dark}},
    )
    assert bumper_match(ctx, "S/a.mkv", _candidate(420_000)) == 0.0


def test_candidate_near_start_has_no_transition():
    ctx = _show({"S/a.mkv": [1_000], "S/b.mkv": [420_000], "S/c.mkv": [300_000]})
    assert bumper_match(ctx, "S/a.mkv", _candidate(1_000)) == 0.0


def test_season_of_parses_directory_component_case_insensitively():
    assert season_of("Show/season 12/e1.mkv") == 12
    assert season_of("Show/Season 3/e1.mkv") == 3
    assert season_of("Show/e1.mkv") is None


def test_candidate_signals_requires_rel_with_series():
    ctx = _show({"S/a.mkv": [420_000], "S/b.mkv": [420_000], "S/c.mkv": [420_000]})
    f = _features(np.random.default_rng(3))
    with pytest.raises(ValueError):
        candidate_signals(_candidate(420_000), f, ctx)


def test_candidate_signals_fills_series_columns():
    ctx = _show({f"S/Season 1/{n}.mkv": [420_000] for n in "abc"})
    f = _features(np.random.default_rng(3))
    signals = candidate_signals(_candidate(420_000), f, ctx, "S/Season 1/a.mkv")
    assert signals[SIGNAL_NAMES.index("series_offset_support")] == pytest.approx(1.0)


def test_pruned_best_similarity_equals_brute_force():
    rng = np.random.default_rng(5)
    rng_eps = {f"S/e{i}.mkv": (_features(rng, duration_ms=60_000), [_candidate(c) for c in (10_000, 30_000, 50_000)]) for i in range(8)}
    ctx = build_series_context(rng_eps)
    rows = np.arange(3, len(ctx.flat))
    for query_row in range(3):
        query = ctx.flat[query_row]
        assert _best_similarity(ctx, query, rows) == pytest.approx(_similarity(ctx.flat[rows], query).max())


def test_similarity_extremes():
    zeros = np.zeros((1, 9 * 18 * 32), dtype=np.uint8)
    full = np.full(9 * 18 * 32, 255, dtype=np.uint8)
    assert _similarity(full[None, :], full)[0] == 1.0
    assert _similarity(zeros, full)[0] == 0.0
