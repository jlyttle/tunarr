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


def test_under_floor_in_json_and_markdown(tmp_path):
    r = sample()
    r.under_floor = {"general": 0.5}
    path = write_report(r, tmp_path)
    assert json.loads(path.read_text())["under_floor"] == {"general": 0.5}
    assert "Under the 3 h floor: general (0.50 h)" in path.with_suffix(".md").read_text()


def test_notification_quiet_on_a_clean_run():
    from commercials.report import notification

    r = sample()
    r.failures = []
    r.sync = {"kids": "updated", "general": "updated"}
    assert notification(r) is None


def test_notification_on_failure_or_under_floor_has_no_failure_text():
    from commercials.report import notification

    r = sample()
    r.failures = ["sync: RuntimeError: http://h/?X-Plex-Token=<redacted>"]
    msg = notification(r)
    assert msg is not None and "1 failure" in msg and "Token" not in msg and "http" not in msg
    r.failures = []
    r.under_floor = {"kids": 1.25}
    assert notification(r) == "kids pool under the floor (1.25 h)"


def test_notification_on_sync_not_updated():
    from commercials.report import notification

    r = sample()
    r.failures = []
    r.sync = {"kids": "tunarr_behind", "general": "updated"}
    assert notification(r) == "kids list not updated (tunarr_behind)"
    r.sync = {"status": "not_configured"}
    assert notification(r) is None
