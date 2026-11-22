import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

COMPILATION_STATUSES = ("new", "downloaded", "split", "failed")
AD_STATUSES = ("active", "retired", "rejected")


@dataclass
class Compilation:
    video_id: str
    title: str
    upload_date: date
    pools: set[str]
    status: str


@dataclass
class Ad:
    ad_id: str
    fingerprint: str
    duration_s: float
    pools: set[str]
    first_seen: date
    last_seen: date
    sources: list[str]
    local_path: str
    delivered: dict[str, str]  # pool name -> remote path
    status: str


@dataclass
class Catalog:
    compilations: dict[str, Compilation] = field(default_factory=dict)
    ads: dict[str, Ad] = field(default_factory=dict)

    def upsert_compilation(self, c: Compilation) -> bool:
        """Add c if its video_id is unknown. Returns True if new; existing entries are left untouched."""
        if c.video_id in self.compilations:
            return False
        self.compilations[c.video_id] = c
        return True


def _comp_to_json(c: Compilation) -> dict:
    return {
        "video_id": c.video_id,
        "title": c.title,
        "upload_date": c.upload_date.isoformat(),
        "pools": sorted(c.pools),
        "status": c.status,
    }


def _comp_from_json(d: dict) -> Compilation:
    return Compilation(d["video_id"], d["title"], date.fromisoformat(d["upload_date"]), set(d["pools"]), d["status"])


def _ad_to_json(a: Ad) -> dict:
    return {
        "ad_id": a.ad_id,
        "fingerprint": a.fingerprint,
        "duration_s": a.duration_s,
        "pools": sorted(a.pools),
        "first_seen": a.first_seen.isoformat(),
        "last_seen": a.last_seen.isoformat(),
        "sources": list(a.sources),
        "local_path": a.local_path,
        "delivered": dict(sorted(a.delivered.items())),
        "status": a.status,
    }


def _ad_from_json(d: dict) -> Ad:
    return Ad(
        d["ad_id"], d["fingerprint"], d["duration_s"], set(d["pools"]),
        date.fromisoformat(d["first_seen"]), date.fromisoformat(d["last_seen"]),
        list(d["sources"]), d["local_path"], dict(d.get("delivered", {})), d["status"],
    )


def load_catalog(path: Path) -> Catalog:
    if not path.exists():
        return Catalog()
    raw = json.loads(path.read_text())
    return Catalog(
        {k: _comp_from_json(v) for k, v in raw.get("compilations", {}).items()},
        {k: _ad_from_json(v) for k, v in raw.get("ads", {}).items()},
    )


def save_catalog(c: Catalog, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "compilations": {k: _comp_to_json(v) for k, v in sorted(c.compilations.items())},
        "ads": {k: _ad_to_json(v) for k, v in sorted(c.ads.items())},
    }
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
