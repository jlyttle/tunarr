import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate
from breakdetect.consistency import supported_cuts, unseen_gate_passes
from breakdetect.evaluate import (
    MIN_GAP_MS,
    ShowThreshold,
    _select_indices,
    load_thresholds,
    load_unseen_threshold,
    model_sha,
)
from breakdetect.features import EXTRACTOR_VERSION
from breakdetect.labels import DEDUPE_WINDOW_MS, EpisodeLabels, ShowLabels, data_dir, is_stale, load_labels, slugify
from breakdetect.loso import _cuts
from breakdetect.media import discover_episodes
from breakdetect.model import LogisticModel
from breakdetect.showsignals import show_signals, signals_key
from breakdetect.train import _show_dir, model_path

SCHEMA = 1
USER_BREAK_SCORE = 1.0
REJECTED_LABELS = {"not_break", "unsure"}
UNSEEN_SOURCE = "unseen"


class ExportError(Exception):
    pass


class StaleSignalsError(Exception):
    pass


@dataclass
class ExportSummary:
    episodes: int
    breaks: int


def markers_dir() -> Path:
    return data_dir() / "markers"


def marker_path(show_slug: str) -> Path:
    return markers_dir() / f"{show_slug}.json"


def load_approved_model() -> tuple[str, LogisticModel, dict[str, ShowThreshold]]:
    if not model_path().exists():
        raise ExportError(f"{model_path()} is missing; run `breakdetect train` and `breakdetect evaluate`")
    text = model_path().read_text()
    sha, thresholds = load_thresholds()
    if model_sha(text) != sha:
        raise ExportError("thresholds.json was computed for a different model; run `breakdetect evaluate`")
    return sha, LogisticModel.from_json(text), thresholds


def _user_decisions(entry: EpisodeLabels | None, labels: set[str]) -> list[int]:
    return [d.cut_ms for d in entry.decisions if d.source == "user" and d.label in labels] if entry else []


def _current_entry(labels: ShowLabels | None, rel: str, path: Path) -> EpisodeLabels | None:
    entry = labels.episodes.get(rel) if labels else None
    return entry if entry is not None and not is_stale(entry, path) else None


def _near_any_within(cut_ms: int, others: list[int], window_ms: int) -> bool:
    return any(abs(cut_ms - o) <= window_ms for o in others)


def episode_breaks(
    candidates: list[Candidate], scores: np.ndarray, rejected: list[int], confirmed: list[int], threshold: float
) -> list[dict]:
    remaining = [
        i
        for i, c in enumerate(candidates)
        if not _near_any_within(c.cut_ms, rejected, DEDUPE_WINDOW_MS)
        and not _near_any_within(c.cut_ms, confirmed, MIN_GAP_MS)
    ]
    chosen = _select_indices([candidates[i] for i in remaining], scores[remaining], threshold, MIN_GAP_MS)
    model_breaks = [{"offsetMs": candidates[remaining[k]].cut_ms, "score": float(scores[remaining[k]])} for k in chosen]
    user_breaks = [{"offsetMs": cut, "score": USER_BREAK_SCORE} for cut in confirmed]
    return sorted(user_breaks + model_breaks, key=lambda b: b["offsetMs"])


def _labels_or_none(slug: str) -> ShowLabels | None:
    try:
        return load_labels(slug)
    except FileNotFoundError:
        return None


def _episode_entry(rel: str, duration_ms: int, candidates, X, model, entry: EpisodeLabels | None, threshold) -> dict:
    breaks = episode_breaks(
        candidates,
        model.predict(X),
        _user_decisions(entry, REJECTED_LABELS),
        _user_decisions(entry, {"break"}),
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
            entry = _current_entry(labels, rel, path)
            entries.append(_episode_entry(rel, features.duration_ms, candidates, X, model, entry, threshold))
    return sorted(entries, key=lambda e: e["relativePath"])


def _header(sha: str, show_dir: Path, threshold: float) -> dict:
    return {
        "schema": SCHEMA,
        "detector": f"breakdetect/{EXTRACTOR_VERSION}/{sha[:8]}",
        "show": show_dir.name,
        "threshold": threshold,
    }


def export_show(show_dir: Path, cache: FeatureCache) -> Path | None:
    sha, model, thresholds = load_approved_model()
    slug = slugify(show_dir.name)
    dest = marker_path(slug)
    if slug not in thresholds:
        dest.unlink(missing_ok=True)
        return None
    if signals_key(show_dir, cache) != thresholds[slug].signals_key:
        dest.unlink(missing_ok=True)
        raise StaleSignalsError(
            f"{show_dir.name}: cached features changed since evaluate; marker removed, run `breakdetect evaluate` again"
        )
    threshold = thresholds[slug].threshold
    episodes = _episodes(show_dir, cache, model, _labels_or_none(slug), threshold)
    _write_atomic(dest, {**_header(sha, show_dir, threshold), "episodes": episodes})
    return dest


def _scored(cuts: list[int], candidates: list[Candidate], scores: np.ndarray) -> list[dict]:
    by_cut = {c.cut_ms: float(s) for c, s in zip(candidates, scores)}
    return [{"offsetMs": cut, "score": by_cut[cut]} for cut in cuts]


def _unseen_episodes(show_dir: Path, cache: FeatureCache, signals, model: LogisticModel, cuts) -> list[dict]:
    entries = []
    for path in discover_episodes(show_dir):
        rel = cache.rel_path(path)
        features = cache.get(path) if rel in signals else None
        if features is not None:
            candidates, X = signals[rel]
            breaks = _scored(cuts[rel], candidates, model.predict(X)) if len(candidates) else []
            entries.append({"relativePath": rel, "durationMs": features.duration_ms, "breaks": breaks})
    return sorted(entries, key=lambda e: e["relativePath"])


def export_unseen_show(show_dir: Path, cache: FeatureCache) -> Path | None:
    sha, model, _ = load_approved_model()
    threshold = load_unseen_threshold()
    if threshold is None:
        raise ExportError("thresholds.json has no unseen-show threshold; run `breakdetect evaluate`")
    dest = marker_path(slugify(show_dir.name))
    signals = show_signals(show_dir, cache)
    cuts = supported_cuts(_cuts(signals, model, threshold))
    if not unseen_gate_passes(cuts):
        dest.unlink(missing_ok=True)
        return None
    episodes = _unseen_episodes(show_dir, cache, signals, model, cuts)
    _write_atomic(dest, {**_header(sha, show_dir, threshold), "source": UNSEEN_SOURCE, "episodes": episodes})
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


def _is_unseen(marker: Path) -> bool:
    try:
        return json.loads(marker.read_text()).get("source") == UNSEEN_SOURCE
    except (OSError, ValueError, AttributeError):
        return False


def remove_stale_markers(enabled: set[str]) -> list[str]:
    stale = [p for p in sorted(markers_dir().glob("*.json")) if p.stem not in enabled and not _is_unseen(p)]
    for p in stale:
        p.unlink()
    return [p.stem for p in stale]
