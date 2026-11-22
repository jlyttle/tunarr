from datetime import date

from commercials.catalog import Ad, Catalog
from commercials.deliver import (
    apply_delivery_result,
    delete_args,
    plan_delivery,
    push_args,
    remote_path,
)

ROOT = "/mnt/user/data/Videos/Modern Commercials"


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
    assert args[0] == "rsync" and "/usr/bin/ssh" in args
    assert args[-1] == f"root@192.168.1.227:{ROOT}/kids/a.mp4"
    assert "--chmod=a+rwX" in args and "-t" in args
    assert any("umask 000; mkdir -p" in x for x in args)
    d = delete_args([f"{ROOT}/kids/a.mp4"])
    assert d[0] == "/usr/bin/ssh" and "root@192.168.1.227" in d
