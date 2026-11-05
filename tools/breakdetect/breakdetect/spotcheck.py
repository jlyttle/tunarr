import json
import os
import tempfile
from pathlib import Path

from breakdetect.export import marker_path
from breakdetect.labels import data_dir

VERDICTS = {"good", "bad"}
SAMPLE_SIZE = 8


def spotcheck_path(show_slug: str) -> Path:
    return data_dir() / "spotcheck" / f"{show_slug}.json"


def load_marker(show_slug: str) -> dict | None:
    path = marker_path(show_slug)
    return json.loads(path.read_text()) if path.exists() else None


def sample_episodes(marker: dict, labelled: set[str], count: int = SAMPLE_SIZE) -> list[dict]:
    eligible = [e for e in marker["episodes"] if e["breaks"] and e["relativePath"] not in labelled]
    step = max(1, len(eligible) // count)
    return [{"rel": e["relativePath"], "cuts_ms": [b["offsetMs"] for b in e["breaks"]]} for e in eligible[::step][:count]]


def load_verdicts(show_slug: str) -> dict[str, dict[int, str]]:
    path = spotcheck_path(show_slug)
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    return {rel: {int(ms): v for ms, v in cuts.items()} for rel, cuts in raw.items()}


def save_verdict(show_slug: str, rel: str, cut_ms: int, verdict: str) -> None:
    if verdict not in VERDICTS:
        raise ValueError(f"verdict must be one of {sorted(VERDICTS)}")
    verdicts = load_verdicts(show_slug)
    verdicts.setdefault(rel, {})[cut_ms] = verdict
    path = spotcheck_path(show_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(verdicts, f, indent=2, ensure_ascii=False, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
