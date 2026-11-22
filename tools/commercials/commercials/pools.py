import json
import re
from pathlib import Path


def load_blocklist(path: Path) -> list[str]:
    return [k.lower() for k in json.loads(path.read_text())["keywords"]]


def chapter_text_for(seg_start: float, chapters: list[dict], tol_s: float = 1.5) -> str:
    """Lowercased titles of the chapter at seg_start and its neighbours.

    yt-dlp chapter titles in these compilations lag by about one chapter, so the
    previous and next titles are included.
    """
    if not chapters:
        return ""
    idx = next(
        (i for i, c in enumerate(chapters) if c["start_time"] - tol_s <= seg_start < c["end_time"] - tol_s),
        None,
    )
    if idx is None:
        return ""
    lo, hi = max(0, idx - 1), min(len(chapters), idx + 2)
    return " ".join(str(c.get("title") or "") for c in chapters[lo:hi]).lower()


def apply_blocklist(ad_title_text: str, pools: set[str], blocklist: list[str]) -> set[str]:
    text = ad_title_text.lower()
    if not text or "kids" not in pools or not any(re.search(rf"\b{re.escape(k)}\b", text) for k in blocklist):
        return set(pools)
    out = pools - {"kids"}
    return out or {"general"}


def enforce_kids_block(ad) -> None:
    """Once an ad is kids_blocked, it never sits in the kids pool (it falls back to general)."""
    if ad.kids_blocked and "kids" in ad.pools:
        ad.pools.discard("kids")
        if not ad.pools:
            ad.pools.add("general")
