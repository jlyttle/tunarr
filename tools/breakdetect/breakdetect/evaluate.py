import datetime
import hashlib
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate
from breakdetect.labels import data_dir, load_labels, slugify
from breakdetect.model import LogisticModel
from breakdetect.showsignals import ShowSignals, signals_key
from breakdetect.train import (
    MATCH_WINDOW_MS,
    _episode_signals,
    _label_files,
    _matched_predictions,
    _show_dir,
    build_training_set,
    model_path,
)

MIN_GAP_MS = 120_000
CLUSTER_MS = 8_000
MIN_PRECISION = 0.95
MIN_POSITIVES = 5
MIN_GT_EPISODES = 3
MIN_HELD_OUT_PREDICTIONS = 5

ModelFitter = Callable[[np.ndarray, np.ndarray], LogisticModel]


@dataclass
class GtEpisode:
    slug: str
    rel: str
    held_out: bool
    candidates: list[Candidate]
    X: np.ndarray
    truth: list[int]
    show_dir: Path | None = None


@dataclass
class ScoredEpisode:
    rel: str
    candidates: list[Candidate]
    scores: np.ndarray
    truth: list[int]


@dataclass
class ShowReport:
    show: str
    episodes: int
    held_out_episodes: int
    unscorable: list[str]
    threshold: float | None
    precision: float | None
    recall: float | None
    held_out_precision: float | None
    held_out_recall: float | None
    enabled: bool
    false_positives: list[tuple[str, int, float]] = field(default_factory=list)


def match(pred_ms: list[int], truth_ms: list[int], tol_ms: int = MATCH_WINDOW_MS) -> tuple[int, int, int]:
    tp = len(_matched_predictions(pred_ms, truth_ms, tol_ms))
    return tp, len(pred_ms) - tp, len(truth_ms) - tp


def _earliest_in_cluster(candidates: list[Candidate], eligible: list[int], i: int) -> int:
    cluster = [k for k in eligible if 0 <= candidates[i].cut_ms - candidates[k].cut_ms <= CLUSTER_MS]
    return min(cluster, key=lambda k: candidates[k].cut_ms)


def _select_indices(candidates: list[Candidate], scores: np.ndarray, threshold: float, min_gap_ms: int) -> list[int]:
    eligible = sorted((i for i in range(len(candidates)) if scores[i] >= threshold), key=lambda i: -scores[i])
    kept: list[int] = []
    for i in eligible:
        j = _earliest_in_cluster(candidates, eligible, i)
        if all(abs(candidates[j].cut_ms - candidates[k].cut_ms) > min_gap_ms for k in kept):
            kept.append(j)
    return kept


def select_breaks(candidates: list[Candidate], scores: np.ndarray, threshold: float, min_gap_ms: int = MIN_GAP_MS) -> list[int]:
    return sorted(candidates[i].cut_ms for i in _select_indices(candidates, scores, threshold, min_gap_ms))


def choose_threshold(
    episodes: list["ScoredEpisode"], min_precision: float = MIN_PRECISION, min_positives: int = MIN_POSITIVES
) -> float | None:
    total_truth = sum(len(ep.truth) for ep in episodes)
    best = None
    for threshold in sorted({float(s) for ep in episodes for s in ep.scores}, reverse=True):
        totals = _totals(episodes, threshold)
        if totals.fp > total_truth:
            break
        if totals.tp >= min_positives and totals.precision is not None and totals.precision >= min_precision:
            best = threshold
    return best


@dataclass
class Totals:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    false_positives: list[tuple[str, int, float]] = field(default_factory=list)

    @property
    def precision(self) -> float | None:
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else None

    @property
    def recall(self) -> float | None:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else None


def _totals(episodes: list[ScoredEpisode], threshold: float) -> Totals:
    totals = Totals()
    for ep in episodes:
        chosen = _select_indices(ep.candidates, ep.scores, threshold, MIN_GAP_MS)
        cuts = [ep.candidates[i].cut_ms for i in chosen]
        hits = _matched_predictions(cuts, ep.truth, MATCH_WINDOW_MS)
        totals.tp += len(hits)
        totals.fp += len(cuts) - len(hits)
        totals.fn += len(ep.truth) - len(hits)
        totals.false_positives += [
            (ep.rel, cuts[n], float(ep.scores[chosen[n]])) for n in range(len(cuts)) if n not in hits
        ]
    return totals


def _fit_on(training: list[GtEpisode], fitter: ModelFitter) -> LogisticModel | None:
    X, y = build_training_set((e.candidates, e.X, e.truth) for e in training)
    if len(np.unique(y)) < 2:
        return None
    return fitter(X, y)


def _score(ep: GtEpisode, model: LogisticModel) -> ScoredEpisode:
    return ScoredEpisode(ep.rel, ep.candidates, model.predict(ep.X), ep.truth)


def _score_leave_one_out(show_eps: list[GtEpisode], trainable: list[GtEpisode], fitter: ModelFitter) -> tuple[list[ScoredEpisode], list[str]]:
    scored, unscorable = [], []
    for ep in show_eps:
        model = _fit_on([t for t in trainable if t is not ep], fitter)
        if model is None:
            unscorable.append(ep.rel)
        else:
            scored.append(_score(ep, model))
    return scored, unscorable


def _score_held_out(show_eps: list[GtEpisode], trainable: list[GtEpisode], fitter: ModelFitter) -> tuple[list[ScoredEpisode], list[str]]:
    if not show_eps:
        return [], []
    model = _fit_on(trainable, fitter)
    if model is None:
        return [], [e.rel for e in show_eps]
    return [_score(e, model) for e in show_eps], []


def _gate_passes(threshold: float | None, scored_count: int, loo: Totals | None, held: Totals | None) -> bool:
    if threshold is None or loo is None or held is None or scored_count < MIN_GT_EPISODES:
        return False
    return (
        held.tp >= 1
        and held.tp + held.fp >= MIN_HELD_OUT_PREDICTIONS
        and held.precision is not None
        and held.precision >= MIN_PRECISION
        and loo.precision is not None
        and loo.precision >= MIN_PRECISION
    )


def evaluate_show(show_slug: str, pool: list[GtEpisode], model_fitter: ModelFitter = LogisticModel.fit) -> ShowReport:
    show_eps = [e for e in pool if e.slug == show_slug]
    trainable = [e for e in pool if not e.held_out]
    loo, loo_unscorable = _score_leave_one_out([e for e in show_eps if not e.held_out], trainable, model_fitter)
    held, held_unscorable = _score_held_out([e for e in show_eps if e.held_out], trainable, model_fitter)
    threshold = choose_threshold(loo)
    loo_totals = _totals(loo, threshold) if threshold is not None else None
    held_totals = _totals(held, threshold) if threshold is not None else None
    return ShowReport(
        show=show_slug,
        episodes=len(show_eps),
        held_out_episodes=sum(e.held_out for e in show_eps),
        unscorable=loo_unscorable + held_unscorable,
        threshold=threshold,
        precision=loo_totals.precision if loo_totals else None,
        recall=loo_totals.recall if loo_totals else None,
        held_out_precision=held_totals.precision if held_totals else None,
        held_out_recall=held_totals.recall if held_totals else None,
        enabled=_gate_passes(threshold, len(loo) + len(held), loo_totals, held_totals),
        false_positives=sorted(
            (loo_totals.false_positives if loo_totals else []) + (held_totals.false_positives if held_totals else []),
            key=lambda fp: -fp[2],
        ),
    )


def load_gt_pool(cache: FeatureCache, roots: list[Path]) -> list[GtEpisode]:
    found = []
    for slug in _label_files():
        labels = load_labels(slug)
        for rel, entry in labels.episodes.items():
            truth = labels.ground_truth(rel, roots)
            if truth is not None:
                found.append((slug, rel, entry.held_out, next(r / rel for r in roots if (r / rel).exists()), truth))
    for _, _, _, path, _ in found:
        cache.ensure(path)
    shows: dict[Path, ShowSignals] = {}
    pool = []
    for slug, rel, held_out, path, truth in found:
        candidates, X = _episode_signals(cache, shows, rel, path)
        pool.append(GtEpisode(slug, rel, held_out, candidates, X, truth, _show_dir(rel, path)))
    return pool


@dataclass
class Evaluation:
    reports: list[ShowReport]
    model_json: str | None
    signals_keys: dict[str, str | None] = field(default_factory=dict)


@dataclass
class ShowThreshold:
    threshold: float
    signals_key: str | None


def _signals_keys(pool: list[GtEpisode], cache: FeatureCache) -> dict[str, str | None]:
    dirs: dict[str, set[Path | None]] = {}
    for e in pool:
        dirs.setdefault(e.slug, set()).add(e.show_dir)
    return {
        slug: signals_key(next(iter(found)), cache) if len(found) == 1 and None not in found else None
        for slug, found in dirs.items()
    }


def evaluate(cache: FeatureCache, roots: list[Path], model_fitter: ModelFitter = LogisticModel.fit) -> Evaluation:
    pool = load_gt_pool(cache, roots)
    reports = [evaluate_show(slug, pool, model_fitter) for slug in _label_files()]
    global_model = _fit_on([e for e in pool if not e.held_out], model_fitter)
    return Evaluation(reports, global_model.to_json() if global_model else None, _signals_keys(pool, cache))


def thresholds_path() -> Path:
    return data_dir() / "models" / "thresholds.json"


def model_sha(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()


def _parse_show_threshold(raw) -> ShowThreshold | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("threshold"), (int, float)) or "signals_key" not in raw:
        return None
    return ShowThreshold(float(raw["threshold"]), raw["signals_key"])


def load_thresholds() -> tuple[str, dict[str, ShowThreshold]]:
    dest = thresholds_path()
    if not dest.exists():
        return "", {}
    raw = json.loads(dest.read_text())
    parsed = {slug: _parse_show_threshold(v) for slug, v in raw.get("thresholds", {}).items()}
    if any(v is None for v in parsed.values()):
        return "", {}
    return raw.get("model_sha", ""), {slug: v for slug, v in parsed.items() if v is not None}


def thresholds_out_of_date(model_text: str) -> bool:
    sha, thresholds = load_thresholds()
    return bool(thresholds) and sha != model_sha(model_text)


def save_evaluation(evaluation: Evaluation) -> None:
    enabled = {
        r.show: {"threshold": r.threshold, "signals_key": evaluation.signals_keys.get(r.show)}
        for r in evaluation.reports
        if r.enabled and r.threshold is not None
    }
    sha = ""
    if evaluation.model_json is not None:
        model_path().parent.mkdir(parents=True, exist_ok=True)
        model_path().write_text(evaluation.model_json)
        sha = model_sha(evaluation.model_json)
    thresholds_path().parent.mkdir(parents=True, exist_ok=True)
    thresholds_path().write_text(json.dumps({"model_sha": sha, "thresholds": dict(sorted(enabled.items()))}, indent=2) + "\n")


def write_report(reports: list[ShowReport], cache: FeatureCache) -> Path:
    dest = cache.root.parent / "reports" / f"{datetime.date.today().isoformat()}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps([asdict(r) for r in reports], indent=2) + "\n")
    return dest


def show_dirs_to_slugs(show_dirs: list[Path]) -> list[str] | None:
    return [slugify(d.name) for d in show_dirs] if show_dirs else None


def _pct(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}"


def _mmss(ms: int) -> str:
    return f"{ms // 60_000}:{ms // 1000 % 60:02d}"


def format_table(reports: list[ShowReport], top_false_positives: int = 10) -> str:
    lines = [f"{'show':36} {'GT':>3} {'HO':>3} {'thresh':>7} {'LOO P/R':>11} {'HO P/R':>11} enabled"]
    for r in reports:
        threshold = "-" if r.threshold is None else f"{r.threshold:.3f}"
        lines.append(
            f"{r.show:36} {r.episodes:>3} {r.held_out_episodes:>3} {threshold:>7} "
            f"{_pct(r.precision) + '/' + _pct(r.recall):>11} "
            f"{_pct(r.held_out_precision) + '/' + _pct(r.held_out_recall):>11} {'yes' if r.enabled else 'no'}"
        )
        lines += [f"  unscorable: {rel}" for rel in r.unscorable]
    fps = sorted(((r.show, *fp) for r in reports for fp in r.false_positives), key=lambda x: -x[3])
    if fps:
        lines.append("top false positives:")
        lines += [f"  {show}  {rel}  {_mmss(cut)}  {score:.3f}" for show, rel, cut, score in fps[:top_false_positives]]
    return "\n".join(lines)
