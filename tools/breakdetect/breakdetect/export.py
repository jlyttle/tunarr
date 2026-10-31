import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate
from breakdetect.evaluate import MIN_GAP_MS, load_thresholds, model_sha, select_breaks
from breakdetect.features import EXTRACTOR_VERSION
from breakdetect.labels import DEDUPE_WINDOW_MS, ShowLabels, data_dir, load_labels, slugify
from breakdetect.media import discover_episodes
from breakdetect.model import LogisticModel
from breakdetect.showsignals import show_signals
from breakdetect.train import _show_dir, model_path

SCHEMA = 1
USER_BREAK_SCORE = 1.0


class ExportError(Exception):
    pass


@dataclass
class ExportSummary:
    episodes: int
    breaks: int


def markers_dir() -> Path:
    return data_dir() / "markers"


def marker_path(show_slug: str) -> Path:
    return markers_dir() / f"{show_slug}.json"


def load_approved_model() -> tuple[str, LogisticModel, dict[str, float]]:
    if not model_path().exists():
        raise ExportError(f"{model_path()} is missing; run `breakdetect train` and `breakdetect evaluate`")
    text = model_path().read_text()
    sha, thresholds = load_thresholds()
    if model_sha(text) != sha:
        raise ExportError("thresholds.json was computed for a different model; run `breakdetect evaluate`")
    return sha, LogisticModel.from_json(text), thresholds


def _user_decisions(labels: ShowLabels | None, rel: str, label: str) -> list[int]:
    entry = labels.episodes.get(rel) if labels else None
    return [d.cut_ms for d in entry.decisions if d.source == "user" and d.label == label] if entry else []


def _near_any(cut_ms: int, others: list[int]) -> bool:
    return any(abs(cut_ms - o) <= DEDUPE_WINDOW_MS for o in others)


def _user_candidate(cut_ms: int) -> Candidate:
    return Candidate(cut_ms, cut_ms, cut_ms, "user", 0.0, None)


def episode_breaks(
    candidates: list[Candidate], scores: np.ndarray, rejected: list[int], confirmed: list[int], threshold: float
) -> list[dict]:
    kept = [(c, float(s)) for c, s in zip(candidates, scores) if not _near_any(c.cut_ms, rejected + confirmed)]
    kept += [(_user_candidate(cut), USER_BREAK_SCORE) for cut in confirmed]
    combined = [c for c, _ in kept]
    combined_scores = np.array([s for _, s in kept], dtype=np.float64)
    best = {}
    for c, s in kept:
        best[c.cut_ms] = max(s, best.get(c.cut_ms, s))
    return [{"offsetMs": cut, "score": best[cut]} for cut in select_breaks(combined, combined_scores, threshold, MIN_GAP_MS)]


def _labels_or_none(slug: str) -> ShowLabels | None:
    try:
        return load_labels(slug)
    except FileNotFoundError:
        return None


def _episode_entry(rel: str, duration_ms: int, candidates, X, model, labels, threshold) -> dict:
    breaks = episode_breaks(
        candidates,
        model.predict(X),
        _user_decisions(labels, rel, "not_break"),
        _user_decisions(labels, rel, "break"),
        threshold,
    )
    return {"relativePath": rel, "durationMs": duration_ms, "breaks": breaks}


def _write_atomic(dest: Path, payload: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _episodes(show_dir: Path, cache: FeatureCache, model: LogisticModel, labels: ShowLabels | None, threshold: float) -> list[dict]:
    signals = show_signals(show_dir, cache)
    entries = []
    for path in discover_episodes(show_dir):
        rel = cache.rel_path(path)
        features = cache.get(path) if rel in signals else None
        if features is not None:
            candidates, X = signals[rel]
            entries.append(_episode_entry(rel, features.duration_ms, candidates, X, model, labels, threshold))
    return sorted(entries, key=lambda e: e["relativePath"])


def export_show(show_dir: Path, cache: FeatureCache) -> Path | None:
    sha, model, thresholds = load_approved_model()
    slug = slugify(show_dir.name)
    dest = marker_path(slug)
    if slug not in thresholds:
        dest.unlink(missing_ok=True)
        return None
    episodes = _episodes(show_dir, cache, model, _labels_or_none(slug), thresholds[slug])
    _write_atomic(dest, {
        "schema": SCHEMA,
        "detector": f"breakdetect/{EXTRACTOR_VERSION}/{sha[:8]}",
        "show": show_dir.name,
        "threshold": thresholds[slug],
        "episodes": episodes,
    })
    return dest


def summarize(marker: Path) -> ExportSummary:
    episodes = json.loads(marker.read_text())["episodes"]
    return ExportSummary(len(episodes), sum(len(e["breaks"]) for e in episodes))


def locate_show_dir(slug: str, roots: list[Path]) -> Path | None:
    labels = _labels_or_none(slug)
    for rel in sorted(labels.episodes) if labels else []:
        for root in roots:
            if (root / rel).exists():
                return _show_dir(rel, root / rel)
    return None


def remove_stale_markers(enabled: set[str]) -> list[str]:
    stale = [p for p in sorted(markers_dir().glob("*.json")) if p.stem not in enabled]
    for p in stale:
        p.unlink()
    return [p.stem for p in stale]
