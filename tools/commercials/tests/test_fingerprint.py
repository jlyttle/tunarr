import json
import random
from datetime import date

from commercials.catalog import Catalog
from commercials.fingerprint import fpcalc_args, parse_fpcalc, record_segment, similarity


def _fp(seed: int, n: int = 200) -> list[int]:
    r = random.Random(seed)
    return [r.getrandbits(32) for _ in range(n)]


def test_fpcalc_args_and_parse():
    assert fpcalc_args("a.mkv") == ["fpcalc", "-raw", "-json", "a.mkv"]
    assert parse_fpcalc(json.dumps({"duration": 5, "fingerprint": [1, 2, 3]})) == [1, 2, 3]


def test_similarity_self_is_one():
    assert similarity(_fp(1), _fp(1)) == 1.0


def test_similarity_unrelated_low():
    assert similarity(_fp(1), _fp(2)) < 0.6


def test_similarity_tolerates_offset():
    a = _fp(1)
    assert similarity(a, a[3:]) == 1.0


def _meta(src: str) -> dict:
    return {"source": src, "duration_s": 30.0, "local_path": "x.mkv"}


def test_record_segment_dedupes():
    cat = Catalog()
    fp = _fp(1)
    id1, created1 = record_segment(cat, fp, _meta("a"), {"general"}, date(2026, 1, 1))
    id2, created2 = record_segment(cat, fp, _meta("b"), {"general"}, date(2026, 2, 1))
    assert (created1, created2) == (True, False)
    assert id1 == id2 and len(cat.ads) == 1
    ad = cat.ads[id1]
    assert ad.last_seen == date(2026, 2, 1) and ad.first_seen == date(2026, 1, 1)
    assert ad.sources == ["a", "b"]


def test_ad_in_two_pools_once():
    cat = Catalog()
    fp = _fp(3)
    record_segment(cat, fp, _meta("a"), {"kids"}, date(2026, 1, 1))
    ad_id, _ = record_segment(cat, fp, _meta("b"), {"general"}, date(2026, 1, 2))
    assert len(cat.ads) == 1 and cat.ads[ad_id].pools == {"kids", "general"}
