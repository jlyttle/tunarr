import json
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

MC_FOLDER = "Modern Commercials"
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


def programs_for_pool(
    programs: list[dict], pool: str, ad_ids: set[str] | None = None
) -> list[dict]:
    """Programs whose file sits in `<Modern Commercials>/<pool>/`.

    Tunarr search results for an Unraid Plex source may omit the file path
    (`mediaItem` is optional); the title is then the file stem, i.e. the ad id,
    so `ad_ids` (the ids delivered to this pool) is used instead.
    """
    marker = f"/{MC_FOLDER}/{pool}/"
    out = []
    for p in programs:
        paths = _paths(p)
        if paths:
            if any(marker in path for path in paths):
                out.append(p)
        elif ad_ids is not None and p.get("title") in ad_ids:
            out.append(p)
    return out


def sync_pool(client, list_id: str | None, pool: str, expected_count: int,
              ad_ids: set[str] | None = None, library_id: str | None = None) -> SyncResult:
    if list_id is None or library_id is None:
        return SyncResult(updated=False, reason="not_configured")
    matched = programs_for_pool(client.library_programs(library_id), pool, ad_ids)
    if len(matched) < expected_count:
        return SyncResult(updated=False, reason="tunarr_behind")
    client.put_filler(list_id, matched)
    return SyncResult(updated=True, reason=None)


def sync_with_retry(client, list_id: str | None, pool: str, expected_count: int,
                    sleep: Callable[[float], None] = time.sleep, **kw) -> SyncResult:
    result = SyncResult(updated=False, reason="tunarr_behind")
    for attempt in range(RETRIES):
        result = sync_pool(client, list_id, pool, expected_count, **kw)
        if result.reason != "tunarr_behind":
            return result
        if attempt < RETRIES - 1:
            sleep(RETRY_WAIT_S)
    return result


def plex_server(media_sources: list[dict], media_source_id: str) -> tuple[str, str | None]:
    """(uri, token) of a Plex media source from `GET /media-sources`."""
    for m in media_sources:
        if m.get("id") == media_source_id:
            return m["uri"], m.get("accessToken")
    raise KeyError(f"media source {media_source_id} not found")


def plex_refresh_url(uri: str, token: str, section_key: str, folder: str) -> str:
    q = urllib.parse.urlencode({"path": folder, "X-Plex-Token": token})
    return f"{uri.rstrip('/')}/library/sections/{section_key}/refresh?{q}"


def plex_refresh(url: str) -> None:
    with urllib.request.urlopen(url, timeout=60):
        pass
