from collections.abc import Callable
from dataclasses import dataclass, field

from breakdetect.consistency import supported_cuts, unseen_gate_passes
from breakdetect.evaluate import (
    GtEpisode,
    ModelFitter,
    Totals,
    _fit_on,
    _mmss,
    _pct,
    select_breaks,
    unseen_threshold,
)
from breakdetect.model import LogisticModel
from breakdetect.showsignals import ShowSignals
from breakdetect.train import MATCH_WINDOW_MS, _matched_predictions

SiblingLoader = Callable[[list[GtEpisode]], ShowSignals]


@dataclass
class LosoReport:
    show: str
    episodes: int
    threshold: float | None
    raw: Totals = field(default_factory=Totals)
    consistent: Totals = field(default_factory=Totals)
    gated: bool = False


def _without(pool: list[GtEpisode], *slugs: str) -> list[GtEpisode]:
    return [e for e in pool if e.slug not in slugs]


def _of(pool: list[GtEpisode], slug: str) -> list[GtEpisode]:
    return [e for e in pool if e.slug == slug]


def gt_siblings(episodes: list[GtEpisode]) -> ShowSignals:
    return {e.rel: (e.candidates, e.X) for e in episodes}


def _transfer_threshold(show: str, pool: list[GtEpisode], fitter: ModelFitter) -> float | None:
    return unseen_threshold(_without(pool, show), fitter)


def _cuts(signals: ShowSignals, model: LogisticModel, threshold: float) -> dict[str, list[int]]:
    return {rel: select_breaks(c, model.predict(X), threshold) if len(c) else [] for rel, (c, X) in signals.items()}


def _cut_scores(episode: GtEpisode, model: LogisticModel) -> dict[int, float]:
    scores = model.predict(episode.X) if len(episode.candidates) else []
    return {c.cut_ms: float(s) for c, s in zip(episode.candidates, scores)}


def _cut_totals(episodes: list[GtEpisode], cuts: dict[str, list[int]], model: LogisticModel) -> Totals:
    totals = Totals()
    for ep in episodes:
        predicted = cuts.get(ep.rel, [])
        hits = _matched_predictions(predicted, ep.truth, MATCH_WINDOW_MS)
        scores = _cut_scores(ep, model)
        totals.tp += len(hits)
        totals.fp += len(predicted) - len(hits)
        totals.fn += len(ep.truth) - len(hits)
        totals.false_positives += [(ep.rel, c, scores[c]) for n, c in enumerate(predicted) if n not in hits]
    totals.false_positives.sort(key=lambda fp: -fp[2])
    return totals


def evaluate_unseen_show(
    show: str, pool: list[GtEpisode], fitter: ModelFitter = LogisticModel.fit, siblings: SiblingLoader = gt_siblings
) -> LosoReport:
    episodes = _of(pool, show)
    model = _fit_on(_without(pool, show), fitter)
    threshold = _transfer_threshold(show, pool, fitter)
    if model is None or threshold is None:
        missed = Totals(fn=sum(len(e.truth) for e in episodes))
        return LosoReport(show, len(episodes), threshold, missed, missed)
    own = _cuts(gt_siblings(episodes), model, threshold)
    consistent = supported_cuts({**_cuts(siblings(episodes), model, threshold), **own})
    return LosoReport(
        show,
        len(episodes),
        threshold,
        _cut_totals(episodes, own, model),
        _cut_totals(episodes, consistent, model),
        unseen_gate_passes(consistent),
    )


def evaluate_unseen_shows(
    pool: list[GtEpisode], fitter: ModelFitter = LogisticModel.fit, siblings: SiblingLoader = gt_siblings
) -> list[LosoReport]:
    return [evaluate_unseen_show(show, pool, fitter, siblings) for show in sorted({e.slug for e in pool})]


def pooled(totals: list[Totals]) -> Totals:
    return Totals(sum(t.tp for t in totals), sum(t.fp for t in totals), sum(t.fn for t in totals))


def _columns(t: Totals) -> str:
    return f"{t.tp + t.fp:>5} {_pct(t.precision):>5} {_pct(t.recall):>5}"


def format_loso_table(reports: list[LosoReport], top_false_positives: int = 15) -> str:
    lines = [
        f"{'':48} {'---- raw ----':>17} {'- consistent -':>17}",
        f"{'show':36} {'GT':>3} {'thresh':>7} {'pred':>5} {'P':>5} {'R':>5} {'pred':>5} {'P':>5} {'R':>5} gate",
    ]
    for r in reports:
        threshold = "-" if r.threshold is None else f"{r.threshold:.3f}"
        gate = "on" if r.gated else "off"
        lines.append(f"{r.show:36} {r.episodes:>3} {threshold:>7} {_columns(r.raw)} {_columns(r.consistent)} {gate}")
    raw, consistent = pooled([r.raw for r in reports]), pooled([r.consistent for r in reports])
    lines.append(f"{'pooled':36} {sum(r.episodes for r in reports):>3} {'':>7} {_columns(raw)} {_columns(consistent)}")
    gated = [r for r in reports if r.gated]
    lines.append(
        f"{'pooled, gate on':36} {sum(r.episodes for r in gated):>3} {'':>7} "
        f"{_columns(pooled([r.raw for r in gated]))} {_columns(pooled([r.consistent for r in gated]))}"
    )
    fps = sorted(((r.show, *fp) for r in reports for fp in r.consistent.false_positives), key=lambda x: -x[3])
    if fps:
        lines.append("false positives after the consistency check:")
        lines += [f"  {show}  {rel}  {_mmss(cut)}  {score:.3f}" for show, rel, cut, score in fps[:top_false_positives]]
    return "\n".join(lines)
