import json

from commercials.report import Report, write_report


def sample() -> Report:
    return Report(
        added=["a1", "a2"],
        retired=["old"],
        rejected_by_reason={"nonstandard_length": 3, "network_promo": 1},
        pool_hours={"kids": 3.25, "general": 0.5},
        failures=["vid9: download failed"],
        started="2026-11-22T04:00:00",
        compilations=[{"video_id": "v1", "title": "Vol. 1", "status": "split",
                       "segments": 5, "accepted": 2, "promo_dropped": 1, "promo_scored": 3}],
        uptime_before="04:00 up 1 day, load average: 0.5",
        sync={"status": "not_configured"},
    )


def test_report_markdown_has_pool_hours(tmp_path):
    path = write_report(sample(), tmp_path)
    md = path.with_suffix(".md").read_text()
    assert "| kids | 3.25 |" in md
    assert "| general | 0.50 |" in md
    assert "nonstandard_length" in md
    assert "vid9: download failed" in md
    assert "not_configured" in md


def test_report_json_round_trips(tmp_path):
    path = write_report(sample(), tmp_path)
    assert path.suffix == ".json"
    assert path.name.startswith("2026-11-22T040000")
    data = json.loads(path.read_text())
    assert data["added"] == ["a1", "a2"]
    assert data["rejected_by_reason"]["network_promo"] == 1
    assert data["pool_hours"]["kids"] == 3.25
    assert Report.from_json(data) == sample()


def test_report_never_overwrites(tmp_path):
    a = write_report(sample(), tmp_path)
    b = write_report(sample(), tmp_path)
    assert a != b and a.exists() and b.exists()
