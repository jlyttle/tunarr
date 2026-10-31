from collections.abc import Iterable
from pathlib import Path, PurePosixPath

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate, find_candidates
from breakdetect.features import Features
from breakdetect.labels import ShowLabels, data_dir, labels_dir, load_labels
from breakdetect.media import discover_episodes
from breakdetect.model import LogisticModel
from breakdetect.series import SeriesContext, build_series_context_from
from breakdetect.signals import SIGNAL_NAMES, candidate_signals

MATCH_WINDOW_MS = 1500

Episode = tuple[Features, list[Candidate], list[int], str, SeriesContext | None]


def _is_positive(c: Candidate, truth_ms: list[int]) -> bool:
    return any(abs(c.cut_ms - t) <= MATCH_WINDOW_MS for t in truth_ms)


def build_training_set(episodes: Iterable[Episode]) -> tuple[np.ndarray, np.ndarray]:
    rows, labels = [], []
    for features, candidates, truth_ms, rel, series in episodes:
        for c in candidates:
            rows.append(candidate_signals(c, features, series, rel))
            labels.append(1 if _is_positive(c, truth_ms) else 0)
    return np.array(rows).reshape(-1, len(SIGNAL_NAMES)), np.array(labels, dtype=np.int64)


def model_path() -> Path:
    return data_dir() / "models" / "global.json"


def _trainable(labels: ShowLabels, roots: list[Path]) -> list[tuple[str, Path, list[int]]]:
    found = []
    for rel, entry in labels.episodes.items():
        truth = labels.ground_truth(rel, roots)
        if truth is None or entry.held_out:
            continue
        path = next(root / rel for root in roots if (root / rel).exists())
        found.append((rel, path, truth))
    return found


def _label_files() -> list[str]:
    return sorted(p.stem for p in labels_dir().glob("*.json"))


def _cached_siblings(cache: FeatureCache, show_dir: Path) -> Iterable[tuple[str, Features, list[Candidate]]]:
    for path in discover_episodes(show_dir):
        features = cache.get(path)
        if features is not None:
            yield cache.rel_path(path), features, find_candidates(features)


def _show_dir(rel: str, path: Path) -> Path | None:
    depth = len(PurePosixPath(rel).parts)
    return path.parents[depth - 2] if depth > 1 else None


def _series_for(cache: FeatureCache, contexts: dict[Path, SeriesContext], rel: str, path: Path) -> SeriesContext | None:
    show_dir = _show_dir(rel, path)
    if show_dir is None:
        return None
    if show_dir not in contexts:
        contexts[show_dir] = build_series_context_from(_cached_siblings(cache, show_dir))
    return contexts[show_dir]


def _ensured_trainables(cache: FeatureCache, roots: list[Path]) -> list[tuple[str, Path, list[int], Features]]:
    return [
        (rel, path, truth, cache.ensure(path))
        for slug in _label_files()
        for rel, path, truth in _trainable(load_labels(slug), roots)
    ]


def load_training_episodes(cache: FeatureCache, roots: list[Path]) -> list[Episode]:
    contexts: dict[Path, SeriesContext] = {}
    return [
        (features, find_candidates(features), truth, rel, _series_for(cache, contexts, rel, path))
        for rel, path, truth, features in _ensured_trainables(cache, roots)
    ]


def train(cache: FeatureCache, roots: list[Path]) -> tuple[int, int, int]:
    episodes = load_training_episodes(cache, roots)
    X, y = build_training_set(episodes)
    positives = int((y == 1).sum())
    if positives == 0:
        raise ValueError(f"no positive candidates across {len(episodes)} episodes; refusing to write a model")
    dest = model_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(LogisticModel.fit(X, y).to_json())
    return len(episodes), positives, len(y) - positives
