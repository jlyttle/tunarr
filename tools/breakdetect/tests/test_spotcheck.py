from breakdetect.spotcheck import load_verdicts, sample_episodes, save_verdict


def _marker(episodes: list[tuple[str, list[int]]]) -> dict:
    return {"episodes": [{"relativePath": rel, "durationMs": 1_400_000, "breaks": [{"offsetMs": ms} for ms in cuts]} for rel, cuts in episodes]}


def test_sample_skips_labelled_and_breakless_episodes():
    marker = _marker([("a.mkv", [600_000]), ("b.mkv", []), ("c.mkv", [700_000]), ("d.mkv", [710_000])])
    assert [e["rel"] for e in sample_episodes(marker, {"c.mkv"}, 5)] == ["a.mkv", "d.mkv"]


def test_sample_spreads_across_the_show():
    marker = _marker([(f"{n:02}.mkv", [600_000]) for n in range(10)])
    assert [e["rel"] for e in sample_episodes(marker, set(), 3)] == ["00.mkv", "03.mkv", "06.mkv"]


def test_verdicts_persist():
    save_verdict("show", "a.mkv", 600_000, "bad")
    save_verdict("show", "a.mkv", 700_000, "good")
    save_verdict("show", "a.mkv", 600_000, "good")
    assert load_verdicts("show") == {"a.mkv": {600_000: "good", 700_000: "good"}}
