import shutil

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.showsignals import show_signals, signals_dir

from breakdetect.signals import SIGNAL_NAMES

TWO_GAPS = [("content", 70), ("black", 0.5), ("content", 70), ("black", 0.5), ("content", 70)]


def _show(make_clip, tmp_path, names):
    clip = make_clip(TWO_GAPS)
    roots = [tmp_path / "media"]
    season = roots[0] / "Show" / "Season 1"
    season.mkdir(parents=True, exist_ok=True)
    cache = FeatureCache(tmp_path / "features", roots)
    for name in names:
        shutil.copy(clip, season / name)
        cache.ensure(season / name)
    return roots[0] / "Show", cache


def test_show_signals_covers_every_cached_episode_and_persists(make_clip, tmp_path):
    show_dir, cache = _show(make_clip, tmp_path, ["a.mkv", "b.mkv", "c.mkv"])
    cold = show_signals(show_dir, cache)
    assert sorted(cold) == [f"Show/Season 1/{n}.mkv" for n in "abc"]
    candidates, X = cold["Show/Season 1/a.mkv"]
    assert X.shape == (len(candidates), len(SIGNAL_NAMES))
    assert X[:, SIGNAL_NAMES.index("series_offset_support")].min() == 1.0
    assert len(list(signals_dir(cache).glob("show-*.npz"))) == 1
    warm = show_signals(show_dir, cache)
    for rel, (cands, matrix) in cold.items():
        assert warm[rel][0] == cands
        assert np.array_equal(warm[rel][1], matrix)


def test_adding_an_episode_invalidates_stored_signals(make_clip, tmp_path):
    show_dir, cache = _show(make_clip, tmp_path, ["a.mkv", "b.mkv"])
    show_signals(show_dir, cache)
    shutil.copy(show_dir / "Season 1" / "a.mkv", show_dir / "Season 1" / "c.mkv")
    cache.ensure(show_dir / "Season 1" / "c.mkv")
    again = show_signals(show_dir, cache)
    assert len(again) == 3
    assert len(list(signals_dir(cache).glob("show-*.npz"))) == 2


def test_source_hash_is_part_of_the_signals_key(make_clip, tmp_path, monkeypatch):
    show_dir, cache = _show(make_clip, tmp_path, ["a.mkv", "b.mkv"])
    show_signals(show_dir, cache)
    monkeypatch.setattr("breakdetect.showsignals._code_hash", lambda: "edited")
    show_signals(show_dir, cache)
    assert len(list(signals_dir(cache).glob("show-*.npz"))) == 2
