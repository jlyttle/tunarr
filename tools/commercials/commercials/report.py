import json
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime
from pathlib import Path


@dataclass
class Report:
    added: list[str]
    retired: list[str]
    rejected_by_reason: dict[str, int]
    pool_hours: dict[str, float]
    failures: list[str]
    started: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    # one row per compilation: video_id, title, status, segments, accepted, promo_scored, promo_dropped
    compilations: list[dict] = field(default_factory=list)
    uptime_before: str | None = None
    uptime_after: str | None = None
    delivery: dict = field(default_factory=dict)
    sync: dict[str, str] = field(default_factory=dict)
    # video ids whose info.json chapters did not match the downloaded file (treated as no chapters)
    chapters_unreliable: list[str] = field(default_factory=list)

    @classmethod
    def from_json(cls, d: dict) -> "Report":
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in names})


def _stamp(started: str) -> str:
    return started.replace(":", "")


def markdown(r: Report) -> str:
    rejected = sum(r.rejected_by_reason.values())
    out = [
        f"# Commercials run {r.started}",
        "",
        f"Added: {len(r.added)} · Retired: {len(r.retired)} · Rejected: {rejected} · Failures: {len(r.failures)}",
        "",
        "## Pool hours",
        "",
        "| Pool | Hours |",
        "| --- | --- |",
        *(f"| {pool} | {hours:.2f} |" for pool, hours in sorted(r.pool_hours.items())),
        "",
        "## Rejections",
        "",
    ]
    if r.rejected_by_reason:
        out += ["| Reason | Segments |", "| --- | --- |"]
        out += [f"| {k} | {v} |" for k, v in sorted(r.rejected_by_reason.items())]
    else:
        out.append("None.")
    out += ["", "## Compilations", ""]
    if r.compilations:
        out += ["| Video | Title | Status | Segments | Accepted | Promo dropped |",
                "| --- | --- | --- | --- | --- | --- |"]
        for c in r.compilations:
            scored = c.get("promo_scored", 0)
            dropped = c.get("promo_dropped", 0)
            share = f"{dropped}/{scored} ({dropped / scored:.0%})" if scored else "0/0"
            out.append(f"| {c.get('video_id')} | {c.get('title', '')} | {c.get('status')} | "
                       f"{c.get('segments', 0)} | {c.get('accepted', 0)} | {share} |")
    else:
        out.append("None processed.")
    if r.chapters_unreliable:
        out += ["", f"Chapters unreliable (ignored): {', '.join(r.chapters_unreliable)}"]
    out += [
        "",
        "## Delivery and sync",
        "",
        f"- Unraid uptime before: {r.uptime_before or 'not checked'}",
        f"- Unraid uptime after: {r.uptime_after or 'not checked'}",
        f"- Delivery: {', '.join(f'{k} {v}' for k, v in sorted(r.delivery.items())) or 'skipped'}",
        f"- Sync: {', '.join(f'{k} {v}' for k, v in sorted(r.sync.items())) or 'skipped'}",
        "",
        "## Failures",
        "",
        *([f"- {f}" for f in r.failures] or ["None."]),
        "",
    ]
    return "\n".join(out)


def write_report(r: Report, dir: Path) -> Path:
    """Write `<started>.json` and `<started>.md` into `dir`; returns the JSON path."""
    dir.mkdir(parents=True, exist_ok=True)
    path = dir / f"{_stamp(r.started)}.json"
    n = 1
    while path.exists():  # two runs in the same second keep separate reports
        n += 1
        path = dir / f"{_stamp(r.started)}-{n}.json"
    path.write_text(json.dumps(asdict(r), indent=2) + "\n")
    path.with_suffix(".md").write_text(markdown(r))
    return path


def latest_report(dir: Path) -> Report | None:
    files = sorted(dir.glob("*.json"), key=lambda f: (f.stat().st_mtime, f.name)) if dir.exists() else []
    return Report.from_json(json.loads(files[-1].read_text())) if files else None
