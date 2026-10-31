from pathlib import Path

import pytest

from breakdetect import cache as cache_mod
from breakdetect.cache import FeatureCache, run_batch
from breakdetect.candidates import find_candidates
from breakdetect.features import extract_features
from breakdetect.media import Probe


@pytest.fixture
def fifteen_minute_minimum(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("breakdetect.candidates.MIN_EPISODE_MS", 15 * 60_000)


def test_short_episode_has_no_candidates(make_clip, fifteen_minute_minimum) -> None:
    clip = make_clip([("content", 70), ("black", 0.5), ("content", 70)])
    assert find_candidates(extract_features(clip)) == []


def test_extract_skips_short_uncached_episode(tmp_path: Path, monkeypatch, fifteen_minute_minimum) -> None:
    media = tmp_path / "media" / "Kids TV" / "Show" / "Season 1"
    media.mkdir(parents=True)
    episode = media / "e1.mkv"
    episode.write_bytes(b"x")
    monkeypatch.setattr(cache_mod, "probe", lambda p: Probe(duration_ms=11 * 60_000, has_audio=True, audio_channels=2, chapters_ms=[], video_codec="h264"))
    def no_extract(*a, **k):
        raise AssertionError("short episode must not be extracted")
    monkeypatch.setattr(cache_mod, "extract_features", no_extract)
    cache = FeatureCache(tmp_path / "cache", roots=[tmp_path / "media"])
    [result] = run_batch([episode], workers=1, hwaccel=None, cache=cache)
    assert result.status == "skipped"
    assert cache.get(episode) is None
