import json
from types import SimpleNamespace

import numpy as np
import pytest

from breakdetect import export as export_module
from breakdetect.candidates import Candidate
from breakdetect.evaluate import model_sha
from breakdetect.export import ExportError, export_show, markers_dir, remove_stale_markers
from breakdetect.labels import Decision, EpisodeLabels, ShowLabels, save_labels
from breakdetect.model import LogisticModel
from breakdetect.signals import SIGNAL_NAMES

THRESHOLD = 0.5
REL = "Kids/Show/Season 1/a.mkv"


class FakeCache:
    def __init__(self, durations):
        self.durations = durations

    def rel_path(self, path):
        return "/".join(path.parts[-4:])

    def get(self, path):
        duration = self.durations.get(self.rel_path(path))
        return None if duration is None else SimpleNamespace(duration_ms=duration)


def _cand(cut_ms):
    return Candidate(cut_ms - 500, cut_ms + 500, cut_ms, "dark", 0.0, None)


def _model():
    weights = np.zeros(len(SIGNAL_NAMES))
    weights[0] = 1.0
    return LogisticModel(np.zeros(len(SIGNAL_NAMES)), np.ones(len(SIGNAL_NAMES)), weights, 0.0, 1.0)


def _signals(cuts_and_logits):
    X = np.zeros((len(cuts_and_logits), len(SIGNAL_NAMES)))
    X[:, 0] = [logit for _, logit in cuts_and_logits]
    return [_cand(cut) for cut, _ in cuts_and_logits], X


@pytest.fixture
def env(tmp_path, monkeypatch):
    data = tmp_path / "data"
    monkeypatch.setenv("BREAKDETECT_DATA", str(data))
    (data / "models").mkdir(parents=True)
    text = _model().to_json()
    (data / "models" / "global.json").write_text(text)
    show_dir = tmp_path / "media" / "Kids" / "Show"
    (show_dir / "Season 1").mkdir(parents=True)
    for name in ("a.mkv", "b.mkv", "c.mkv"):
        (show_dir / "Season 1" / name).write_bytes(b"")
    return SimpleNamespace(data=data, show_dir=show_dir, model_text=text)


def _enable(env, thresholds=None):
    payload = {"model_sha": model_sha(env.model_text), "thresholds": thresholds if thresholds is not None else {"show": THRESHOLD}}
    (env.data / "models" / "thresholds.json").write_text(json.dumps(payload))


def _signals_for(monkeypatch, per_rel):
    monkeypatch.setattr(export_module, "show_signals", lambda show_dir, cache: per_rel)


def _label(decisions):
    save_labels(ShowLabels("Show", {REL: EpisodeLabels(decisions=decisions)}))


def _export(env, monkeypatch, per_rel, durations=None):
    _signals_for(monkeypatch, per_rel)
    cache = FakeCache(durations or {r: 1_320_000 for r in per_rel})
    marker = export_show(env.show_dir, cache)
    return json.loads(marker.read_text())


def test_disabled_show_not_exported(env, monkeypatch):
    _enable(env, {"other": THRESHOLD})
    _signals_for(monkeypatch, {REL: _signals([(300_000, 5.0)])})
    assert export_show(env.show_dir, FakeCache({REL: 1})) is None
    assert not markers_dir().exists() or not list(markers_dir().glob("*.json"))


def test_disabled_show_removes_stale_marker(env, monkeypatch):
    _enable(env, {"other": THRESHOLD})
    markers_dir().mkdir(parents=True)
    stale = markers_dir() / "show.json"
    stale.write_text("{}")
    _signals_for(monkeypatch, {})
    assert export_show(env.show_dir, FakeCache({})) is None
    assert not stale.exists()


def test_remove_stale_markers_keeps_enabled(env):
    markers_dir().mkdir(parents=True)
    (markers_dir() / "show.json").write_text("{}")
    (markers_dir() / "gone.json").write_text("{}")
    assert remove_stale_markers({"show"}) == ["gone"]
    assert (markers_dir() / "show.json").exists()


def test_user_rejection_overrides_score(env, monkeypatch):
    _enable(env)
    _label([Decision(300_500, "not_break", "user")])
    marker = _export(env, monkeypatch, {REL: _signals([(300_000, 5.0), (900_000, 5.0)])})
    assert [b["offsetMs"] for b in marker["episodes"][0]["breaks"]] == [900_000]


def test_user_break_included_at_full_score_even_if_model_score_low(env, monkeypatch):
    _enable(env)
    _label([Decision(600_800, "break", "user")])
    marker = _export(env, monkeypatch, {REL: _signals([(600_000, -5.0)])})
    assert marker["episodes"][0]["breaks"] == [{"offsetMs": 600_800, "score": 1.0}]


def test_seed_decisions_do_not_affect_export(env, monkeypatch):
    _enable(env)
    _label([Decision(300_000, "unsure", "seed"), Decision(900_000, "break", "seed")])
    marker = _export(env, monkeypatch, {REL: _signals([(300_000, 5.0)])})
    assert [b["offsetMs"] for b in marker["episodes"][0]["breaks"]] == [300_000]


def test_episode_without_breaks_has_empty_list(env, monkeypatch):
    _enable(env)
    marker = _export(env, monkeypatch, {REL: _signals([(300_000, -5.0)])})
    assert marker["episodes"] == [{"relativePath": REL, "durationMs": 1_320_000, "breaks": []}]


def test_uncached_episodes_are_omitted(env, monkeypatch):
    _enable(env)
    marker = _export(env, monkeypatch, {REL: _signals([])}, durations={REL: 1000})
    assert [e["relativePath"] for e in marker["episodes"]] == [REL]


def test_breaks_closer_than_120s_deduped(env, monkeypatch):
    _enable(env)
    marker = _export(env, monkeypatch, {REL: _signals([(300_000, 3.0), (400_000, 6.0), (600_000, 4.0)])})
    assert [b["offsetMs"] for b in marker["episodes"][0]["breaks"]] == [400_000, 600_000]


def test_marker_header_and_sorting(env, monkeypatch):
    _enable(env)
    other = "Kids/Show/Season 1/b.mkv"
    marker = _export(env, monkeypatch, {other: _signals([]), REL: _signals([(300_000, 5.0)])})
    assert marker["schema"] == 1
    assert marker["detector"] == f"breakdetect/1/{model_sha(env.model_text)[:8]}"
    assert marker["show"] == "Show"
    assert marker["threshold"] == THRESHOLD
    assert [e["relativePath"] for e in marker["episodes"]] == [REL, other]


def test_refuses_on_model_sha_mismatch(env, monkeypatch):
    _enable(env)
    (env.data / "models" / "global.json").write_text(env.model_text + " ")
    _signals_for(monkeypatch, {REL: _signals([(300_000, 5.0)])})
    with pytest.raises(ExportError):
        export_show(env.show_dir, FakeCache({REL: 1}))
    assert not markers_dir().exists()


def test_refuses_when_model_missing(env, monkeypatch):
    _enable(env)
    (env.data / "models" / "global.json").unlink()
    with pytest.raises(ExportError):
        export_show(env.show_dir, FakeCache({}))


def test_cli_refuses_with_nonzero_exit_on_mismatch(env, capsys, tmp_path):
    from breakdetect.cli import main

    _enable(env)
    (env.data / "models" / "global.json").write_text(env.model_text + " ")
    assert main(["export", str(env.show_dir), "--cache", str(tmp_path / "f")]) == 1
    assert "different model" in capsys.readouterr().err
    assert not markers_dir().exists()
