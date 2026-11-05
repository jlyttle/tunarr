from dataclasses import dataclass, field

from breakdetect.evaluate import (
    GtEpisode,
    ModelFitter,
    ScoredEpisode,
    Totals,
    _fit_on,
    _mmss,
    _pct,
    _score,
    _totals,
    choose_threshold,
)
from breakdetect.model import LogisticModel


@dataclass
class LosoReport:
    show: str
    episodes: int
    threshold: float | None
    tp: int = 0
    fp: int = 0
    fn: int = 0
    false_positives: list[tuple[str, int, float]] = field(default_factory=list)

    @property
    def predictions(self) -> int:
        return self.tp + self.fp

    @property
    def precision(self) -> float | None:
        return self.tp / self.predictions if self.predictions else None

    @property
    def recall(self) -> float | None:
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else None


def _without(pool: list[GtEpisode], *slugs: str) -> list[GtEpisode]:
    return [e for e in pool if e.slug not in slugs]


def _of(pool: list[GtEpisode], slug: str) -> list[GtEpisode]:
    return [e for e in pool if e.slug == slug]


def _score_all(episodes: list[GtEpisode], training: list[GtEpisode], fitter: ModelFitter) -> list[ScoredEpisode]:
    model = _fit_on(training, fitter)
    return [] if model is None else [_score(e, model) for e in episodes]


def _transfer_threshold(show: str, pool: list[GtEpisode], fitter: ModelFitter) -> float | None:
    others = sorted({e.slug for e in pool} - {show})
    scored = [s for other in others for s in _score_all(_of(pool, other), _without(pool, show, other), fitter)]
    return choose_threshold(scored)


def evaluate_unseen_show(show: str, pool: list[GtEpisode], fitter: ModelFitter = LogisticModel.fit) -> LosoReport:
    episodes = _of(pool, show)
    scored = _score_all(episodes, _without(pool, show), fitter)
    threshold = _transfer_threshold(show, pool, fitter)
    if threshold is None or not scored:
        return LosoReport(show, len(episodes), threshold, fn=sum(len(e.truth) for e in episodes))
    totals = _totals(scored, threshold)
    false_positives = sorted(totals.false_positives, key=lambda fp: -fp[2])
    return LosoReport(show, len(episodes), threshold, totals.tp, totals.fp, totals.fn, false_positives)


def evaluate_unseen_shows(pool: list[GtEpisode], fitter: ModelFitter = LogisticModel.fit) -> list[LosoReport]:
    return [evaluate_unseen_show(show, pool, fitter) for show in sorted({e.slug for e in pool})]


def pooled(reports: list[LosoReport]) -> Totals:
    return Totals(sum(r.tp for r in reports), sum(r.fp for r in reports), sum(r.fn for r in reports))


def format_loso_table(reports: list[LosoReport], top_false_positives: int = 15) -> str:
    lines = [f"{'show':36} {'GT':>3} {'thresh':>7} {'pred':>5} {'P':>5} {'R':>5}"]
    for r in reports:
        threshold = "-" if r.threshold is None else f"{r.threshold:.3f}"
        lines.append(f"{r.show:36} {r.episodes:>3} {threshold:>7} {r.predictions:>5} {_pct(r.precision):>5} {_pct(r.recall):>5}")
    total = pooled(reports)
    lines.append(f"{'pooled':36} {sum(r.episodes for r in reports):>3} {'':>7} {total.tp + total.fp:>5} {_pct(total.precision):>5} {_pct(total.recall):>5}")
    fps = sorted(((r.show, *fp) for r in reports for fp in r.false_positives), key=lambda x: -x[3])
    if fps:
        lines.append("top false positives:")
        lines += [f"  {show}  {rel}  {_mmss(cut)}  {score:.3f}" for show, rel, cut, score in fps[:top_false_positives]]
    return "\n".join(lines)
