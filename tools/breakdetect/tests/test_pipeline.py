import json
import shutil

import numpy as np
import pytest

from breakdetect import cache as cache_module
from breakdetect.candidates import find_candidates
from breakdetect.cli import main
from breakdetect.features import extract_features
from breakdetect.labels import Decision, EpisodeLabels, ShowLabels, save_labels
from breakdetect.media import file_identity

TWO_GAPS = [("content", 70), ("black", 0.5), ("content", 70), ("black", 0.5), ("content", 70)]
SHOWS = {"show-a": "Show A", "show-b": "Show B"}
EPISODES = 10
HELD_OUT_FROM = 5


@pytest.fixture
def library(make_clip, tmp_path, monkeypatch):
    clip = make_clip(TWO_GAPS)
    features = extract_features(clip)
    monkeypatch.setattr(cache_module, "extract_features", lambda path, **kw: features)
    root = tmp_path / "media"
    monkeypatch.setenv("BREAKDETECT_ROOTS", str(root))
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path / "data"))
    cut_break, cut_other = [c.cut_ms for c in find_candidates(features)]
    for show in SHOWS.values():
        season = root / "Kids TV" / show / "Season 1"
        season.mkdir(parents=True)
        entries = {}
        for n in range(EPISODES):
            path = season / f"e{n:02}.mkv"
            shutil.copy(clip, path)
            entries[f"Kids TV/{show}/Season 1/{path.name}"] = EpisodeLabels(
                identity=file_identity(path),
                duration_ms=features.duration_ms,
                complete=True,
                held_out=n >= HELD_OUT_FROM,
                decisions=[Decision(cut_break, "break", "user"), Decision(cut_other, "not_break", "user")],
            )
        save_labels(ShowLabels(show=show, episodes=entries))
    return tmp_path


def test_library_shaped_tree_exports_one_marker_per_show(library):
    cache = str(library / "cache" / "features")
    assert main(["train", "--cache", cache]) == 0
    assert main(["evaluate", "--cache", cache]) == 0
    assert main(["export", "--all-enabled", "--cache", cache]) == 0
    markers = library / "data" / "markers"
    assert sorted(p.name for p in markers.glob("*.json")) == ["show-a.json", "show-b.json"]
    for slug, show in SHOWS.items():
        marker = json.loads((markers / f"{slug}.json").read_text())
        rels = [e["relativePath"] for e in marker["episodes"]]
        assert len(rels) == EPISODES
        assert all(r.startswith(f"Kids TV/{show}/") for r in rels)
    stored = sorted((library / "cache" / "signals").glob("*.npz"))
    assert {p.name.rsplit("-", 1)[0] for p in stored} == set(SHOWS)
    for p in stored:
        with np.load(p, allow_pickle=False) as z:
            show = SHOWS[p.name.rsplit("-", 1)[0]]
            assert all(str(r).startswith(f"Kids TV/{show}/") for r in z["rels"])
