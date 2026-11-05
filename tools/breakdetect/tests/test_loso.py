import numpy as np

from breakdetect.candidates import Candidate
from breakdetect.evaluate import GtEpisode
from breakdetect.loso import LosoReport, evaluate_unseen_show, format_loso_table, pooled
from breakdetect.model import LogisticModel
from breakdetect.signals import SIGNAL_NAMES

TARGET_MARK = 777.0


def _cand(cut_ms: int) -> Candidate:
    return Candidate(cut_ms - 500, cut_ms + 500, cut_ms, "dark", 0.0, None)


def _episode(slug: str, rel: str, breaks: int = 6, mark: float = 0.0) -> GtEpisode:
    truth = [300_000 * (k + 1) for k in range(breaks)]
    cuts = sorted(truth + [t + 150_000 for t in truth])
    X = np.zeros((len(cuts), len(SIGNAL_NAMES)))
    X[:, 0] = [5.0 if c in truth else 0.0 for c in cuts]
    X[:, 1] = mark
    return GtEpisode(slug, rel, False, [_cand(c) for c in cuts], X, truth)


def _pool(shows: str = "abc", per_show: int = 2) -> list[GtEpisode]:
    return [_episode(s, f"{s}/{n}.mkv") for s in shows for n in range(per_show)]


def test_unseen_show_scores_with_threshold_from_other_shows():
    report = evaluate_unseen_show("a", _pool())
    assert report.threshold is not None
    assert (report.precision, report.recall) == (1.0, 1.0)
    assert report.episodes == 2
    assert report.predictions == 12


def test_target_show_never_enters_any_fit():
    pool = [_episode("a", "a/0.mkv", mark=TARGET_MARK), _episode("a", "a/1.mkv", mark=TARGET_MARK)] + _pool("bcd")
    fitted = []

    def spy(X, y):
        fitted.append(X)
        return LogisticModel.fit(X, y)

    evaluate_unseen_show("a", pool, spy)
    assert len(fitted) == 1 + 3
    assert all(TARGET_MARK not in X[:, 1] for X in fitted)


def test_threshold_fits_leave_out_target_and_the_show_they_score():
    pool = [_episode(s, f"{s}/0.mkv", breaks=b) for s, b in zip("abcd", (1, 2, 3, 4))]
    rows = []
    evaluate_unseen_show("a", pool, lambda X, y: rows.append(len(X)) or LogisticModel.fit(X, y))
    assert sorted(rows) == sorted([(2 + 3 + 4) * 2, (3 + 4) * 2, (2 + 4) * 2, (2 + 3) * 2])


def test_show_with_no_other_shows_has_no_threshold():
    report = evaluate_unseen_show("a", _pool("a"))
    assert report.threshold is None
    assert report.precision is None
    assert report.predictions == 0


def test_false_cuts_on_unseen_show_are_reported():
    pool = _pool()
    for ep in pool:
        if ep.slug == "a":
            ep.truth.clear()
    report = evaluate_unseen_show("a", pool)
    assert report.precision == 0.0
    assert report.false_positives and report.false_positives[0][0].startswith("a/")


def test_pooled_sums_counts_across_shows():
    reports = [
        LosoReport("a", 2, 0.9, tp=9, fp=1, fn=2),
        LosoReport("b", 2, None, tp=0, fp=0, fn=4),
    ]
    total = pooled(reports)
    assert (total.tp, total.fp, total.fn) == (9, 1, 6)
    assert total.precision == 0.9


def test_format_loso_table_lists_shows_and_pooled_row():
    text = format_loso_table([LosoReport("a", 2, 0.9, tp=9, fp=1, fn=2, false_positives=[("a/0.mkv", 125_000, 0.97)])])
    assert "a" in text and "0.90" in text
    assert "pooled" in text
    assert "a/0.mkv  2:05  0.970" in text
