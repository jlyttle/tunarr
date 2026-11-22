from datetime import date

from commercials.catalog import Catalog

POOLS = ("kids", "general")


def select_active(
    catalog: Catalog, today: date, retention_days: int = 56, floor_s: float = 10800
) -> dict[str, set[str]]:
    """Choose active ads per pool and update ad statuses.

    Ads seen within the window are kept. A pool under the floor is topped up with
    the most recently seen expired ads. Rejected ads are never selected.
    """
    result: dict[str, set[str]] = {}
    pools = set(POOLS) | {p for a in catalog.ads.values() for p in a.pools}
    for pool in sorted(pools):
        members = [a for a in catalog.ads.values() if pool in a.pools and a.status != "rejected"]
        fresh = [a for a in members if (today - a.last_seen).days <= retention_days]
        expired = sorted(
            (a for a in members if (today - a.last_seen).days > retention_days),
            key=lambda a: (-a.last_seen.toordinal(), a.ad_id),
        )
        selected = {a.ad_id for a in fresh}
        total = sum(a.duration_s for a in fresh)
        for a in expired:
            if total >= floor_s:
                break
            selected.add(a.ad_id)
            total += a.duration_s
        result[pool] = selected
    chosen = set().union(*result.values()) if result else set()
    for a in catalog.ads.values():
        if a.status == "rejected":
            continue
        a.status = "active" if a.ad_id in chosen else "retired"
    return result
