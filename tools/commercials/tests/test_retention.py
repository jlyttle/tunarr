from datetime import date, timedelta

from commercials.catalog import Ad, Catalog
from commercials.retention import select_active

TODAY = date(2026, 11, 22)


def mk(ad_id, age_days, pools=("kids",), dur=30.0, status="active"):
    d = TODAY - timedelta(days=age_days)
    return Ad(ad_id, "fp" + ad_id, dur, set(pools), d, d, [], "", {}, status)


def cat(*ads):
    return Catalog(ads={a.ad_id: a for a in ads})


def test_within_window_kept():
    c = cat(mk("a", 56), mk("b", 1))
    r = select_active(c, TODAY, floor_s=0)
    assert r == {"kids": {"a", "b"}}
    assert c.ads["a"].status == "active"


def test_expired_retired():
    c = cat(mk("a", 57), mk("b", 1))
    r = select_active(c, TODAY, floor_s=0)
    assert r["kids"] == {"b"}
    assert c.ads["a"].status == "retired"


def test_floor_keeps_newest_expired():
    c = cat(mk("new", 1, dur=30), mk("e1", 60, dur=30), mk("e2", 70, dur=30), mk("e3", 80, dur=30))
    r = select_active(c, TODAY, floor_s=90)
    assert r["kids"] == {"new", "e1", "e2"}
    assert c.ads["e3"].status == "retired"
    assert c.ads["e1"].status == "active"


def test_floor_per_pool_independent():
    c = cat(mk("k1", 1, ("kids",)), mk("k2", 60, ("kids",)),
            mk("g1", 1, ("general",), dur=100), mk("g2", 60, ("general",)))
    r = select_active(c, TODAY, floor_s=60)
    assert r["kids"] == {"k1", "k2"}
    assert r["general"] == {"g1"}
    assert c.ads["g2"].status == "retired"


def test_rejected_never_selected():
    c = cat(mk("r", 1, status="rejected"), mk("e", 60))
    r = select_active(c, TODAY, floor_s=1000)
    assert r["kids"] == {"e"}
    assert c.ads["r"].status == "rejected"


def test_retired_ad_reactivated():
    c = cat(mk("a", 1, status="retired"))
    r = select_active(c, TODAY, floor_s=0)
    assert r["kids"] == {"a"}
    assert c.ads["a"].status == "active"
