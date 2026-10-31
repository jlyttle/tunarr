from collections.abc import Iterable
from pathlib import Path, PurePosixPath

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate, find_candidates
from breakdetect.labels import ShowLabels, data_dir, labels_dir, load_labels
from breakdetect.model import LogisticModel
from breakdetect.showsignals import ShowSignals, show_signals
from breakdetect.signals import SIGNAL_NAMES, candidate_signals

MATCH_WINDOW_MS = 1500

Episode = tuple[list[Candidate], np.ndarray, list[int]]


def _is_positive(c: Candidate, truth_ms: list[int]) -> bool:
    return any(abs(c.cut_ms - t) <= MATCH_WINDOW_MS for t in truth_ms)


def build_training_set(episodes: Iterable[Episode]) -> tuple[np.ndarray, np.ndarray]:
    blocks, labels = [], []
    for candidates, X, truth_ms in episodes:
        blocks.append(X)
        labels += [1 if _is_positive(c, truth_ms) else 0 for c in candidates]
    X = np.vstack(blocks) if blocks else np.empty((0, len(SIGNAL_NAMES)))
    return X, np.array(labels, dtype=np.int64)


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


def _show_dir(rel: str, path: Path) -> Path | None:
    depth = len(PurePosixPath(rel).parts)
    return path.parents[depth - 2] if depth > 1 else None


def _standalone(cache: FeatureCache, path: Path) -> tuple[list[Candidate], np.ndarray]:
    features = cache.ensure(path)
    candidates = find_candidates(features)
    rows = [candidate_signals(c, features) for c in candidates]
    return candidates, np.array(rows, dtype=np.float64).reshape(-1, len(SIGNAL_NAMES))


def _episode_signals(cache: FeatureCache, shows: dict[Path, ShowSignals], rel: str, path: Path) -> tuple[list[Candidate], np.ndarray]:
    show_dir = _show_dir(rel, path)
    if show_dir is None:
        return _standalone(cache, path)
    if show_dir not in shows:
        shows[show_dir] = show_signals(show_dir, cache)
    return shows[show_dir][rel]


def load_training_episodes(cache: FeatureCache, roots: list[Path]) -> list[Episode]:
    trainables = [t for slug in _label_files() for t in _trainable(load_labels(slug), roots)]
    for _, path, _ in trainables:
        cache.ensure(path)
    shows: dict[Path, ShowSignals] = {}
    episodes = []
    for rel, path, truth in trainables:
        candidates, X = _episode_signals(cache, shows, rel, path)
        episodes.append((candidates, X, truth))
    return episodes


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
