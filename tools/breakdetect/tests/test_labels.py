import json
import os
from pathlib import Path

import pytest

from breakdetect.labels import Decision, EpisodeLabels, ShowLabels, import_seeds, is_stale, load_labels, save_labels, slugify
from breakdetect.media import file_identity, relative_path

REL = "Show/S01E01.mkv"


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path / "data"))


@pytest.fixture
def media(tmp_path):
    root = tmp_path / "media"
    (root / "Show").mkdir(parents=True)
    (root / REL).write_bytes(b"video")
    return root


def _labels(media: Path, complete: bool, decisions: list[Decision]) -> ShowLabels:
    entry = EpisodeLabels(identity=file_identity(media / REL), duration_ms=1000, complete=complete, decisions=decisions)
    return ShowLabels(show="Rugrats", episodes={REL: entry})


def test_round_trip(media):
    labels = _labels(media, True, [Decision(500, "break", "user"), Decision(900, "unsure", "seed")])
    save_labels(labels)
    assert load_labels("rugrats") == labels
    assert list((Path(os.environ["BREAKDETECT_DATA"]) / "labels").iterdir()) == [Path(os.environ["BREAKDETECT_DATA"]) / "labels" / "rugrats.json"]


def test_seed_labels_are_not_ground_truth(media):
    labels = _labels(media, True, [Decision(500, "unsure", "seed"), Decision(600, "break", "seed"), Decision(700, "break", "user")])
    assert labels.ground_truth(REL, [media]) == [700]


def test_incomplete_episode_has_no_ground_truth(media):
    labels = _labels(media, False, [Decision(700, "break", "user")])
    assert labels.ground_truth(REL, [media]) is None


def test_changed_file_marks_labels_stale(media):
    labels = _labels(media, True, [Decision(700, "break", "user")])
    assert labels.ground_truth(REL, [media]) == [700]
    (media / REL).write_bytes(b"different video")
    assert is_stale(labels.episodes[REL], media / REL)
    assert labels.ground_truth(REL, [media]) is None


def test_empty_identity_is_stale(media):
    assert is_stale(EpisodeLabels(identity=""), media / REL)


def test_slugify():
    assert slugify("Mystery Science Theater 3000") == "mystery-science-theater-3000"
    assert slugify("  30 Rock! ") == "30-rock"


def test_relative_path_is_nfc_normalized(tmp_path):
    decomposed = "Café/ep.mkv"
    assert relative_path(tmp_path / decomposed, [tmp_path]) == "Café/ep.mkv"


def _write_pilot(directory: Path, media_path: Path, decisions: list[dict]) -> Path:
    inventory = {"episodes": [{"id": "ep1", "show": "Buffy", "path": str(media_path), "runtimeMs": 2000, "source": {"path": str(media_path), "size": 5, "mtimeMs": 1000}}]}
    (directory / "inventory.json").write_text(json.dumps(inventory))
    review = directory / "review.json"
    review.write_text(json.dumps({"episodes": [{"id": "ep1", "decisions": decisions}]}))
    return review


def _empty_dataset(directory: Path) -> Path:
    path = directory / "dataset.json"
    path.write_text(json.dumps({"episodes": []}))
    return path


def test_import_maps_pilot_user_confirmed_to_user_break(tmp_path, media):
    pilot_dir = tmp_path / "pilot"
    pilot_dir.mkdir()
    decisions = [
        {"timestampMs": 1000, "label": "break", "provenance": "user-confirmed"},
        {"timestampMs": 1500, "label": "uncertain", "provenance": "assistant-proposed"},
        {"timestampMs": 2800, "label": "uncertain", "provenance": "assistant-proposed"},
    ]
    review = _write_pilot(pilot_dir, media / REL, decisions)
    imported = import_seeds(_empty_dataset(tmp_path), review, [media])
    entry = imported["buffy"].episodes[REL]
    assert entry.decisions == [Decision(1000, "break", "user"), Decision(2800, "unsure", "seed")]
    assert entry.identity == file_identity(media / REL)
    assert not entry.complete


def test_import_uses_recorded_identity_when_file_missing(tmp_path):
    pilot_dir = tmp_path / "pilot"
    pilot_dir.mkdir()
    missing = tmp_path / "media" / REL
    review = _write_pilot(pilot_dir, missing, [])
    imported = import_seeds(_empty_dataset(tmp_path), review, [tmp_path / "media"])
    assert imported["buffy"].episodes[REL].identity == "5:1000000000"


def test_import_research_breaks_are_seed_unsure(tmp_path, media):
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps({"episodes": [{"series": "Rugrats", "path": str(media / REL), "runtime_s": 1.5, "file_identity": {"size_bytes": 1, "mtime_ns": 2}, "breaks": [{"timestamp_s": 0.7}]}]}))
    pilot_dir = tmp_path / "pilot"
    pilot_dir.mkdir()
    review = _write_pilot(pilot_dir, tmp_path / "none" / REL, [])
    imported = import_seeds(dataset, review, [media, tmp_path / "none"])
    assert imported["rugrats"].episodes[REL].decisions == [Decision(700, "unsure", "seed")]
    assert imported["rugrats"].episodes[REL].duration_ms == 1500
