import hashlib
import json
import subprocess
from datetime import date
from pathlib import Path

from commercials.catalog import Ad, Catalog

MAX_OFFSET = 5
MIN_OVERLAP = 30


def fpcalc_args(path: str | Path) -> list[str]:
    return ["fpcalc", "-raw", "-json", str(path)]


def parse_fpcalc(raw: str) -> list[int]:
    return [int(x) for x in json.loads(raw)["fingerprint"]]


def fingerprint_file(path: str | Path) -> list[int]:
    out = subprocess.run(fpcalc_args(path), check=True, capture_output=True, text=True).stdout
    return parse_fpcalc(out)


def encode(fp: list[int]) -> str:
    return ",".join(str(x) for x in fp)


def decode(s: str) -> list[int]:
    return [int(x) for x in s.split(",")] if s else []


def similarity(a: list[int], b: list[int]) -> float:
    """Best bit agreement over aligned items, trying offsets of +/-MAX_OFFSET."""
    best = 0.0
    for off in range(-MAX_OFFSET, MAX_OFFSET + 1):
        x, y = (a[off:], b) if off >= 0 else (a, b[-off:])
        n = min(len(x), len(y))
        if n < MIN_OVERLAP:
            continue
        diff = sum(((p ^ q) & 0xFFFFFFFF).bit_count() for p, q in zip(x[:n], y[:n]))
        best = max(best, 1.0 - diff / (32 * n))
    return best


def find_match(fp: list[int], catalog: Catalog, threshold: float = 0.85) -> str | None:
    best_id, best = None, threshold
    for ad_id, ad in catalog.ads.items():
        s = similarity(fp, decode(ad.fingerprint))
        if s >= best:
            best_id, best = ad_id, s
    return best_id


def record_segment(
    catalog: Catalog, fp: list[int], seg_meta: dict, pools: set[str], seen: date
) -> tuple[str, bool]:
    """seg_meta: source (str), duration_s (float), local_path (str), height (int)."""
    ad_id = find_match(fp, catalog)
    if ad_id is not None:
        ad = catalog.ads[ad_id]
        ad.last_seen = max(ad.last_seen, seen)
        if seg_meta["source"] not in ad.sources:
            ad.sources.append(seg_meta["source"])
        ad.pools |= pools
        height = int(seg_meta.get("height", 0))
        if height > ad.height:
            ad.local_path = seg_meta["local_path"]
            ad.duration_s = seg_meta["duration_s"]
            ad.height = height
            ad.delivered = {}
        return ad_id, False
    encoded = encode(fp)
    ad_id = hashlib.sha1(encoded.encode()).hexdigest()[:12]
    catalog.ads[ad_id] = Ad(
        ad_id=ad_id, fingerprint=encoded, duration_s=seg_meta["duration_s"], pools=set(pools),
        first_seen=seen, last_seen=seen, sources=[seg_meta["source"]],
        local_path=seg_meta["local_path"], delivered={}, status="active",
        height=int(seg_meta.get("height", 0)),
    )
    return ad_id, True
