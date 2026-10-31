import os
from pathlib import Path

from breakdetect import durations
from breakdetect.durations import DurationCache
from breakdetect.media import Probe


def _episode(tmp_path: Path, name: str) -> Path:
    path = tmp_path / "media" / "Kids TV" / "Show" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    return path


def _counting_probe(monkeypatch) -> list[Path]:
    calls: list[Path] = []
    def fake(path: Path) -> Probe:
        calls.append(path)
        return Probe(duration_ms=1_300_000, has_audio=True, audio_channels=2, chapters_ms=[], video_codec="h264")
    monkeypatch.setattr(durations, "probe", fake)
    return calls


def test_durations_persist_across_instances(tmp_path, monkeypatch):
    calls = _counting_probe(monkeypatch)
    paths = [_episode(tmp_path, "a.mkv"), _episode(tmp_path, "b.mkv")]
    store = tmp_path / "durations.json"
    assert DurationCache(store, [tmp_path / "media"]).lookup(paths) == {p: 1_300_000 for p in paths}
    DurationCache(store, [tmp_path / "media"]).lookup(paths)
    assert len(calls) == 2


def test_changed_file_is_probed_again(tmp_path, monkeypatch):
    calls = _counting_probe(monkeypatch)
    path = _episode(tmp_path, "a.mkv")
    store = tmp_path / "durations.json"
    DurationCache(store, [tmp_path / "media"]).lookup([path])
    path.write_bytes(b"different size")
    DurationCache(store, [tmp_path / "media"]).lookup([path])
    assert len(calls) == 2
