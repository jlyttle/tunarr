import json
from pathlib import Path

import numpy as np

from commercials.promo_filter import (
    NetworkRefs,
    add_reference,
    dhash,
    frame_hashes_args,
    hamming,
    load_refs,
    promo_score,
    promo_verdict,
)


def _grad(seed: int) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, size=(8, 9), dtype=np.uint8)


def test_dhash_identical_zero():
    g = _grad(1)
    assert hamming(dhash(g), dhash(g.copy())) == 0


def test_dhash_different_large():
    assert hamming(dhash(_grad(1)), dhash(_grad(2))) > 10


def test_endcard_match_scores_promo():
    card = dhash(_grad(1))
    refs = [NetworkRefs("xd", endcards=[card], bugs=[])]
    # 2 of the 3 last frames show the end card.
    score = promo_score([card, card, dhash(_grad(5))], [[], [], [], []], refs)
    assert score >= 0.5 and promo_verdict(score) == "network_promo"


def test_bug_in_corner_scores_promo():
    bug = dhash(_grad(3))
    refs = [NetworkRefs("xd", endcards=[], bugs=[("iw/4:ih/4:0:0", bug)])]
    noise = [dhash(_grad(i)) for i in range(10, 14)]
    score = promo_score([], [[bug, bug, bug, noise[0]], [], [], []], refs)
    assert score == 0.75 and promo_verdict(score) == "network_promo"
    # The same hash in a different corner does not match.
    assert promo_score([], [[], [bug, bug, bug], [], []], refs) == 0.0


def test_plain_ad_scores_low():
    refs = [NetworkRefs("xd", endcards=[dhash(_grad(1))], bugs=[("iw/4:ih/4:0:0", dhash(_grad(3)))])]
    ad = [dhash(_grad(i)) for i in range(20, 24)]
    score = promo_score(ad, [ad, ad, ad, ad], refs)
    assert score == 0.0 and promo_verdict(score) is None
    assert promo_score(ad, [[], [], [], []], []) == 0.0


def test_uncertain_band_rejects():
    assert promo_verdict(0.4) == "uncertain_promo"
    assert promo_verdict(0.3) == "uncertain_promo"
    assert promo_verdict(0.29) is None
    assert promo_verdict(0.5) == "network_promo"


def test_frame_hashes_args_selects_times_and_crop():
    args = frame_hashes_args("a.mkv", [1.0, 3.5], "iw/4:ih/4:0:0")
    vf = args[args.index("-vf") + 1]
    assert "select=" in vf and "crop=iw/4:ih/4:0:0" in vf and "scale=9:8" in vf
    assert args[-1] == "-" and "rawvideo" in args


def test_add_reference_roundtrip(make_clip, tmp_path: Path):
    clip = make_clip([("content", 4.0), ("bars", 2.0)])
    add_reference("Test Net", clip, tmp_path)
    data = json.loads((tmp_path / "test-net.json").read_text())
    assert data["network"] == "Test Net" and data["endcards"]
    refs = load_refs(tmp_path)
    assert len(refs) == 1 and refs[0].network == "Test Net"
    assert refs[0].endcards
    # The reference clip's own end card is recognised via the same path.
    from commercials.promo_filter import hashes_for_frames

    end = hashes_for_frames(clip, [4.6, 5.1, 5.6], None)
    assert promo_score(end, [[], [], [], []], refs) >= 0.5


def test_is_network_promo_removed():
    from commercials import promo_filter

    assert not hasattr(promo_filter, "is_network_promo")  # promo_verdict is the one threshold


def test_add_reference_keeps_only_stable_corner_hashes(tmp_path: Path, monkeypatch):
    from commercials import promo_filter as pf

    bug = dhash(_grad(3))
    near = bug ^ 0b111  # 3 bits off: the same bug under compression noise
    noise = [dhash(_grad(i)) for i in range(30, 40)]
    ends = [dhash(_grad(1))]
    bugs = [[bug, near, bug, noise[0]],  # top-left: a bug in 3 of 4 frames
            noise[1:5],                  # top-right: just picture content
            [bug, noise[5], noise[6], bug],  # bottom-left: only 2 frames agree
            noise[7:10]]
    monkeypatch.setattr(pf, "_clip_duration", lambda clip: 8.0)
    monkeypatch.setattr(pf, "segment_hashes", lambda clip, start, end: (ends, bugs))
    add_reference("Test Net", tmp_path / "clip.mkv", tmp_path)
    data = json.loads((tmp_path / "test-net.json").read_text())
    assert data["bugs"] == [["iw/4:ih/4:0:0", f"{bug:016x}"]]
