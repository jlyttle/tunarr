import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

from breakdetect.media import default_roots, file_identity, relative_path

SCHEMA = 1
DEDUPE_WINDOW_MS = 1500


@dataclass
class Decision:
    cut_ms: int
    label: str
    source: str


@dataclass
class EpisodeLabels:
    identity: str = ""
    duration_ms: int = 0
    complete: bool = False
    held_out: bool = False
    decisions: list[Decision] = field(default_factory=list)


@dataclass
class ShowLabels:
    show: str
    episodes: dict[str, EpisodeLabels] = field(default_factory=dict)

    def ground_truth(self, rel_path: str, roots: list[Path] | None = None) -> list[int] | None:
        entry = self.episodes.get(rel_path)
        if entry is None or not entry.complete:
            return None
        if _is_stale_under(entry, rel_path, roots or default_roots()):
            return None
        return [d.cut_ms for d in entry.decisions if d.label == "break" and d.source == "user"]


def slugify(show: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", show.lower()).strip("-")


def data_dir() -> Path:
    configured = os.environ.get("BREAKDETECT_DATA")
    return Path(configured) if configured else Path(__file__).resolve().parents[1] / "data"


def labels_dir() -> Path:
    return data_dir() / "labels"


def is_stale(entry: EpisodeLabels, path: Path) -> bool:
    if not entry.identity or not path.exists():
        return True
    return entry.identity != file_identity(path)


def _is_stale_under(entry: EpisodeLabels, rel_path: str, roots: list[Path]) -> bool:
    existing = [root / rel_path for root in roots if (root / rel_path).exists()]
    return not existing or is_stale(entry, existing[0])


def _from_dict(raw: dict) -> ShowLabels:
    episodes = {
        rel: EpisodeLabels(
            identity=e["identity"],
            duration_ms=e["duration_ms"],
            complete=e["complete"],
            held_out=e["held_out"],
            decisions=[Decision(**d) for d in e["decisions"]],
        )
        for rel, e in raw["episodes"].items()
    }
    return ShowLabels(show=raw["show"], episodes=episodes)


def load_labels(show_slug: str) -> ShowLabels:
    raw = json.loads((labels_dir() / f"{show_slug}.json").read_text())
    return _from_dict(raw)


def save_labels(labels: ShowLabels) -> None:
    directory = labels_dir()
    directory.mkdir(parents=True, exist_ok=True)
    payload = {"schema": SCHEMA, "show": labels.show, "episodes": {rel: asdict(e) for rel, e in sorted(labels.episodes.items())}}
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, directory / f"{slugify(labels.show)}.json")


def _dedupe(decisions: list[Decision]) -> list[Decision]:
    kept: list[Decision] = []
    for d in sorted(decisions, key=lambda d: d.cut_ms):
        if kept and d.cut_ms - kept[-1].cut_ms <= DEDUPE_WINDOW_MS:
            if d.source == "user" and kept[-1].source != "user":
                kept[-1] = d
            continue
        kept.append(d)
    return kept


def _disk_identity(path: Path, recorded: str) -> str:
    return file_identity(path) if path.exists() else recorded


def _episode_for(shows: dict[str, ShowLabels], show: str, rel_path: str) -> EpisodeLabels:
    labels = shows.setdefault(slugify(show), ShowLabels(show=show))
    return labels.episodes.setdefault(rel_path, EpisodeLabels())


def _add_episode(shows, show, path, duration_ms, recorded_identity, decisions, roots) -> None:
    rel = relative_path(Path(path), roots)
    entry = _episode_for(shows, show, rel)
    entry.identity = _disk_identity(Path(path), recorded_identity)
    entry.duration_ms = duration_ms
    entry.decisions += decisions


def _recorded_identity(size: int | None, mtime_ns: int | None) -> str:
    return f"{size}:{mtime_ns}" if size is not None and mtime_ns is not None else ""


def _seed_decisions(episode: dict) -> list[Decision]:
    return [Decision(round(b["timestamp_s"] * 1000), "unsure", "seed") for b in episode["breaks"]]


def _pilot_decision(raw: dict) -> Decision:
    if raw["provenance"] == "user-confirmed" and raw["label"] == "break":
        return Decision(raw["timestampMs"], "break", "user")
    return Decision(raw["timestampMs"], "unsure", "seed")


def _import_research(dataset_json: Path, shows: dict[str, ShowLabels], roots: list[Path]) -> None:
    for e in json.loads(dataset_json.read_text())["episodes"]:
        identity = e.get("file_identity", {})
        _add_episode(
            shows, e["series"], e["path"], round(e["runtime_s"] * 1000),
            _recorded_identity(identity.get("size_bytes"), identity.get("mtime_ns")),
            _seed_decisions(e), roots,
        )


def _import_pilot(review_json: Path, shows: dict[str, ShowLabels], roots: list[Path]) -> None:
    inventory = {e["id"]: e for e in json.loads((review_json.parent / "inventory.json").read_text())["episodes"]}
    for r in json.loads(review_json.read_text())["episodes"]:
        inv = inventory[r["id"]]
        mtime_ns = inv["source"]["mtimeMs"] * 1_000_000 if "mtimeMs" in inv["source"] else None
        _add_episode(
            shows, inv["show"], inv["path"], inv["runtimeMs"],
            _recorded_identity(inv["source"].get("size"), mtime_ns),
            [_pilot_decision(d) for d in r["decisions"]], roots,
        )


def import_seeds(dataset_json: Path, pilot_review_json: Path, roots: list[Path] | None = None) -> dict[str, ShowLabels]:
    shows: dict[str, ShowLabels] = {}
    resolved_roots = roots or default_roots()
    _import_research(dataset_json, shows, resolved_roots)
    _import_pilot(pilot_review_json, shows, resolved_roots)
    for labels in shows.values():
        for entry in labels.episodes.values():
            entry.decisions = _dedupe(entry.decisions)
    return shows
