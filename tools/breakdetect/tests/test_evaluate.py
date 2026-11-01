import json

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate
from breakdetect.evaluate import (
    GtEpisode,
    ScoredEpisode,
    ShowReport,
    choose_threshold,
    evaluate_show,
    format_table,
    match,
    select_breaks,
    Totals,
    _gate_passes,
    evaluate,
    load_thresholds,
    model_sha,
    save_evaluation,
)
from breakdetect.model import LogisticModel
from breakdetect.signals import SIGNAL_NAMES

HELD_OUT_MARK = 999.0


def _cand(cut_ms: int) -> Candidate:
    return Candidate(cut_ms - 500, cut_ms + 500, cut_ms, "dark", 0.0, None)


def _episode(slug: str, rel: str, held_out: bool = False, breaks: int = 6) -> GtEpisode:
    truth = [300_000 * (k + 1) for k in range(breaks)]
    cuts = sorted(truth + [t + 150_000 for t in truth])
    X = np.zeros((len(cuts), len(SIGNAL_NAMES)))
    X[:, 0] = [5.0 if c in truth else 0.0 for c in cuts]
    if held_out:
        X[:, 1] = HELD_OUT_MARK
    return GtEpisode(slug, rel, held_out, [_cand(c) for c in cuts], X, truth)


def test_match_one_to_one():
    assert match([10_000, 10_500], [10_200]) == (1, 1, 0)


def test_match_counts_missed_truth():
    assert match([10_000], [10_000, 90_000]) == (1, 0, 1)


def test_select_breaks_keeps_highest_score_within_gap():
    cands = [_cand(100_000), _cand(160_000), _cand(400_000), _cand(500_000)]
    scores = np.array([0.8, 0.9, 0.7, 0.4])
    assert select_breaks(cands, scores, 0.5) == [160_000, 400_000]
    assert select_breaks(cands, scores, 0.5, min_gap_ms=30_000) == [100_000, 160_000, 400_000]


def test_select_breaks_moves_to_earliest_cut_in_cluster():
    cands = [_cand(714_000), _cand(720_000)]
    assert select_breaks(cands, np.array([0.95, 1.0]), 0.9) == [714_000]
    assert select_breaks(cands, np.array([0.6, 1.0]), 0.9) == [714_000]
    assert select_breaks(cands, np.array([0.4, 1.0]), 0.9) == [720_000]


def test_select_breaks_ignores_earlier_cut_outside_cluster():
    cands = [_cand(710_000), _cand(720_000)]
    assert select_breaks(cands, np.array([0.95, 1.0]), 0.9, min_gap_ms=60_000) == [720_000]


def _scored(scored: list[tuple[float, bool]]) -> list[ScoredEpisode]:
    episodes = []
    for n, (score, is_true) in enumerate(scored):
        cut = 300_000
        episodes.append(ScoredEpisode(f"ep{n}", [_cand(cut)], np.array([score]), [cut] if is_true else []))
    return episodes


def test_choose_threshold_meets_precision():
    scored = _scored([(0.9, True)] * 5 + [(0.5, True), (0.4, False)] + [(0.1, False)] * 3)
    assert choose_threshold(scored) == 0.5
    assert choose_threshold(scored, min_precision=0.8) == 0.4
    assert choose_threshold(scored, min_positives=6) == 0.5
    assert choose_threshold(scored, min_positives=7) is None


def test_choose_threshold_none_when_too_few_positives():
    assert choose_threshold(_scored([(0.9, True)] * 4 + [(0.1, False)])) is None


def test_choose_threshold_none_when_precision_unreachable():
    assert choose_threshold(_scored([(0.9, True), (0.9, False)] * 5)) is None


def test_choose_threshold_counts_cluster_as_one_break():
    episodes = [ScoredEpisode(f"ep{n}", [_cand(714_000), _cand(720_000)], np.array([0.95, 1.0]), [714_000]) for n in range(5)]
    assert choose_threshold(episodes) == 0.95


def test_show_not_enabled_with_two_episodes():
    pool = [_episode("show", "show/a.mkv"), _episode("show", "show/b.mkv", held_out=True), _episode("other", "other/a.mkv")]
    report = evaluate_show("show", pool)
    assert report.episodes == 2
    assert report.held_out_precision == 1.0
    assert not report.enabled


def test_show_enabled_with_three_clean_episodes():
    pool = [_episode("show", "show/a.mkv"), _episode("show", "show/b.mkv"), _episode("show", "show/c.mkv", held_out=True)]
    report = evaluate_show("show", pool)
    assert report.threshold is not None
    assert (report.precision, report.recall) == (1.0, 1.0)
    assert (report.held_out_precision, report.held_out_recall) == (1.0, 1.0)
    assert report.enabled
    assert report.false_positives == []


def test_show_without_held_out_episode_is_not_enabled():
    pool = [_episode("show", f"show/{n}.mkv") for n in "abc"]
    assert not evaluate_show("show", pool).enabled


def test_held_out_episode_never_in_training():
    pool = [_episode("show", "show/a.mkv"), _episode("show", "show/b.mkv"), _episode("show", "show/c.mkv", held_out=True)]
    fitted = []

    def spy(X, y):
        fitted.append(X)
        return LogisticModel.fit(X, y)

    evaluate_show("show", pool, spy)
    assert len(fitted) == 3
    assert all(HELD_OUT_MARK not in X[:, 1] for X in fitted)


def test_left_out_episode_is_excluded_from_its_own_fit():
    pool = [_episode("show", "show/a.mkv", breaks=3), _episode("show", "show/b.mkv", breaks=4), _episode("show", "show/c.mkv", breaks=5)]
    rows = []
    evaluate_show("show", pool, lambda X, y: rows.append(len(X)) or LogisticModel.fit(X, y))
    assert sorted(rows) == [(3 + 4) * 2, (3 + 5) * 2, (4 + 5) * 2]


def test_episode_without_both_classes_in_refit_is_unscorable():
    report = evaluate_show("show", [_episode("show", "show/a.mkv")])
    assert report.unscorable == ["show/a.mkv"]
    assert report.threshold is None
    assert not report.enabled


def test_user_break_without_candidate_counts_against_recall():
    pool = [_episode("show", f"show/{n}.mkv") for n in "abc"] + [_episode("show", "show/d.mkv", held_out=True)]
    pool[0].truth.append(9_000_000)
    report = evaluate_show("show", pool)
    assert report.recall is not None and report.recall < 1.0
    assert report.precision == 1.0


def test_false_positives_are_reported_and_block_enabling():
    pool = [_episode("show", f"show/{n}.mkv") for n in "abc"] + [_episode("show", "show/d.mkv", held_out=True)]
    held = pool[3]
    held.truth.clear()
    report = evaluate_show("show", pool)
    assert report.held_out_precision == 0.0
    assert not report.enabled
    assert report.false_positives and report.false_positives[0][0] == "show/d.mkv"


def _patch_pool(monkeypatch, slugs, pool):
    monkeypatch.setattr("breakdetect.evaluate._label_files", lambda: slugs)
    monkeypatch.setattr("breakdetect.evaluate.load_gt_pool", lambda cache, roots: pool)


def test_thresholds_carry_model_sha_of_written_model(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    pool = [_episode("show", "show/a.mkv"), _episode("show", "show/b.mkv"), _episode("show", "show/c.mkv", held_out=True)]
    _patch_pool(monkeypatch, ["show"], pool)
    evaluation = evaluate(FeatureCache(tmp_path / "features", []), [])
    save_evaluation(evaluation)
    sha, thresholds = load_thresholds()
    assert list(thresholds) == ["show"]
    assert thresholds["show"].threshold == evaluation.reports[0].threshold
    assert sha == model_sha((tmp_path / "models" / "global.json").read_text())


def test_show_whose_labels_went_stale_loses_its_threshold(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    (tmp_path / "models").mkdir()
    (tmp_path / "models" / "thresholds.json").write_text(json.dumps({"model_sha": "old", "thresholds": {"gone": 0.7}}))
    _patch_pool(monkeypatch, ["gone"], [])
    evaluation = evaluate(FeatureCache(tmp_path / "features", []), [])
    assert evaluation.reports[0].episodes == 0 and not evaluation.reports[0].enabled
    save_evaluation(evaluation)
    assert load_thresholds()[1] == {}


def test_load_thresholds_when_file_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    assert load_thresholds() == ("", {})
    _patch_pool(monkeypatch, [], [])
    save_evaluation(evaluate(FeatureCache(tmp_path / "features", []), []))
    assert load_thresholds() == ("", {})


def test_gate_requires_loo_precision_even_when_held_out_passes():
    assert not _gate_passes(0.5, 3, Totals(tp=9, fp=1), Totals(tp=5))


def test_gate_passes_at_exactly_the_precision_floor():
    assert _gate_passes(0.5, 3, Totals(tp=19, fp=1), Totals(tp=19, fp=1))


def test_gate_counts_only_scored_episodes():
    assert not _gate_passes(0.5, 2, Totals(tp=10), Totals(tp=5))


def test_format_table_lists_shows_and_false_positives():
    r = ShowReport("show", 3, 1, [], 0.9, 1.0, 0.5, 1.0, 1.0, True, [("show/a.mkv", 125_000, 0.93)])
    text = format_table([r])
    assert "yes" in text and "show/a.mkv  2:05  0.930" in text


def test_cli_warns_and_fails_for_show_dir_without_labels(tmp_path, monkeypatch, capsys):
    from breakdetect.cli import main

    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    _patch_pool(monkeypatch, ["known"], [])
    code = main(["evaluate", str(tmp_path / "Unknown Show"), "--cache", str(tmp_path / "features")])
    assert code == 1
    assert "no label file for unknown-show" in capsys.readouterr().err


def test_gate_needs_five_held_out_predictions():
    assert not _gate_passes(0.5, 3, Totals(tp=20), Totals(tp=4))
    assert _gate_passes(0.5, 3, Totals(tp=20), Totals(tp=5))


def test_gate_blocks_on_loo_precision_below_floor_while_held_out_passes():
    assert not _gate_passes(0.5, 3, Totals(tp=18, fp=1), Totals(tp=10))


def _pool_with_held_out_breaks(breaks: int) -> list[GtEpisode]:
    return [_episode("show", f"show/{n}.mkv") for n in "ab"] + [_episode("show", "show/c.mkv", held_out=True, breaks=breaks)]


def test_show_with_four_clean_held_out_predictions_is_not_enabled():
    report = evaluate_show("show", _pool_with_held_out_breaks(4))
    assert report.held_out_precision == 1.0
    assert not report.enabled


def test_show_with_five_clean_held_out_predictions_is_enabled():
    assert evaluate_show("show", _pool_with_held_out_breaks(5)).enabled


def test_thresholds_record_the_signals_key_used_by_evaluate(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path))
    show_dir = tmp_path / "media" / "Kids" / "Show"
    pool = [_episode("show", "show/a.mkv"), _episode("show", "show/b.mkv"), _episode("show", "show/c.mkv", held_out=True)]
    for e in pool:
        e.show_dir = show_dir
    _patch_pool(monkeypatch, ["show"], pool)
    monkeypatch.setattr("breakdetect.evaluate.signals_key", lambda d, cache: f"key-of-{d.name}")
    save_evaluation(evaluate(FeatureCache(tmp_path / "features", []), []))
    assert load_thresholds()[1]["show"].signals_key == "key-of-Show"
