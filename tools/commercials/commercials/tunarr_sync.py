"""Replace each pool's Tunarr filler list with the ads delivered to that pool.

Tunarr reads the delivered files through one local media source with one library per
pool folder (`<container_root>/kids`, `<container_root>/general`), so pool == library.
"""
import json
import posixpath
import time
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass

PAGE_SIZE = 200
RETRIES = 3
RETRY_WAIT_S = 120


@dataclass
class SyncResult:
    updated: bool
    reason: str | None = None


class TunarrClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def _request(self, method: str, path: str, body: dict | None = None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base_url + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def scan_library(self, media_source_id: str, library_id: str):
        return self._request(
            "POST", f"/media-sources/{media_source_id}/libraries/{library_id}/scan", {})

    def media_sources(self) -> list[dict]:
        return self._request("GET", "/media-sources") or []

    def library_programs(self, library_id: str) -> list[dict]:
        out: list[dict] = []
        page = 0
        while True:
            res = self._request("POST", "/programs/search", {
                "query": {}, "libraryId": library_id, "page": page, "limit": PAGE_SIZE})
            out += res["results"]
            page += 1
            if page >= res["totalPages"]:
                return out

    def get_filler(self, list_id: str):
        return self._request("GET", f"/filler-lists/{list_id}")

    def put_filler(self, list_id: str, programs: list[dict]):
        body = {"programs": [_content_program(p) for p in programs]}
        return self._request("PUT", f"/filler-lists/{list_id}", body)


def _content_program(item: dict) -> dict:
    """Wrap a search result as the ContentProgram that filler-list PUT accepts."""
    return {"type": "content", "id": item["uuid"], "duration": item["duration"],
            "program": item}


def _paths(item: dict) -> list[str]:
    media = item.get("mediaItem") or {}
    return [loc["path"] for loc in media.get("locations", []) if "path" in loc]


def _ad_id(item: dict) -> str | None:
    """The ad id of a search result: the file stem of its path, else its title.

    Search results may omit the file path (`mediaItem` is optional); the title of a
    local program is then its file stem, i.e. the ad id.
    """
    paths = _paths(item)
    if not paths:
        return item.get("title")
    return posixpath.splitext(posixpath.basename(paths[0]))[0]


def programs_for_pool(programs: list[dict], ad_ids: set[str]) -> list[dict]:
    """One search result per ad in `ad_ids` (the ads delivered to this pool).

    `programs` must come from the pool's own library. Anything else is dropped: retired
    or kids-blocked ads whose programs Tunarr still lists, and programs Tunarr marked
    `missing` (it keeps vanished files with that state instead of removing them).
    """
    out = []
    seen: set[str] = set()
    for p in programs:
        if p.get("state") == "missing":
            continue
        ad_id = _ad_id(p)
        if ad_id is not None and ad_id in ad_ids and ad_id not in seen:
            seen.add(ad_id)
            out.append(p)
    return out


def sync_pool(client, list_id: str | None, ad_ids: set[str],
              library_id: str | None = None) -> SyncResult:
    """Replace the pool's filler list, but only once its library lists every ad in `ad_ids`.

    `scan_library` only queues a scan, so the first search may still see the old
    library; until the matched id set equals `ad_ids` the result is `tunarr_behind`.
    """
    if list_id is None or library_id is None:
        return SyncResult(updated=False, reason="not_configured")
    if not ad_ids:
        return SyncResult(updated=False, reason="empty")
    matched = programs_for_pool(client.library_programs(library_id), ad_ids)
    if {_ad_id(p) for p in matched} != ad_ids:
        return SyncResult(updated=False, reason="tunarr_behind")
    client.put_filler(list_id, matched)
    return SyncResult(updated=True, reason=None)


def sync_with_retry(client, list_id: str | None, ad_ids: set[str],
                    sleep: Callable[[float], None] = time.sleep,
                    library_id: str | None = None) -> SyncResult:
    result = SyncResult(updated=False, reason="tunarr_behind")
    for attempt in range(RETRIES):
        result = sync_pool(client, list_id, ad_ids, library_id=library_id)
        if result.reason != "tunarr_behind":
            return result
        if attempt < RETRIES - 1:
            sleep(RETRY_WAIT_S)
    return result


def sync_pools(client, tunarr: dict, filler_list_ids: dict, delivered: dict[str, set[str]],
               sleep: Callable[[float], None] = time.sleep,
               pools: Iterable[str] = ("kids", "general")) -> dict[str, str]:
    """Per pool: scan its library, then replace its filler list from that library only.

    Returns pool -> "updated" or the reason it was not (not_configured, empty,
    tunarr_behind). A pool without a media source, library or list makes no calls.
    """
    source = tunarr.get("media_source_id")
    libraries = tunarr.get("libraries") or {}
    out = {}
    for pool in pools:
        library_id, list_id = libraries.get(pool), filler_list_ids.get(pool)
        ad_ids = delivered.get(pool, set())
        if not (source and library_id and list_id):
            out[pool] = "not_configured"
            continue
        if ad_ids:
            client.scan_library(source, library_id)
        r = sync_with_retry(client, list_id, ad_ids, sleep=sleep, library_id=library_id)
        out[pool] = "updated" if r.updated else (r.reason or "not_updated")
    return out
