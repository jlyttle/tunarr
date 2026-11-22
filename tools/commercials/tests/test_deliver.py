import subprocess
from datetime import date

import pytest

from commercials.catalog import Ad, Catalog
from commercials.deliver import (
    apply_delivery_result,
    delete_args,
    plan_delivery,
    push_args,
    remote_path,
)

ROOT = "/mnt/user/plex/Videos/Modern Commercials"


def mk(ad_id, pools, delivered=None, status="active"):
    return Ad(ad_id, "fp", 30.0, set(pools), date(2026, 1, 1), date(2026, 1, 1), [],
              f"/x/{ad_id}.mp4", delivered or {}, status)


def cat(*ads):
    return Catalog(ads={a.ad_id: a for a in ads})


def test_remote_path():
    assert remote_path(mk("a1", ["kids"]), "kids", ROOT) == f"{ROOT}/kids/a1.mp4"


def test_plan_pushes_new_and_deletes_retired():
    new = mk("new", ["kids"])
    old = mk("old", ["kids"], {"kids": f"{ROOT}/kids/old.mp4"}, "retired")
    kept = mk("kept", ["kids"], {"kids": f"{ROOT}/kids/kept.mp4"})
    plan = plan_delivery(cat(new, old, kept), {"kids": {"new", "kept"}, "general": set()}, ROOT)
    assert plan.push == [("new", "kids", f"{ROOT}/kids/new.mp4")]
    assert plan.delete == [f"{ROOT}/kids/old.mp4"]


def test_pending_delivery_retried():
    a = mk("a", ["kids"])
    c = cat(a)
    active = {"kids": {"a"}, "general": set()}
    assert len(plan_delivery(c, active, ROOT).push) == 1
    assert len(plan_delivery(c, active, ROOT).push) == 1  # catalog not mutated
    apply_delivery_result(c, [("a", "kids", remote_path(a, "kids", ROOT))], [])
    assert plan_delivery(c, active, ROOT).push == []


def test_two_pool_ad_delivered_twice():
    a = mk("a", ["kids", "general"])
    plan = plan_delivery(cat(a), {"kids": {"a"}, "general": {"a"}}, ROOT)
    assert len(plan.push) == 2
    assert {p[1] for p in plan.push} == {"kids", "general"}


def test_ad_leaving_pool_deleted_and_result_applied():
    a = mk("a", ["general"], {"kids": f"{ROOT}/kids/a.mp4", "general": f"{ROOT}/general/a.mp4"})
    c = cat(a)
    plan = plan_delivery(c, {"kids": set(), "general": {"a"}}, ROOT)
    assert plan.delete == [f"{ROOT}/kids/a.mp4"] and plan.push == []
    apply_delivery_result(c, [], plan.delete)
    assert a.delivered == {"general": f"{ROOT}/general/a.mp4"}


def test_push_args_use_system_ssh():
    args = push_args("/l/a.mp4", f"{ROOT}/kids/a.mp4")
    assert args[:2] == ["/usr/bin/ssh", "root@192.168.1.227"]
    assert args[2].startswith("umask 000; mkdir -p")
    d = delete_args([f"{ROOT}/kids/a.mp4"])
    assert d[0] == "/usr/bin/ssh" and "root@192.168.1.227" in d


def test_push_command_survives_remote_shell(tmp_path):
    root = f"{tmp_path}/Modern Commercials it's"
    remote = f"{root}/kids/a.mp4"
    script = push_args("ignored", remote)[2]
    src = tmp_path / "src.bin"
    src.write_bytes(b"hello bytes")
    with src.open("rb") as f:
        subprocess.run(["sh", "-c", script], stdin=f, check=True)
    assert (tmp_path / "Modern Commercials it's" / "kids" / "a.mp4").read_bytes() == b"hello bytes"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Modern Commercials it's", "src.bin"]
    assert sorted(p.name for p in (tmp_path / "Modern Commercials it's" / "kids").iterdir()) == ["a.mp4"]


def test_delete_command_survives_remote_shell(tmp_path):
    d = tmp_path / "Modern Commercials it's"
    d.mkdir()
    f1, f2, keep = d / "a b.mp4", d / "c.mp4", d / "keep.mp4"
    for f in (f1, f2, keep):
        f.write_bytes(b"x")
    subprocess.run(["sh", "-c", delete_args([str(f1), str(f2)])[2]], check=True)
    assert sorted(p.name for p in d.iterdir()) == ["keep.mp4"]


def test_deliver_failed_push_stays_pending(tmp_path, monkeypatch, capsys):
    from commercials import deliver as dmod

    a, b = mk("a", ["kids"]), mk("b", ["kids"])
    for ad in (a, b):
        p = tmp_path / f"{ad.ad_id}.mp4"
        p.write_bytes(b"x")
        ad.local_path = str(p)
    c = cat(a, b)

    def fake_run(args, **kw):
        bad = "b.mp4" in args[2]
        return subprocess.CompletedProcess(args, 1 if bad else 0, b"", b"boom" if bad else b"")

    monkeypatch.setattr(dmod.subprocess, "run", fake_run)
    dmod.deliver(c, {"kids": {"a", "b"}, "general": set()}, ROOT)
    assert a.delivered == {"kids": f"{ROOT}/kids/a.mp4"}
    assert b.delivered == {}
    err = capsys.readouterr().err
    assert "b" in err and "boom" in err


def test_deliver_pushes_but_never_deletes(tmp_path, monkeypatch):
    from commercials import deliver as dmod

    old = mk("old", ["kids"], {"kids": f"{ROOT}/kids/old.mp4"}, "retired")
    calls = []
    monkeypatch.setattr(dmod.subprocess, "run",
                        lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 0))
    plan = dmod.deliver(cat(old), {"kids": set(), "general": set()}, ROOT)
    assert plan.delete == [f"{ROOT}/kids/old.mp4"]
    assert calls == []  # deletes wait until the filler lists no longer reference them
    assert old.delivered == {"kids": f"{ROOT}/kids/old.mp4"}


def test_remove_deletes_and_forgets_remotes(monkeypatch):
    from commercials import deliver as dmod

    a = mk("a", ["general"], {"kids": f"{ROOT}/kids/a.mp4", "general": f"{ROOT}/general/a.mp4"})
    calls = []
    monkeypatch.setattr(dmod.subprocess, "run",
                        lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 0))
    assert dmod.remove(cat(a), [f"{ROOT}/kids/a.mp4"]) == [f"{ROOT}/kids/a.mp4"]
    assert len(calls) == 1 and "rm -f" in calls[0][2]
    assert a.delivered == {"general": f"{ROOT}/general/a.mp4"}


def test_remove_failure_keeps_remotes_pending(monkeypatch):
    from commercials import deliver as dmod

    a = mk("a", ["general"], {"kids": f"{ROOT}/kids/a.mp4"})
    monkeypatch.setattr(dmod.subprocess, "run",
                        lambda args, **kw: subprocess.CompletedProcess(args, 255, b"", b"down"))
    assert dmod.remove(cat(a), [f"{ROOT}/kids/a.mp4"]) == []
    assert a.delivered == {"kids": f"{ROOT}/kids/a.mp4"}
