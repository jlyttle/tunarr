from breakdetect.consistency import supported_cuts, unseen_gate_passes


def test_cut_without_neighbours_in_other_episodes_is_dropped():
    cuts = {"a": [454_000, 690_000], "b": [700_000], "c": [680_000]}
    assert supported_cuts(cuts)["a"] == [690_000]


def test_own_episode_does_not_count_as_support():
    cuts = {"a": [300_000, 310_000], "b": [300_000]}
    assert supported_cuts(cuts, min_support=2)["a"] == []


def test_support_window_is_inclusive():
    cuts = {"a": [600_000], "b": [660_000], "c": [540_000]}
    assert supported_cuts(cuts, window_ms=60_000)["a"] == [600_000]
    assert supported_cuts(cuts, window_ms=59_999)["a"] == []


def test_episode_with_several_nearby_cuts_counts_once():
    cuts = {"a": [600_000], "b": [590_000, 610_000], "c": []}
    assert supported_cuts(cuts, min_support=2)["a"] == []


def test_unseen_gate_needs_five_episodes():
    assert not unseen_gate_passes({str(n): [300_000] for n in range(4)})
    assert unseen_gate_passes({str(n): [300_000] for n in range(5)})


def test_unseen_gate_needs_half_the_episodes_to_agree():
    agreeing = {str(n): [300_000] for n in range(3)}
    assert unseen_gate_passes({**agreeing, "x": [], "y": [], "z": []})
    assert not unseen_gate_passes({**agreeing, "w": [], "x": [], "y": [], "z": []})
