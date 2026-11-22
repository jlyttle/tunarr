import json

from commercials.tunarr_sync import (
    SyncResult,
    TunarrClient,
    plex_refresh_url,
    plex_server,
    programs_for_pool,
    sync_pool,
    sync_with_retry,
)

BASE = "/data/Videos/Modern Commercials"


def item(n, pool, with_path=True, state="ok"):
    it = {"uuid": f"u{n}", "type": "other_video", "title": f"ad{n}", "duration": 30000, "state": state}
    if with_path:
        it["mediaItem"] = {"locations": [
            {"type": "local", "path": f"{BASE}/{pool}/ad{n}.mp4"}]}
    return it


class FakeClient:
    def __init__(self, programs):
        self.programs = programs
        self.puts = []
        self.scans = []

    def library_programs(self, library_id):
        return self.programs

    def put_filler(self, list_id, programs):
        self.puts.append((list_id, programs))

    def scan_library(self, media_source_id, library_id):
        self.scans.append((media_source_id, library_id))


def ids(*ns):
    return {f"ad{n}" for n in ns}


def test_programs_for_pool_by_folder():
    progs = [item(1, "kids"), item(2, "general"), item(3, "kids")]
    assert [p["uuid"] for p in programs_for_pool(progs, "kids", ids(1, 2, 3))] == ["u1", "u3"]
    # a folder name that merely contains the pool name does not match
    other = {"uuid": "x", "mediaItem": {"locations": [
        {"path": f"{BASE}/kids-extra/a.mp4"}]}}
    assert programs_for_pool([other], "kids", {"a"}) == []
    # wrong parent folder does not match
    elsewhere = {"uuid": "y", "mediaItem": {"locations": [{"path": "/data/Other/kids/a.mp4"}]}}
    assert programs_for_pool([elsewhere], "kids", {"a"}) == []


def test_stale_path_bearing_program_not_in_ad_ids_is_excluded():
    # ad9 was retired (or kids-blocked) but its program is still in Tunarr's library
    progs = [item(1, "kids"), item(9, "kids")]
    assert [p["uuid"] for p in programs_for_pool(progs, "kids", ids(1))] == ["u1"]


def test_missing_program_is_excluded():
    progs = [item(1, "kids"), item(2, "kids", state="missing")]
    assert [p["uuid"] for p in programs_for_pool(progs, "kids", ids(1, 2))] == ["u1"]


def test_sync_not_ready_while_an_ad_is_missing_in_tunarr():
    c = FakeClient([item(1, "kids"), item(2, "kids", state="missing")])
    r = sync_pool(c, "L", "kids", ids(1, 2), library_id="lib")
    assert r == SyncResult(updated=False, reason="tunarr_behind")
    assert c.puts == []


def test_stale_extras_do_not_satisfy_the_gate():
    # old library: two retired ads still present, one new ad not scanned yet
    c = FakeClient([item(1, "kids"), item(8, "kids"), item(9, "kids")])
    r = sync_pool(c, "L", "kids", ids(1, 2), library_id="lib")
    assert r == SyncResult(updated=False, reason="tunarr_behind")
    assert c.puts == []


def test_unfinished_scan_waits_then_puts_only_current_ads():
    # scan_library only queues: the first search still sees the old library
    seq = [[item(1, "kids"), item(9, "kids")],
           [item(1, "kids"), item(2, "kids"), item(9, "kids", state="missing")]]

    class C(FakeClient):
        def library_programs(self, library_id):
            return seq.pop(0)

    c = C([])
    sleeps = []
    r = sync_with_retry(c, "L", "kids", ids(1, 2), sleep=sleeps.append, library_id="lib")
    assert r.updated and sleeps == [120]
    assert [p["uuid"] for p in c.puts[0][1]] == ["u1", "u2"]


def test_programs_for_pool_title_fallback():
    progs = [item(1, "kids", with_path=False), item(2, "kids", with_path=False)]
    got = programs_for_pool(progs, "kids", {"ad2"})
    assert [p["uuid"] for p in got] == ["u2"]


def test_sync_refuses_shrink():
    c = FakeClient([item(i, "kids") for i in range(40)])
    r = sync_pool(c, "L", "kids", set(f"ad{i}" for i in range(50)), library_id="lib")
    assert r == SyncResult(updated=False, reason="tunarr_behind")
    assert c.puts == []


def test_sync_puts_full_list():
    c = FakeClient([item(i, "kids") for i in range(50)] + [item(99, "general")])
    r = sync_pool(c, "L", "kids", set(f"ad{i}" for i in range(50)), library_id="lib")
    assert r == SyncResult(updated=True, reason=None)
    assert len(c.puts) == 1 and c.puts[0][0] == "L"
    assert len(c.puts[0][1]) == 50


def test_put_body_shape():
    sent = {}

    class C(TunarrClient):
        def _request(self, method, path, body=None):
            sent.update(method=method, path=path, body=body)
            return {}

    C("http://x/api").put_filler("L", [item(1, "kids")])
    assert sent["method"] == "PUT" and sent["path"] == "/filler-lists/L"
    assert list(sent["body"]) == ["programs"]
    prog = sent["body"]["programs"][0]
    assert prog == {"type": "content", "id": "u1", "duration": 30000,
                    "program": item(1, "kids")}
    json.dumps(sent["body"])


def test_sync_not_configured_makes_no_calls():
    c = FakeClient([])
    assert sync_pool(c, None, "kids", ids(1)) == SyncResult(False, "not_configured")
    assert c.puts == [] and c.scans == []


def test_sync_with_retry_waits_then_succeeds():
    seq = [[item(i, "kids") for i in range(3)], [item(i, "kids") for i in range(5)]]

    class C(FakeClient):
        def library_programs(self, library_id):
            return seq.pop(0)

    sleeps = []
    r = sync_with_retry(C([]), "L", "kids", ids(0, 1, 2, 3, 4), sleep=sleeps.append, library_id="lib")
    assert r.updated and sleeps == [120]


def test_sync_with_retry_gives_up_after_three_tries():
    c = FakeClient([item(0, "kids")])
    sleeps = []
    r = sync_with_retry(c, "L", "kids", ids(0, 1, 2, 3, 4), sleep=sleeps.append, library_id="lib")
    assert r == SyncResult(False, "tunarr_behind")
    assert sleeps == [120, 120] and c.puts == []


def test_sync_with_retry_not_configured_does_not_sleep():
    sleeps = []
    r = sync_with_retry(FakeClient([]), None, "kids", ids(1), sleep=sleeps.append)
    assert r.reason == "not_configured" and sleeps == []


def test_plex_server_and_refresh_url():
    sources = [{"type": "local", "id": "a"},
               {"type": "plex", "id": "m", "uri": "http://h:32400", "accessToken": "T"}]
    assert plex_server(sources, "m") == ("http://h:32400", "T")
    url = plex_refresh_url("http://h:32400", "T", "5", f"{BASE}/kids")
    assert url.startswith("http://h:32400/library/sections/5/refresh?")
    assert "path=%2Fdata%2FVideos%2FModern+Commercials%2Fkids" in url
    assert "X-Plex-Token=T" in url


def test_sync_not_configured_without_library():
    c = FakeClient([])
    assert sync_pool(c, "L", "kids", ids(1), library_id=None).reason == "not_configured"


def test_sync_never_puts_empty():
    c = FakeClient([item(1, "general")])
    r = sync_pool(c, "L", "kids", set(), library_id="lib")
    assert r == SyncResult(updated=False, reason="empty")
    assert c.puts == []


def test_two_pool_duplicates_counted_once():
    def pathless(uuid, title):
        return {"uuid": uuid, "title": title, "type": "other_video", "duration": 1}
    c = FakeClient([pathless("a", "X"), pathless("b", "X")])
    r = sync_pool(c, "L", "kids", {"X", "Y"}, library_id="lib")
    assert r == SyncResult(updated=False, reason="tunarr_behind")
    assert c.puts == []
    assert len(programs_for_pool(c.programs, "kids", {"X"})) == 1


def test_pathless_title_not_in_ad_ids_excluded():
    p = {"uuid": "a", "title": "Z"}
    assert programs_for_pool([p], "kids", {"X"}) == []
    assert programs_for_pool([p], "kids", set()) == []


def test_plex_server_missing_token_raises():
    import pytest
    with pytest.raises(ValueError, match="accessToken"):
        plex_server([{"id": "m", "uri": "http://h"}], "m")
