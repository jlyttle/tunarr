import os
from pathlib import Path

import numpy as np
import pytest

from breakdetect import cache as cache_module
from breakdetect.cache import FeatureCache, run_batch
from breakdetect.features import EXTRACTOR_VERSION, Features
from breakdetect.media import discover_episodes, relative_path


def _features() -> Features:
    return Features(
        duration_ms=1000,
        fps=10.0,
        luma=np.zeros(10, dtype=np.float32),
        thumbs=np.zeros((10, 36, 64), dtype=np.uint8),
        audio_rms_db=None,
        chapters_ms=[],
        extractor_version=EXTRACTOR_VERSION,
    )


@pytest.fixture
def media(tmp_path: Path) -> Path:
    path = tmp_path / "media" / "Show" / "ep1.mkv"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"x" * 10)
    return path


@pytest.fixture
def cache(tmp_path: Path) -> FeatureCache:
    return FeatureCache(tmp_path / "cache", roots=[tmp_path / "media"])


def test_second_ensure_uses_cache(monkeypatch, media, cache):
    calls = []
    monkeypatch.setattr(cache_module, "extract_features", lambda path, **kw: calls.append(path) or _features())
    cache.ensure(media)
    again = cache.ensure(media)
    assert len(calls) == 1
    assert again.duration_ms == 1000


def test_failed_extract_leaves_no_cache_entry(monkeypatch, media, cache):
    def boom(path, **kw):
        raise RuntimeError("nope")

    monkeypatch.setattr(cache_module, "extract_features", boom)
    with pytest.raises(RuntimeError):
        cache.ensure(media)
    assert cache.get(media) is None
    assert [p for p in cache.root.rglob("*") if p.is_file()] == []


def test_failed_save_removes_temp_file(monkeypatch, media, cache):
    def boom(f, dest):
        Path(dest).write_bytes(b"partial")
        raise OSError("disk full")

    monkeypatch.setattr(cache_module, "extract_features", lambda path, **kw: _features())
    monkeypatch.setattr(cache_module, "save_features", boom)
    with pytest.raises(OSError):
        cache.ensure(media)
    assert [p for p in cache.root.rglob("*") if p.is_file()] == []


def test_changed_mtime_misses_cache(monkeypatch, media, cache):
    monkeypatch.setattr(cache_module, "extract_features", lambda path, **kw: _features())
    cache.ensure(media)
    assert cache.get(media) is not None
    st = media.stat()
    os.utime(media, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert cache.get(media) is None


def test_run_batch_captures_failures_and_continues(monkeypatch, tmp_path, cache):
    good = tmp_path / "media" / "Show" / "good.mkv"
    bad = tmp_path / "media" / "Show" / "bad.mkv"
    good.parent.mkdir(parents=True)
    good.write_bytes(b"g")
    bad.write_bytes(b"b")

    def fake(path, **kw):
        if path.name == "bad.mkv":
            raise RuntimeError("corrupt")
        return _features()

    monkeypatch.setattr(cache_module, "extract_features", fake)
    first = {r.rel_path: r for r in run_batch([good, bad], workers=2, hwaccel=None, cache=cache)}
    assert first["Show/good.mkv"].status == "extracted"
    assert first["Show/bad.mkv"].status == "failed"
    assert "corrupt" in first["Show/bad.mkv"].error
    second = {r.rel_path: r.status for r in run_batch([good], workers=1, hwaccel=None, cache=cache)}
    assert second["Show/good.mkv"] == "cached"


def test_outside_roots_raises(tmp_path):
    with pytest.raises(ValueError):
        relative_path(tmp_path / "elsewhere" / "x.mkv", [tmp_path / "media"])


def test_discover_episodes_skips_specials_and_non_video(tmp_path):
    (tmp_path / "Season 1").mkdir()
    (tmp_path / "Specials").mkdir()
    (tmp_path / "Season 1" / "a.MKV").write_bytes(b"")
    (tmp_path / "Season 1" / "a.nfo").write_bytes(b"")
    (tmp_path / "Specials" / "s.mkv").write_bytes(b"")
    assert discover_episodes(tmp_path) == [tmp_path / "Season 1" / "a.MKV"]


def test_relative_path_same_across_roots(tmp_path):
    mac_root = tmp_path / "Volumes" / "plex"
    container_root = tmp_path / "media" / "plex"
    mac_file = mac_root / "Kids TV" / "Show" / "Season 1" / "ep1.mkv"
    container_file = container_root / "Kids TV" / "Show" / "Season 1" / "ep1.mkv"
    assert relative_path(mac_file, [mac_root]) == relative_path(container_file, [container_root]) == "Kids TV/Show/Season 1/ep1.mkv"
