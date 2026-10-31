import shutil

import numpy as np
import pytest

from breakdetect.cli import main
from breakdetect.candidates import find_candidates
from breakdetect.features import extract_features
from breakdetect.model import LogisticModel
from breakdetect.signals import SIGNAL_NAMES
from breakdetect.cache import FeatureCache
from breakdetect.labels import Decision, EpisodeLabels, ShowLabels, save_labels
from breakdetect.media import file_identity
from breakdetect.train import build_training_set, load_training_episodes, train


def _auc(scores: np.ndarray, y: np.ndarray) -> float:
    positives, negatives = scores[y == 1], scores[y == 0]
    wins = (positives[:, None] > negatives[None, :]).mean()
    ties = (positives[:, None] == negatives[None, :]).mean()
    return float(wins + 0.5 * ties)


@pytest.fixture
def blobs():
    rng = np.random.default_rng(0)
    X = np.vstack([rng.normal(0, 1, (400, len(SIGNAL_NAMES))), rng.normal(2.5, 1, (40, len(SIGNAL_NAMES)))])
    return X, np.array([0] * 400 + [1] * 40)


def test_logistic_separates_synthetic_classes(blobs):
    X, y = blobs
    model = LogisticModel.fit(X, y)
    assert _auc(model.predict(X), y) > 0.95
    restored = LogisticModel.from_json(model.to_json())
    assert np.allclose(restored.predict(X), model.predict(X))


def test_class_weighting_balances_rare_positives(blobs):
    X, y = blobs
    model = LogisticModel.fit(X, y)
    assert model.predict(X)[y == 1].mean() > 0.5


def test_from_json_rejects_mismatched_signal_names(blobs):
    X, y = blobs
    raw = LogisticModel.fit(X, y).to_json().replace("dark_depth", "other")
    with pytest.raises(ValueError):
        LogisticModel.from_json(raw)


def test_build_training_set_labels_candidates_near_truth(make_clip):
    f = extract_features(make_clip([("content", 70), ("black", 0.5), ("content", 70)]))
    candidates = find_candidates(f)
    X, y = build_training_set([(f, candidates, [70250]), (f, candidates, [])])
    assert X.shape == (2, len(SIGNAL_NAMES))
    assert y.tolist() == [1, 0]


def test_train_without_positives_fails_and_writes_no_model(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    assert main(["train", "--cache", str(tmp_path / "cache")]) == 1
    assert "no positive candidates" in capsys.readouterr().err
    assert not (tmp_path / "models" / "global.json").exists()


def test_fit_rejects_single_class():
    with pytest.raises(ValueError):
        LogisticModel.fit(np.zeros((4, len(SIGNAL_NAMES))), np.zeros(4))


TWO_GAPS = [("content", 70), ("black", 0.5), ("content", 70), ("black", 0.5), ("content", 70)]


def _episode(clip, **flags):
    return EpisodeLabels(
        identity=flags.pop("identity", file_identity(clip)),
        duration_ms=210_000,
        complete=flags.pop("complete", True),
        held_out=flags.pop("held_out", False),
        decisions=[Decision(70250, "break", "user")],
    )


def test_training_episodes_skip_held_out_incomplete_and_stale(make_clip, tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path / "data"))
    clip = make_clip(TWO_GAPS)
    episodes = {
        "good": _episode(clip),
        "held_out": _episode(clip, held_out=True),
        "incomplete": _episode(clip, complete=False),
        "stale": _episode(clip, identity="1:1"),
    }
    shows = {name: clip.parent / f"{name}.mkv" for name in episodes}
    for name, path in shows.items():
        shutil.copy(clip, path)
    for name, entry in episodes.items():
        if name != "stale":
            entry.identity = file_identity(shows[name])
    save_labels(ShowLabels(show="Show", episodes={f"{n}.mkv": e for n, e in episodes.items()}))
    roots = [clip.parent]
    loaded = load_training_episodes(FeatureCache(tmp_path / "cache", roots), roots)
    assert len(loaded) == 1
    assert loaded[0][2] == [70250]


def test_train_writes_loadable_model(make_clip, tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path / "data"))
    clip = make_clip(TWO_GAPS)
    save_labels(ShowLabels(show="Show", episodes={clip.name: _episode(clip)}))
    roots = [clip.parent]
    counts = train(FeatureCache(tmp_path / "cache", roots), roots)
    assert counts == (1, 1, 1)
    model = LogisticModel.from_json((tmp_path / "data" / "models" / "global.json").read_text())
    assert len(model.weights) == len(SIGNAL_NAMES)
