import json
import plistlib
import random
import subprocess
from datetime import date
from pathlib import Path

import pytest

from commercials.catalog import Compilation, load_catalog, save_catalog
from commercials.deliver import DeliveryPlan
from commercials.encode import StreamInfo
from commercials.runner import RunContext, RunOptions, Tools, run, sync_configured

TODAY = date(2026, 11, 22)
ROOT = Path(__file__).resolve().parent.parent

# Two cut points: segments 0-9.9 (10 s), 10.1-30.1 (20 s), 30.2-40.2 (10 s).
GAPS = [(9.9, 10.1), (30.1, 30.2)]
DURATION = 40.2


def detect_stderr(gaps):
    lines = []
    for a, b in gaps:
        lines.append(f"[blackdetect @ 0x1] black_start:{a} black_end:{b} black_duration:{b - a:.3f}")
        lines.append(f"[silencedetect @ 0x2] silence_start: {a}")
        lines.append(f"[silencedetect @ 0x2] silence_end: {b} | silence_duration: {b - a:.3f}")
    return "\n".join(lines)


def fp_of(content):
    rng = random.Random(content)
    return [rng.getrandbits(32) for _ in range(60)]


class Fakes:
    """Records every side effect the runner asks for."""

    def __init__(self, comps, fail_download=(), chapters=None, info=None, no_audio=(), probe_fail=(),
                 scores=None, info_extra=None, fail_cut=()):
        self.comps = comps
        self.fail_download = set(fail_download)
        self.chapters = chapters or {}
        self.info = info or StreamInfo(True, 1920, 1080)
        self.no_audio = set(no_audio)
        self.probe_fail = set(probe_fail)
        self.scores = scores or {}
        self.info_extra = info_extra or {}
        self.fail_cut = set(fail_cut)
        self.downloads, self.cuts, self.encodes, self.volume_calls = [], [], [], []
        self.deliveries, self.syncs, self.uptimes, self.removes = [], [], [], []

    def tools(self) -> Tools:
        return Tools(
            discover=self.discover, download=self.download, duration=lambda p: DURATION,
            detect=lambda p: detect_stderr(GAPS), cut=self.cut, promo_score=self.promo_score,
            probe=self.probe, mean_volume=self.mean_volume, loudness=self.loudness,
            encode=self.encode, fingerprint=self.fingerprint, uptime=self.uptime,
            deliver=self.deliver, sync=self.sync, remove=self.remove,
        )

    def discover(self, sources, catalog, since):
        return [c for c in self.comps if c.video_id not in catalog.compilations]

    def download(self, video_id, dest):
        self.downloads.append(video_id)
        if video_id in self.fail_download:
            raise subprocess.CalledProcessError(1, ["yt-dlp", video_id])
        dest.mkdir(parents=True, exist_ok=True)
        mkv = dest / f"{video_id}.mkv"
        mkv.write_bytes(b"video")
        chapters = self.chapters.get(video_id, [])
        info = {"id": video_id, "chapters": chapters, **self.info_extra.get(video_id, {})}
        (dest / f"{video_id}.info.json").write_text(json.dumps(info))
        return mkv

    def cut(self, src, seg, dest):
        self.cuts.append((src.stem, seg.start, Path(dest)))
        if (src.stem, round(seg.start, 1)) in self.fail_cut:
            Path(dest).write_bytes(b"partial")
            raise subprocess.CalledProcessError(1, ["ffmpeg"])
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(f"{src.stem}-{seg.start}".encode())

    def promo_score(self, path, start, end):
        return self.scores.get((Path(path).stem, round(start, 1)), 0.0)

    def probe(self, path):
        key = Path(path).read_text()
        if key in self.probe_fail:
            raise subprocess.CalledProcessError(1, ["ffprobe"])
        if key in self.no_audio:
            return StreamInfo(False, self.info.width, self.info.height)
        return self.info

    def mean_volume(self, path):
        self.volume_calls.append(Path(path).read_text())
        return -20.0

    def loudness(self, path):
        return {"input_i": "-18", "input_tp": "-1", "input_lra": "5", "input_thresh": "-28",
                "target_offset": "0"}

    def encode(self, src, dest, measured):
        self.encodes.append(Path(dest))
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_text(Path(src).read_text())

    def fingerprint(self, path):
        return fp_of(Path(path).read_text())

    def uptime(self):
        self.uptimes.append(1)
        return f"up {len(self.uptimes)}"

    def deliver(self, catalog, active, root):
        self.deliveries.append(root)
        plan = DeliveryPlan()
        for pool, ids in active.items():
            for ad_id in ids:
                remote = f"{root}/{pool}/{ad_id}.mp4"
                catalog.ads[ad_id].delivered[pool] = remote
                plan.push.append((ad_id, pool, remote))
        return plan

    def remove(self, catalog, remotes):
        self.removes.append(list(remotes))
        gone = set(remotes)
        for ad in catalog.ads.values():
            for pool in [p for p, r in ad.delivered.items() if r in gone]:
                del ad.delivered[pool]
        return list(remotes)

    def sync(self, cfg, catalog, active):
        self.syncs.append(sorted(active))
        return {"kids": "updated", "general": "updated"}


def comp(vid, title="2026 Commercials Vol. 1", pools=("general",), day=20):
    return Compilation(vid, title, date(2026, 11, day), set(pools), "new")


def config_dir(tmp_path, configured=False, refs=("nickelodeon",)):
    d = tmp_path / "config"
    (d / "network_refs").mkdir(parents=True)
    for slug in refs:
        (d / "network_refs" / f"{slug}.json").write_text("{}")
    (d / "networks.json").write_text((ROOT / "config" / "networks.json").read_text())
    src = json.loads((ROOT / "config" / "sources.json").read_text())
    if configured:
        src["filler_list_ids"] = {"kids": "LK", "general": "LG"}
        src["tunarr"]["media_source_id"] = "MS"
        src["tunarr"]["libraries"] = {"kids": "LIBK", "general": "LIBG"}
    (d / "sources.json").write_text(json.dumps(src))
    (d / "blocklist.json").write_text(json.dumps({"keywords": ["beer"]}))
    return d


def ctx(tmp_path, configured=False, refs=("nickelodeon",)):
    return RunContext(media=tmp_path / "media", state=tmp_path / "state",
                      config_dir=config_dir(tmp_path, configured, refs), today=TODAY)


def run_with(tmp_path, fakes, configured=False, refs=("nickelodeon",), **opts):
    c = ctx(tmp_path, configured, refs)
    report = run(RunOptions(**opts), c, fakes.tools())
    return c, report


def test_dry_run_touches_nothing(tmp_path):
    c = ctx(tmp_path)
    save_catalog(load_catalog(Path("/nonexistent")), c.state / "catalog.json")
    before = (c.state / "catalog.json").read_bytes()
    fakes = Fakes([comp("v1"), comp("v2")])
    run(RunOptions(dry_run=True), c, fakes.tools())
    assert fakes.downloads == [] and fakes.cuts == [] and fakes.encodes == []
    assert fakes.deliveries == [] and fakes.syncs == [] and fakes.uptimes == []
    assert (c.state / "catalog.json").read_bytes() == before
    assert not (c.state / "reports").exists()
    assert not c.media.exists()


def test_failure_in_one_compilation_continues(tmp_path):
    fakes = Fakes([comp("v1", day=21), comp("bad", day=20), comp("v3", day=19)], fail_download={"bad"})
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert fakes.downloads == ["v1", "bad", "v3"]
    assert any(f.startswith("bad:") for f in report.failures)
    statuses = {x["video_id"]: x["status"] for x in report.compilations}
    assert statuses == {"v1": "split", "bad": "failed", "v3": "split"}
    cat = load_catalog(c.state / "catalog.json")
    assert cat.compilations["bad"].status == "failed"
    assert cat.compilations["v1"].status == "split"
    assert len(report.added) == 6
    assert report.pool_hours["general"] == pytest.approx(80 / 3600, abs=0.01)
    reports = list((c.state / "reports").glob("*.json"))
    assert len(reports) == 1


def test_accepted_ads_are_encoded_and_cuts_removed(tmp_path):
    fakes = Fakes([comp("v1")])
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    cat = load_catalog(c.state / "catalog.json")
    assert len(cat.ads) == 3
    for ad in cat.ads.values():
        assert Path(ad.local_path).exists()
        assert Path(ad.local_path).parent == c.media / "ads"
        assert ad.pools == {"general"}
        assert ad.sources == ["v1"]
    assert not list((c.media / "cuts").glob("*"))


def test_second_run_dedupes_and_skips_reencode(tmp_path):
    fakes = Fakes([comp("v1")])
    c, _ = run_with(tmp_path, fakes, deliver=False, sync=False)
    # the same compilation re-uploaded under a new id carries the same ads
    fakes2 = Fakes([comp("v2")])
    fakes2.fingerprint = lambda p: fp_of(Path(p).read_text().replace("v2", "v1"))
    report = run(RunOptions(deliver=False, sync=False), c, fakes2.tools())
    cat = load_catalog(c.state / "catalog.json")
    assert len(cat.ads) == 3
    assert report.added == []
    assert fakes2.encodes == []
    assert all(sorted(a.sources) == ["v1", "v2"] for a in cat.ads.values())

    assert len(list((c.state / "reports").glob("*.json"))) == 2  # same-second runs keep both


def test_rejected_segments_kept_with_reason(tmp_path):
    fakes = Fakes([comp("v1")])
    global GAPS
    saved = GAPS
    GAPS = [(9.9, 10.1), (25.0, 25.2)]  # 0-9.9 ok, 10.1-25.0 (14.9 -> 15 ok), 25.2-40.2 (15 ok)
    try:
        fakes.scores = {("v1", 10.1): 0.9, ("v1", 25.2): 0.4}
        c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    finally:
        GAPS = saved
    assert report.rejected_by_reason == {"network_promo": 1, "uncertain_promo": 1}
    assert (c.media / "rejected" / "network_promo" / "v1-10.100.mkv").exists()
    assert (c.media / "rejected" / "uncertain_promo" / "v1-25.200.mkv").exists()
    assert len(report.added) == 1
    row = report.compilations[0]
    assert row["promo_dropped"] == 2 and row["promo_scored"] == 3


def test_nonstandard_segment_rejected(tmp_path):
    global GAPS
    saved = GAPS
    GAPS = [(9.9, 10.1), (27.0, 27.2)]  # 10.1-27.0 is 16.9 s
    try:
        fakes = Fakes([comp("v1")])
        c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    finally:
        GAPS = saved
    assert report.rejected_by_reason == {"nonstandard_length": 2}  # 16.9 s and 13.0 s
    assert (c.media / "rejected" / "nonstandard_length" / "v1-10.100.mkv").exists()


def test_single_chapter_rule_skips_generic_general(tmp_path):
    # no chapters at all: kids compilations reject everything, generic general ones don't care
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",)), comp("g1")])
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.rejected_by_reason == {"no_chapters": 3}
    assert report.pool_hours["kids"] == 0
    assert report.pool_hours["general"] == pytest.approx(40 / 3600, abs=0.001)


def test_kids_chapters_and_blocklist(tmp_path):
    chapters = [
        {"start_time": 0, "end_time": 10, "title": "Toy commercial"},
        {"start_time": 10, "end_time": 30, "title": "Cereal commercial"},
        {"start_time": 30, "end_time": 40.2, "title": "Light Beer commercial"},
    ]
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",))], chapters={"k1": chapters})
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    cat = load_catalog(c.state / "catalog.json")
    pools = sorted(sorted(a.pools) for a in cat.ads.values())
    # titles lag a chapter, so the segment before the beer chapter is blocked too
    assert pools == [["general"], ["general"], ["kids"]]


def test_no_audio_rejects_before_volumedetect(tmp_path):
    fakes = Fakes([comp("v1")], no_audio={"v1-0.0"}, probe_fail={"v1-10.1"})
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.rejected_by_reason == {"no_audio": 1, "probe_failed": 1}
    assert "v1-0.0" not in fakes.volume_calls and "v1-10.1" not in fakes.volume_calls
    assert (c.media / "rejected" / "no_audio" / "v1-0.000.mkv").exists()
    assert (c.media / "rejected" / "probe_failed" / "v1-10.100.mkv").exists()


def test_limit_caps_compilations(tmp_path):
    fakes = Fakes([comp(f"v{i}", day=10 + i) for i in range(5)])
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False, limit=2)
    assert fakes.downloads == ["v4", "v3"]  # newest first
    assert len(report.compilations) == 2


def test_deliver_and_sync_not_configured(tmp_path):
    fakes = Fakes([comp("v1")])
    _, report = run_with(tmp_path, fakes)
    assert len(fakes.deliveries) == 1
    assert fakes.syncs == []
    assert report.sync == {"status": "not_configured"}
    assert report.uptime_before == "up 1" and report.uptime_after == "up 2"
    assert report.delivery["pushed"] == 3


def test_sync_runs_when_configured(tmp_path):
    fakes = Fakes([comp("v1")])
    _, report = run_with(tmp_path, fakes, configured=True)
    assert fakes.syncs == [["general", "kids"]]
    assert report.sync == {"kids": "updated", "general": "updated"}


def test_no_deliver_skips_uptime_and_delivery(tmp_path):
    fakes = Fakes([comp("v1")])
    _, report = run_with(tmp_path, fakes, deliver=False)  # sync on but not configured
    assert fakes.deliveries == [] and fakes.uptimes == []
    assert report.uptime_before is None


def test_uptime_checked_when_only_sync_runs(tmp_path):
    fakes = Fakes([comp("v1")])
    _, report = run_with(tmp_path, fakes, configured=True, deliver=False)
    assert fakes.deliveries == []
    assert len(fakes.syncs) == 1
    assert report.uptime_before == "up 1" and report.uptime_after == "up 2"


def test_cli_sync_uses_the_local_source_libraries(monkeypatch):
    from commercials import cli
    from commercials import tunarr_sync as ts
    from commercials.catalog import Ad, Catalog

    calls = []

    class Client:
        def __init__(self, base_url):
            calls.append(("client", base_url))

        def scan_library(self, media_source_id, library_id):
            calls.append(("scan", media_source_id, library_id))

        def library_programs(self, library_id):
            calls.append(("search", library_id))
            return [{"uuid": "u1", "title": "a1", "duration": 1,
                     "mediaItem": {"locations": [{"path": f"/data/x/{library_id}/a1.mp4"}]}}]

        def put_filler(self, list_id, programs):
            calls.append(("put", list_id, [p["uuid"] for p in programs]))

    monkeypatch.setattr(ts, "TunarrClient", Client)
    catalog = Catalog()
    catalog.ads["a1"] = Ad("a1", "fp", 30.0, {"kids", "general"}, date(2026, 11, 1), date(2026, 11, 1),
                           ["v1"], "/l/a1.mp4",
                           {"kids": "/r/kids/a1.mp4", "general": "/r/general/a1.mp4"}, "active")
    cfg = {"tunarr": {"base_url": "http://x/api", "media_source_id": "M",
                      "libraries": {"kids": "LK", "general": "LG"}},
           "filler_list_ids": {"kids": "K", "general": "G"}}
    out = cli._sync(cfg, catalog, {"kids": {"a1"}, "general": {"a1"}})
    assert out == {"general": "updated", "kids": "updated"}
    assert ("scan", "M", "LK") in calls and ("scan", "M", "LG") in calls
    assert ("put", "K", ["u1"]) in calls and ("put", "G", ["u1"]) in calls
    assert not any("plex" in str(c).lower() for c in calls)


@pytest.mark.parametrize("change", [
    {"filler_list_ids": {"kids": "K", "general": None}},
    {"tunarr": {"base_url": "b", "media_source_id": None, "libraries": {"kids": "LK", "general": "LG"}}},
    {"tunarr": {"base_url": "b", "media_source_id": "M", "libraries": {"kids": "LK", "general": None}}},
    {"tunarr": {"base_url": "b", "media_source_id": "M"}},
])
def test_sync_configured_needs_source_both_libraries_and_both_lists(change):
    cfg = {"filler_list_ids": {"kids": "K", "general": "G"},
           "tunarr": {"base_url": "b", "media_source_id": "M", "libraries": {"kids": "LK", "general": "LG"}}}
    assert sync_configured(cfg)
    assert not sync_configured({**cfg, **change})


def test_shipped_sources_config_has_no_plex_and_is_not_configured():
    src = json.loads((ROOT / "config" / "sources.json").read_text())
    assert "plex" not in src
    assert src["tunarr"]["libraries"] == {"kids": None, "general": None}
    assert src["tunarr"]["container_root"] == "/data/Videos/Modern Commercials"
    assert src["unraid_root"] == "/mnt/user/plex/Videos/Modern Commercials"
    assert not sync_configured(src)


KIDS_TITLES = {"block": "Light Beer commercial", "clean": "Toy commercial"}


def kids_chapters(kind):
    t = KIDS_TITLES[kind]
    return [{"start_time": 0, "end_time": 10, "title": t}, {"start_time": 10, "end_time": 30, "title": t},
            {"start_time": 30, "end_time": 40.2, "title": t}]


def _sticky_run(tmp_path, first, second):
    comps = [comp(first, "Vol. 1 (Nickelodeon)", pools=("kids",), day=21),
             comp(second, "Vol. 2 (Nickelodeon)", pools=("kids",), day=20)]
    chapters = {v: kids_chapters(v) for v in (first, second)}
    fakes = Fakes(comps, chapters=chapters)
    # both compilations carry the same three ads
    fakes.fingerprint = lambda p: fp_of(Path(p).read_text().replace("block", "X").replace("clean", "X"))
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert [r["video_id"] for r in report.compilations] == [first, second]
    return load_catalog(c.state / "catalog.json")


def test_kids_block_sticky_block_then_clean(tmp_path):
    cat = _sticky_run(tmp_path, "block", "clean")
    assert len(cat.ads) == 3
    for a in cat.ads.values():
        assert a.pools == {"general"} and a.kids_blocked
        assert sorted(a.sources) == ["block", "clean"]


def test_kids_block_sticky_clean_then_block(tmp_path):
    cat = _sticky_run(tmp_path, "clean", "block")
    assert len(cat.ads) == 3
    for a in cat.ads.values():
        assert a.pools == {"general"} and a.kids_blocked


def test_chapters_dropped_when_duration_mismatch(tmp_path):
    chapters = kids_chapters("clean")
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",), day=21), comp("g1", day=20)],
                  chapters={"k1": chapters, "g1": chapters},
                  info_extra={"k1": {"duration": 45}, "g1": {"duration": 45}})
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.chapters_unreliable == ["k1", "g1"]
    assert report.rejected_by_reason == {"no_chapters": 3}  # kids: no chapters to trust
    assert report.pool_hours["general"] == pytest.approx(40 / 3600, abs=0.001)


def test_chapters_dropped_when_sponsorblock_removed(tmp_path):
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",))],
                  chapters={"k1": kids_chapters("clean")},
                  info_extra={"k1": {"duration": 40, "sponsorblock_chapters": [
                      {"start_time": 1, "end_time": 3, "category": "sponsor"}]}})
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.chapters_unreliable == ["k1"]
    assert report.rejected_by_reason == {"no_chapters": 3}


def test_chapters_kept_when_duration_matches(tmp_path):
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",))],
                  chapters={"k1": kids_chapters("clean")}, info_extra={"k1": {"duration": 40}})
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.chapters_unreliable == []
    assert report.rejected_by_reason == {}


def test_source_mkv_removed_after_split(tmp_path):
    fakes = Fakes([comp("v1")])
    c, _ = run_with(tmp_path, fakes, deliver=False, sync=False)
    dl = c.media / "downloads"
    assert not (dl / "v1.mkv").exists()
    assert (dl / "v1.info.json").exists()


def test_rejected_pruned_after_14_days(tmp_path):
    import os
    import time

    c = ctx(tmp_path)
    d = c.media / "rejected" / "nonstandard_length"
    d.mkdir(parents=True)
    old, fresh = d / "old.mkv", d / "fresh.mkv"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    now = time.time()
    os.utime(old, (now - 15 * 86400, now - 15 * 86400))
    os.utime(fresh, (now - 13 * 86400, now - 13 * 86400))
    run(RunOptions(dry_run=True), c, Fakes([]).tools())
    assert old.exists()  # dry run deletes nothing
    run(RunOptions(deliver=False, sync=False), c, Fakes([]).tools())
    assert not old.exists() and fresh.exists()


def test_cut_failure_is_a_rejection(tmp_path):
    fakes = Fakes([comp("v1")], fail_cut={("v1", 10.1)})
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.failures == []
    assert report.rejected_by_reason == {"cut_failed": 1}
    assert report.compilations[0]["status"] == "split"
    assert len(report.added) == 2
    assert not (c.media / "cuts" / "v1-10.100.mkv").exists()


def test_sync_error_is_a_failure_not_a_crash(tmp_path):
    fakes = Fakes([comp("v1")])

    def boom(cfg, catalog, active):
        raise RuntimeError("tunarr down")

    fakes.sync = boom
    _, report = run_with(tmp_path, fakes, configured=True)
    assert any("sync" in f and "tunarr down" in f for f in report.failures)
    assert report.uptime_after == "up 2"


def test_launchd_plist():
    with open(ROOT / "launchd" / "com.tunarr.commercials.plist", "rb") as f:
        p = plistlib.load(f)
    assert p["Label"] == "com.tunarr.commercials"
    app = "/Users/jon/.local/share/tunarr-commercials/app/tools/commercials"
    assert p["ProgramArguments"] == [f"{app}/launchd/run-daily.sh"]
    assert p["WorkingDirectory"] == app
    assert "/Users/jon/Projects/tunarr" not in json.dumps(p)  # never the main checkout
    assert p["StartCalendarInterval"] == {"Hour": 4, "Minute": 0}
    assert p["StandardOutPath"].endswith("Library/Logs/tunarr-commercials.log")
    assert p["StandardErrorPath"] == p["StandardOutPath"]


def test_per_network_compilation_without_refs_is_skipped(tmp_path):
    fakes = Fakes([comp("cc1", "Vol. 1 (Comedy Central)")])
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert fakes.downloads == []
    assert report.compilations == [{"video_id": "cc1", "title": "Vol. 1 (Comedy Central)",
                                    "pools": ["general"], "status": "skipped",
                                    "reason": "no_network_refs", "networks": ["comedy-central"]}]
    assert report.needs_network_refs == {"comedy-central": 1}
    assert load_catalog(c.state / "catalog.json").compilations["cc1"].status == "skipped"


def test_skipped_compilation_not_retried_until_refs_appear(tmp_path):
    fakes = Fakes([comp("cc1", "Vol. 1 (Comedy Central)")])
    c, _ = run_with(tmp_path, fakes, deliver=False, sync=False)
    again = run(RunOptions(deliver=False, sync=False), c, fakes.tools())
    assert fakes.downloads == []
    assert again.compilations == []  # reported once, when it was skipped
    assert again.needs_network_refs == {"comedy-central": 1}
    (c.config_dir / "network_refs" / "comedy-central.json").write_text("{}")
    third = run(RunOptions(deliver=False, sync=False), c, fakes.tools())
    assert fakes.downloads == ["cc1"]
    assert third.compilations[0]["status"] == "split"
    assert third.needs_network_refs == {}


def test_kids_compilation_naming_two_networks_needs_refs_for_both(tmp_path):
    fakes = Fakes([comp("k1", "Nick and Disney XD Commercials", pools=("kids",))])
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False, refs=("nickelodeon",))
    assert fakes.downloads == []
    assert report.compilations[0]["networks"] == ["disney-xd", "nickelodeon"]


def test_single_chapter_rule_applies_to_per_network_general(tmp_path):
    fakes = Fakes([comp("cc1", "Vol. 1 (Comedy Central)", day=21), comp("g1")])
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False, refs=("comedy-central",))
    assert report.rejected_by_reason == {"no_chapters": 3}
    assert report.pool_hours["general"] == pytest.approx(40 / 3600, abs=0.001)


def test_single_chapter_rule_applies_to_generic_kids(tmp_path):
    fakes = Fakes([comp("k1", "Kids Commercials Vol. 9", pools=("kids",))])
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.rejected_by_reason == {"no_chapters": 3}


def test_promo_chapter_text_rejects(tmp_path):
    chapters = [
        {"start_time": 0, "end_time": 10, "title": "Toy commercial"},
        {"start_time": 10, "end_time": 30, "title": "Cereal commercial"},
        {"start_time": 30, "end_time": 40.2, "title": "SpongeBob promo"},
    ]
    fakes = Fakes([comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",))], chapters={"k1": chapters})
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    # titles lag a chapter, so the segment before the promo chapter is rejected too
    assert report.rejected_by_reason == {"promo_chapter_text": 2}
    assert len(report.added) == 1
    assert (c.media / "rejected" / "promo_chapter_text" / "k1-30.200.mkv").exists()


def test_network_name_in_chapter_text_rejects_generic_too(tmp_path):
    chapters = [
        {"start_time": 0, "end_time": 10, "title": "Toy commercial"},
        {"start_time": 10, "end_time": 30, "title": "Cereal commercial"},
        {"start_time": 30, "end_time": 40.2, "title": "Comedy Central"},
    ]
    fakes = Fakes([comp("g1")], chapters={"g1": chapters})
    _, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert report.rejected_by_reason == {"promo_chapter_text": 2}


def test_blocklist_hit_on_general_sighting_blocks_kids(tmp_path):
    beer = [{"start_time": 0, "end_time": 10, "title": "Light Beer commercial"},
            {"start_time": 10, "end_time": 30, "title": "Light Beer commercial"},
            {"start_time": 30, "end_time": 40.2, "title": "Light Beer commercial"}]
    comps = [comp("g1", day=21), comp("k1", "Vol. 2 (Nickelodeon)", pools=("kids",), day=20)]
    fakes = Fakes(comps, chapters={"g1": beer, "k1": kids_chapters("clean")})
    fakes.fingerprint = lambda p: fp_of(Path(p).read_text().replace("g1", "X").replace("k1", "X"))
    c, report = run_with(tmp_path, fakes, deliver=False, sync=False)
    cat = load_catalog(c.state / "catalog.json")
    assert len(cat.ads) == 3
    for a in cat.ads.values():
        assert a.kids_blocked and a.pools == {"general"}


def test_add_ref_resolves_network_to_its_config_slug(monkeypatch, tmp_path):
    from commercials import cli

    calls = []
    monkeypatch.setattr(cli.promo, "add_reference", lambda net, clip, d: calls.append((net, d.name)))
    monkeypatch.setattr(cli, "config_dir", lambda: ROOT / "config")
    assert cli.main(["add-ref", "nickelodeon", str(tmp_path / "c.mkv")]) == 0
    assert cli.main(["add-ref", "Disney XD", str(tmp_path / "c.mkv")]) == 0
    assert calls == [("Nickelodeon", "network_refs"), ("Disney XD", "network_refs")]


def test_add_ref_refuses_unknown_network(monkeypatch, tmp_path, capsys):
    from commercials import cli

    monkeypatch.setattr(cli.promo, "add_reference", lambda *a: pytest.fail("not expected"))
    monkeypatch.setattr(cli, "config_dir", lambda: ROOT / "config")
    assert cli.main(["add-ref", "Nick", str(tmp_path / "c.mkv")]) == 2
    assert "nickelodeon" in capsys.readouterr().err


RET_ROOT = "/mnt/user/plex/Videos/Modern Commercials"


def _seed_retired(c, kids_blocked=False, pools=("general",), delivered_pool="general"):
    """A catalog with one ad no longer active in `delivered_pool` but still on Unraid there."""
    from commercials.catalog import Ad, Catalog

    remote = f"{RET_ROOT}/{delivered_pool}/old.mp4"
    status = "active" if delivered_pool not in pools else "rejected"
    ad = Ad("old", "1,2,3", 30.0, set(pools), date(2026, 11, 1), date(2026, 11, 1), ["x"],
            "/x/old.mp4", {delivered_pool: remote}, status, kids_blocked=kids_blocked)
    save_catalog(Catalog(ads={"old": ad}), c.state / "catalog.json")
    return remote


def test_failed_sync_leaves_retired_files_in_place(tmp_path):
    c = ctx(tmp_path, configured=True)
    remote = _seed_retired(c)
    fakes = Fakes([comp("v1")])

    def boom(cfg, catalog, active):
        raise RuntimeError("tunarr down")

    fakes.sync = boom
    report = run(RunOptions(), c, fakes.tools())
    assert fakes.removes == []
    assert load_catalog(c.state / "catalog.json").ads["old"].delivered == {"general": remote}
    assert report.delivery["deleted"] == 0 and report.delivery["delete_deferred"] == 1


def test_deletes_run_after_a_successful_sync(tmp_path):
    c = ctx(tmp_path, configured=True)
    remote = _seed_retired(c)
    fakes = Fakes([comp("v1")])
    order = []
    fakes.sync = lambda cfg, catalog, active: order.append("sync") or {"kids": "updated", "general": "updated"}
    plain_remove = fakes.remove
    fakes.remove = lambda catalog, remotes: order.append("remove") or plain_remove(catalog, remotes)
    report = run(RunOptions(), c, fakes.tools())
    assert order == ["sync", "remove"]
    assert fakes.removes == [[remote]]
    assert load_catalog(c.state / "catalog.json").ads["old"].delivered == {}
    assert report.delivery["deleted"] == 1 and report.delivery["delete_deferred"] == 0


def test_unconfigured_sync_defers_deletes(tmp_path):
    c = ctx(tmp_path, configured=False)
    remote = _seed_retired(c)
    report = run(RunOptions(), c, Fakes([comp("v1")]).tools())
    assert load_catalog(c.state / "catalog.json").ads["old"].delivered == {"general": remote}
    assert report.delivery["delete_deferred"] == 1


def test_pool_whose_list_was_not_updated_keeps_its_files(tmp_path):
    c = ctx(tmp_path, configured=True)
    remote = _seed_retired(c)
    fakes = Fakes([comp("v1")])
    fakes.sync = lambda cfg, catalog, active: {"kids": "updated", "general": "tunarr_behind"}
    report = run(RunOptions(), c, fakes.tools())
    assert fakes.removes == []
    assert report.delivery["delete_deferred"] == 1
    assert load_catalog(c.state / "catalog.json").ads["old"].delivered == {"general": remote}


def test_kids_blocked_file_leaves_kids_folder_even_when_sync_fails(tmp_path):
    # a beer ad must not stay playable from the kids list: a missing file beats it airing
    c = ctx(tmp_path, configured=True)
    remote = _seed_retired(c, kids_blocked=True, pools=("general",), delivered_pool="kids")
    fakes = Fakes([comp("v1")])

    def boom(cfg, catalog, active):
        raise RuntimeError("tunarr down")

    fakes.sync = boom
    run(RunOptions(), c, fakes.tools())
    assert fakes.removes == [[remote]]


def test_run_daily_wrapper_upgrades_ytdlp_then_runs():
    script = ROOT / "launchd" / "run-daily.sh"
    text = script.read_text()
    assert script.stat().st_mode & 0o111
    assert text.index("uv pip install") < text.index("commercials run")
    assert "-U yt-dlp" in text
    assert "uv sync" not in text  # an upgrade must not rewrite the tracked uv.lock
    subprocess.run(["sh", "-n", str(script)], check=True)


def test_report_flags_pools_under_floor(tmp_path):
    _, report = run_with(tmp_path, Fakes([comp("v1")]), deliver=False, sync=False)
    assert report.under_floor == {"general": pytest.approx(40 / 3600, abs=0.01), "kids": 0.0}


def test_cmd_run_notifies_only_when_needed(monkeypatch, tmp_path):
    from commercials import cli
    from commercials.report import Report

    sent = []
    monkeypatch.setattr(cli, "notify", sent.append)
    monkeypatch.setattr(cli, "real_tools", lambda d: None)
    monkeypatch.setenv("COMMERCIALS_STATE", str(tmp_path))
    monkeypatch.setenv("COMMERCIALS_MEDIA", str(tmp_path))
    clean = Report(added=[], retired=[], rejected_by_reason={}, pool_hours={}, failures=[])
    monkeypatch.setattr(cli, "run", lambda opts, ctx, tools: clean)
    assert cli.main(["run"]) == 0 and sent == []
    bad = Report(added=[], retired=[], rejected_by_reason={}, pool_hours={}, failures=["x"])
    monkeypatch.setattr(cli, "run", lambda opts, ctx, tools: bad)
    assert cli.main(["run"]) == 1 and sent == ["1 failure"]
    monkeypatch.setattr(cli, "run", lambda opts, ctx, tools: bad)
    assert cli.main(["run", "--dry-run"]) == 1 and sent == ["1 failure"]  # dry runs stay quiet


def test_notify_passes_text_as_an_argument(monkeypatch):
    from commercials import cli

    calls = []
    monkeypatch.setattr(cli.subprocess, "run", lambda args, **kw: calls.append(args))
    cli.notify('2 failures; "quoted"')
    assert calls[0][0] == "/usr/bin/osascript"
    assert calls[0][-1] == '2 failures; "quoted"'  # never spliced into the script


def test_compilation_abandoned_after_three_failures(tmp_path):
    fakes = Fakes([comp("bad")], fail_download={"bad"})
    c, first = run_with(tmp_path, fakes, deliver=False, sync=False)
    assert first.compilations[0]["status"] == "failed"
    second = run(RunOptions(deliver=False, sync=False), c, fakes.tools())
    assert second.compilations[0]["status"] == "failed"
    third = run(RunOptions(deliver=False, sync=False), c, fakes.tools())
    assert third.compilations[0]["status"] == "abandoned"
    assert any(f.startswith("bad:") for f in third.failures)
    cat = load_catalog(c.state / "catalog.json")
    assert cat.compilations["bad"].status == "abandoned" and cat.compilations["bad"].attempts == 3
    fourth = run(RunOptions(deliver=False, sync=False), c, fakes.tools())
    assert fakes.downloads == ["bad", "bad", "bad"] and fourth.compilations == []


def test_find_match_runs_once_per_accepted_segment(tmp_path, monkeypatch):
    from commercials import fingerprint, runner

    calls = []
    real = fingerprint.find_match

    def counting(fp, catalog, *a, **kw):
        calls.append(1)
        return real(fp, catalog, *a, **kw)

    monkeypatch.setattr(fingerprint, "find_match", counting)
    monkeypatch.setattr(runner, "find_match", counting)
    _, report = run_with(tmp_path, Fakes([comp("v1")]), deliver=False, sync=False)
    assert len(report.added) == 3 and len(calls) == 3
