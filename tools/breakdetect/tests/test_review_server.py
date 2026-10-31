import http.client
import json
import os
import shutil
import threading
from pathlib import Path

import pytest

from breakdetect.cache import FeatureCache
from breakdetect.labels import Decision, EpisodeLabels, ShowLabels, load_labels, save_labels
from breakdetect.review import server as review_server
from breakdetect.review.server import make_server

SEGMENTS = [("content", 70), ("fadeout", 1), ("black", 0.3), ("fadein", 1), ("content", 70)]
REL = "Show/ep1.mkv"


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BREAKDETECT_DATA", str(tmp_path / "data"))


@pytest.fixture
def media(tmp_path, make_clip):
    root = tmp_path / "media"
    (root / "Show").mkdir(parents=True)
    shutil.copy(make_clip(SEGMENTS), root / REL)
    return root


@pytest.fixture
def served(tmp_path, media):
    server = make_server(media / "Show", FeatureCache(tmp_path / "cache" / "features", [media]), port=0, roots=[media])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def call(server, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=120)
    payload = json.dumps(body) if body is not None else None
    conn.request(method, path, payload, headers or {"Content-Type": "application/json"})
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response, data


def get_rows(server):
    response, data = call(server, "GET", f"/api/episode?rel={REL}")
    assert response.status == 200
    return json.loads(data)["rows"]


def decide_all(server, label="break"):
    for row in get_rows(server):
        call(server, "POST", "/api/decision", {"rel": REL, "cut_ms": row["cut_ms"], "label": label})


def test_post_decision_persists(served):
    cut_ms = get_rows(served)[0]["cut_ms"]
    response, _ = call(served, "POST", "/api/decision", {"rel": REL, "cut_ms": cut_ms, "label": "break"})
    assert response.status == 200
    assert load_labels("show").episodes[REL].decisions == [Decision(cut_ms, "break", "user")]


def test_complete_rejected_when_undecided_candidates(served):
    response, _ = call(served, "POST", "/api/complete", {"rel": REL, "complete": True, "held_out": False})
    assert response.status == 409


def test_complete_accepted_after_user_decisions_and_stores_identity(served):
    decide_all(served, "not_break")
    response, _ = call(served, "POST", "/api/complete", {"rel": REL, "complete": True, "held_out": True})
    assert response.status == 200
    entry = load_labels("show").episodes[REL]
    assert entry.complete and entry.held_out and entry.identity and entry.duration_ms > 0


def test_seed_unsure_does_not_count_as_decided(served):
    cut_ms = get_rows(served)[0]["cut_ms"]
    save_labels(ShowLabels("Show", {REL: EpisodeLabels(decisions=[Decision(cut_ms + 200, "unsure", "seed")])}))
    assert get_rows(served)[0]["decision"] == {"label": "unsure", "source": "seed"}
    response, _ = call(served, "POST", "/api/complete", {"rel": REL, "complete": True, "held_out": False})
    assert response.status == 409
    decide_all(served, "break")
    rows = get_rows(served)
    assert all(r["decision"]["source"] == "user" for r in rows)
    assert len(load_labels("show").episodes[REL].decisions) == len(rows)


def test_decision_far_from_candidates_is_its_own_row(served):
    call(served, "POST", "/api/add-break", {"rel": REL, "ms": 5000})
    loose = [r for r in get_rows(served) if r["start_ms"] is None]
    assert [r["cut_ms"] for r in loose] == [5000]


def test_add_break_records_user_break(served):
    response, _ = call(served, "POST", "/api/add-break", {"rel": REL, "ms": 12345})
    assert response.status == 200
    assert load_labels("show").episodes[REL].decisions == [Decision(12345, "break", "user")]


def test_decision_on_completed_episode_reopens_it(served):
    decide_all(served, "not_break")
    call(served, "POST", "/api/complete", {"rel": REL, "complete": True, "held_out": False})
    call(served, "POST", "/api/add-break", {"rel": REL, "ms": 5000})
    assert load_labels("show").episodes[REL].complete is False


@pytest.mark.parametrize("rel", ["../escape.mkv", "Show/../../x.mkv", "/etc/passwd"])
def test_rejects_paths_outside_roots(served, rel):
    response, _ = call(served, "GET", f"/video?rel={rel}")
    assert response.status == 400


def test_invalid_label_rejected(served):
    response, _ = call(served, "POST", "/api/decision", {"rel": REL, "cut_ms": 1000, "label": "maybe"})
    assert response.status == 400


def test_clip_uses_input_seek(served, monkeypatch):
    seen = []

    def fake_run(argv, **kwargs):
        seen.append(argv)
        Path(argv[-1]).write_bytes(b"mp4")

    monkeypatch.setattr(review_server.subprocess, "run", fake_run)
    response, data = call(served, "GET", f"/clip?rel={REL}&ms=21000")
    assert response.status == 200 and data == b"mp4"
    argv = seen[0]
    assert argv.index("-ss") < argv.index("-i")
    assert argv[argv.index("-ss") + 1] == "16.000"
    assert argv[argv.index("-t") + 1] == "8"


def test_clip_start_clamps_to_zero(served, monkeypatch):
    seen = []

    def fake_run(argv, **kwargs):
        seen.append(argv)
        Path(argv[-1]).write_bytes(b"x")

    monkeypatch.setattr(review_server.subprocess, "run", fake_run)
    call(served, "GET", f"/clip?rel={REL}&ms=2000")
    assert seen[0][seen[0].index("-ss") + 1] == "0.000"


def test_strip_is_a_jpeg(served):
    response, data = call(served, "GET", f"/strip?rel={REL}&ms=22000")
    assert response.status == 200 and data[:2] == b"\xff\xd8"


def test_video_range_request(served, media):
    size = (media / REL).stat().st_size
    response, data = call(served, "GET", f"/video?rel={REL}", headers={"Range": "bytes=10-19"})
    assert response.status == 206
    assert response.getheader("Content-Range") == f"bytes 10-19/{size}"
    assert data == (media / REL).read_bytes()[10:20]


def test_video_unsatisfiable_range(served):
    response, _ = call(served, "GET", f"/video?rel={REL}", headers={"Range": "bytes=999999999999-"})
    assert response.status == 416


def test_episode_scores_hidden(served):
    assert all(r["score"] is None for r in get_rows(served))


def test_index_lists_episode_progress(served):
    call(served, "POST", "/api/add-break", {"rel": REL, "ms": 5000})
    _, data = call(served, "GET", "/api/show")
    episode = json.loads(data)["episodes"][0]
    assert (episode["rel"], episode["user_decisions"], episode["complete"]) == (REL, 1, False)


def test_text_plain_post_rejected_and_labels_unchanged(served):
    conn = http.client.HTTPConnection("127.0.0.1", served.server_port, timeout=30)
    conn.request("POST", "/api/add-break", json.dumps({"rel": REL, "ms": 5000}), {"Content-Type": "text/plain"})
    response = conn.getresponse()
    response.read()
    conn.close()
    assert response.status == 415
    assert not (Path(os.environ["BREAKDETECT_DATA"]) / "labels").exists()


@pytest.mark.parametrize("path,body", [("/api/decision", {"rel": REL}), ("/api/add-break", {"rel": REL}), ("/api/complete", {"rel": REL})])
def test_missing_body_keys_are_400(served, path, body):
    response, _ = call(served, "POST", path, body, {"Content-Type": "application/json"})
    assert response.status == 400


def mark_rest(server):
    return call(server, "POST", "/api/mark-rest-not-break", {"rel": REL})


def test_mark_rest_converts_undecided_and_seed_rows_to_user_not_break(served):
    rows = get_rows(served)
    save_labels(ShowLabels("Show", {REL: EpisodeLabels(decisions=[Decision(rows[0]["cut_ms"], "unsure", "seed")])}))
    response, data = mark_rest(served)
    assert response.status == 200
    updated = json.loads(data)["rows"]
    assert len(updated) == len(rows)
    assert all(r["decision"] == {"label": "not_break", "source": "user"} for r in updated)
    assert not load_labels("show").episodes[REL].complete


def test_mark_rest_leaves_existing_user_decisions_untouched(served):
    rows = get_rows(served)
    assert len(rows) >= 1
    call(served, "POST", "/api/add-break", {"rel": REL, "ms": 5000})
    call(served, "POST", "/api/decision", {"rel": REL, "cut_ms": rows[0]["cut_ms"], "label": "unsure"})
    mark_rest(served)
    by_cut = {r["cut_ms"]: r["decision"] for r in get_rows(served)}
    assert by_cut[5000] == {"label": "break", "source": "user"}
    assert by_cut[rows[0]["cut_ms"]] == {"label": "unsure", "source": "user"}
    assert all(d["source"] == "user" for d in by_cut.values())


def test_mark_rest_keeps_user_not_break(served):
    cut_ms = get_rows(served)[0]["cut_ms"]
    call(served, "POST", "/api/decision", {"rel": REL, "cut_ms": cut_ms, "label": "not_break"})
    mark_rest(served)
    assert Decision(cut_ms, "not_break", "user") in load_labels("show").episodes[REL].decisions


def test_complete_succeeds_after_mark_rest(served):
    mark_rest(served)
    response, _ = call(served, "POST", "/api/complete", {"rel": REL, "complete": True, "held_out": False})
    assert response.status == 200


def test_mark_rest_text_plain_rejected(served):
    conn = http.client.HTTPConnection("127.0.0.1", served.server_port, timeout=30)
    conn.request("POST", "/api/mark-rest-not-break", json.dumps({"rel": REL}), {"Content-Type": "text/plain"})
    response = conn.getresponse()
    response.read()
    conn.close()
    assert response.status == 415
