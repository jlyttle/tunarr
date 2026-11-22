"""The daily pipeline: discover, download, split, filter, encode, retain, deliver, sync, report.

All side effects go through `Tools`, so tests can swap in fakes. `cli.real_tools` binds
the real ffmpeg / yt-dlp / ssh / HTTP implementations.
"""
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from commercials.catalog import Catalog, Compilation, load_catalog, save_catalog
from commercials.deliver import HOST, SSH, DeliveryPlan, plan_delivery
from commercials.discover import Sources, load_sources
from commercials.download import info_path
from commercials.encode import StreamInfo, precheck
from commercials.fingerprint import find_match, record_segment
from commercials.pools import apply_blocklist, chapter_text_for, load_blocklist
from commercials.promo_filter import promo_verdict
from commercials.report import Report, write_report
from commercials.retention import POOLS, select_active
from commercials.split import (
    Segment,
    boundaries,
    parse_blackdetect,
    parse_chapters,
    parse_silencedetect,
    require_single_chapter,
    segments,
)

PENDING = ("new", "downloaded", "failed")
MIN_KEEP_S = 0.1  # rejected segments shorter than this are counted but not cut

PLEX_URL = "http://192.168.1.227:32400"
PLEX_TOKEN_ENV = "COMMERCIALS_PLEX_TOKEN"
_TOKEN = re.compile(r'PlexOnlineToken="([^"]+)"')
PLEX_TOKEN_CMD = (
    "dir=$(docker inspect plex --format "
    "'{{range .Mounts}}{{if eq .Destination \"/config\"}}{{.Source}}{{end}}{{end}}') && "
    "grep -o 'PlexOnlineToken=\"[^\"]*\"' "
    "\"$dir/Library/Application Support/Plex Media Server/Preferences.xml\""
)


@dataclass
class RunOptions:
    dry_run: bool = False
    deliver: bool = True
    sync: bool = True
    limit: int = 10
    since_weeks: int = 8


@dataclass
class RunContext:
    media: Path
    state: Path
    config_dir: Path
    today: date


@dataclass
class Tools:
    discover: Callable[[Sources, Catalog, date], list[Compilation]]
    download: Callable[[str, Path], Path]
    duration: Callable[[Path], float]
    detect: Callable[[Path], str]  # ffmpeg stderr of split.detect_args
    cut: Callable[[Path, Segment, Path], None]
    promo_score: Callable[[Path, float, float], float]
    probe: Callable[[Path], StreamInfo]
    mean_volume: Callable[[Path], float]
    loudness: Callable[[Path], dict]
    encode: Callable[[Path, Path, dict], None]
    fingerprint: Callable[[Path], list[int]]
    uptime: Callable[[], str]
    deliver: Callable[[Catalog, dict[str, set[str]], str], DeliveryPlan]
    sync: Callable[[dict, Catalog, dict[str, set[str]]], dict[str, str]]


def log(msg: str) -> None:
    print(msg, flush=True)


def describe(e: BaseException) -> str:
    return f"{type(e).__name__}: {e}"


def redact(msg: str, secret: str | None) -> str:
    return msg.replace(secret, "<redacted>") if secret else msg


def parse_plex_token(text: str) -> str:
    m = _TOKEN.search(text)
    if m is None:
        raise ValueError("no PlexOnlineToken in Plex Preferences.xml")
    return m.group(1)


def _ssh_stdout(cmd: str) -> str:
    return subprocess.run(
        [SSH, "-o", "ConnectTimeout=15", HOST, cmd],
        capture_output=True, text=True, check=True, timeout=60,
    ).stdout


def fetch_plex_token(run_ssh: Callable[[str], str] = _ssh_stdout) -> str:
    """Plex token from $COMMERCIALS_PLEX_TOKEN, else the Plex container's Preferences.xml.

    Kept in memory only: never log, print or store it.
    """
    env = os.environ.get(PLEX_TOKEN_ENV)
    if env:
        return env
    try:
        out = run_ssh(PLEX_TOKEN_CMD)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"could not read the Plex token over ssh (exit {e.returncode})") from None
    return parse_plex_token(out)


def sync_configured(cfg: dict) -> bool:
    lists = cfg.get("filler_list_ids") or {}
    tunarr = cfg.get("tunarr") or {}
    return (
        all(lists.get(p) for p in POOLS)
        and bool((cfg.get("plex") or {}).get("section_key"))
        and bool(tunarr.get("media_source_id"))
        and bool(tunarr.get("library_id"))
    )


def pending_compilations(catalog: Catalog, limit: int) -> list[Compilation]:
    """New and half-done compilations, newest first; failed ones are retried last."""
    pend = [c for c in catalog.compilations.values() if c.status in PENDING]
    pend.sort(key=lambda c: (c.status == "failed", -c.upload_date.toordinal(), c.video_id))
    return pend[:limit]


def pool_hours(catalog: Catalog, active: dict[str, set[str]]) -> dict[str, float]:
    return {
        pool: sum(catalog.ads[i].duration_s for i in ids) / 3600
        for pool, ids in sorted(active.items())
    }


def _read_info(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


class _Compilation:
    """Processes one downloaded compilation into ads and rejects."""

    def __init__(self, comp: Compilation, catalog: Catalog, ctx: RunContext, tools: Tools,
                 blocklist: list[str], report: Report):
        self.comp, self.catalog, self.ctx, self.tools = comp, catalog, ctx, tools
        self.blocklist, self.report = blocklist, report
        self.row = {"video_id": comp.video_id, "title": comp.title, "pools": sorted(comp.pools),
                    "status": comp.status, "segments": 0, "accepted": 0, "new_ads": 0,
                    "promo_scored": 0, "promo_dropped": 0}

    def run(self) -> None:
        c, t = self.comp, self.tools
        mkv = t.download(c.video_id, self.ctx.media / "downloads")
        c.status = "downloaded"
        info = _read_info(info_path(mkv))
        self.chapters = info.get("chapters") or []
        chapter_times = parse_chapters(info)
        dur = t.duration(mkv)
        stderr = t.detect(mkv)
        segs = segments(boundaries(parse_blackdetect(stderr), parse_silencedetect(stderr), dur,
                                   chapters=chapter_times))
        if "kids" in c.pools:
            segs = require_single_chapter(segs, [0.0, *chapter_times] if self.chapters else [], dur)
        self.row["segments"] = len(segs)
        for seg in segs:
            self._segment(mkv, seg)
        c.status = "split"
        self.row["status"] = "split"

    def _name(self, seg: Segment) -> str:
        return f"{self.comp.video_id}-{seg.start:.3f}"

    def _reject(self, reason: str) -> None:
        self.report.rejected_by_reason[reason] = self.report.rejected_by_reason.get(reason, 0) + 1

    def _rejected_path(self, reason: str, seg: Segment) -> Path:
        d = self.ctx.media / "rejected" / reason
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{self._name(seg)}.mkv"

    def _segment(self, mkv: Path, seg: Segment) -> None:
        reason = seg.reject_reason
        if reason is None:
            self.row["promo_scored"] += 1
            reason = promo_verdict(self.tools.promo_score(mkv, seg.start, seg.end))
            if reason is not None:
                self.row["promo_dropped"] += 1
        if reason is not None:
            self._reject(reason)
            if seg.end - seg.start >= MIN_KEEP_S:
                try:
                    self.tools.cut(mkv, seg, self._rejected_path(reason, seg))
                except subprocess.CalledProcessError:
                    pass  # the reason is counted; the kept copy is only for tuning
            return
        cuts = self.ctx.media / "cuts"
        cuts.mkdir(parents=True, exist_ok=True)
        cut = cuts / f"{self._name(seg)}.mkv"
        self.tools.cut(mkv, seg, cut)
        reason = self._accept(cut, seg)
        if reason is not None:
            self._reject(reason)
            shutil.move(cut, self._rejected_path(reason, seg))
        else:
            self.row["accepted"] += 1
            cut.unlink(missing_ok=True)

    def _accept(self, cut: Path, seg: Segment) -> str | None:
        """Precheck, fingerprint, encode and record one cut. Returns a reject reason or None."""
        t = self.tools
        try:
            info = t.probe(cut)
        except subprocess.CalledProcessError:
            return "probe_failed"
        if not info.has_audio:
            return "no_audio"
        try:
            volume = t.mean_volume(cut)
        except subprocess.CalledProcessError:
            return "probe_failed"
        if (reason := precheck(info, volume)) is not None:
            return reason
        try:
            fp = t.fingerprint(cut)
        except (subprocess.CalledProcessError, ValueError, KeyError):
            return "fingerprint_failed"
        if not fp:
            return "fingerprint_failed"
        pools = apply_blocklist(chapter_text_for(seg.start, self.chapters), self.comp.pools, self.blocklist)
        meta = {"source": self.comp.video_id, "duration_s": round(seg.end - seg.start, 3),
                "height": info.height}
        match = find_match(fp, self.catalog)
        if match is not None and self.catalog.ads[match].height >= info.height:
            meta["local_path"] = self.catalog.ads[match].local_path  # duplicate: no re-encode
        else:
            ads = self.ctx.media / "ads"
            ads.mkdir(parents=True, exist_ok=True)
            dest = ads / f"{self._name(seg)}.mp4"
            try:
                t.encode(cut, dest, t.loudness(cut))
            except (subprocess.CalledProcessError, ValueError, KeyError):
                dest.unlink(missing_ok=True)
                return "encode_failed"
            meta["local_path"] = str(dest)
        ad_id, new = record_segment(self.catalog, fp, meta, pools, self.comp.upload_date)
        if new:
            self.report.added.append(ad_id)
            self.row["new_ads"] += 1
        return None


def _dry_run(catalog: Catalog, pending: list[Compilation], ctx: RunContext, cfg: dict) -> None:
    log(f"dry run: {len(pending)} compilation(s) would be processed")
    for c in pending:
        log(f"  {c.video_id} [{','.join(sorted(c.pools))}] {c.status} {c.upload_date} {c.title}")
    active = select_active(catalog, ctx.today)  # in memory only; nothing is saved
    for pool, hours in pool_hours(catalog, active).items():
        log(f"  pool {pool}: {len(active[pool])} ads, {hours:.2f} h")
    root = cfg.get("unraid_root")
    if root:
        plan = plan_delivery(catalog, active, root)
        log(f"  delivery: {len(plan.push)} push, {len(plan.delete)} delete")


def _uptime(tools: Tools, report: Report) -> str | None:
    try:
        return tools.uptime()
    except Exception as e:
        report.failures.append(f"uptime: {describe(e)}")
        return None


def run(opts: RunOptions, ctx: RunContext, tools: Tools) -> Report:
    sources_path = ctx.config_dir / "sources.json"
    cfg = json.loads(sources_path.read_text())
    sources = load_sources(sources_path)
    blocklist = load_blocklist(ctx.config_dir / "blocklist.json")
    cat_path = ctx.state / "catalog.json"
    catalog = load_catalog(cat_path)
    report = Report(added=[], retired=[], rejected_by_reason={}, pool_hours={}, failures=[])

    try:
        for c in tools.discover(sources, catalog, ctx.today - timedelta(weeks=opts.since_weeks)):
            catalog.upsert_compilation(c)
    except Exception as e:
        report.failures.append(f"discover: {describe(e)}")
    pending = pending_compilations(catalog, opts.limit)

    if opts.dry_run:
        _dry_run(catalog, pending, ctx, cfg)
        return report

    for i, comp in enumerate(pending, 1):
        log(f"[{i}/{len(pending)}] {comp.video_id} {comp.title}")
        job = _Compilation(comp, catalog, ctx, tools, blocklist, report)
        try:
            job.run()
        except Exception as e:
            comp.status = "failed"
            job.row["status"] = "failed"
            job.row["error"] = describe(e)
            report.failures.append(f"{comp.video_id}: {describe(e)}")
            log(f"  failed: {describe(e)}")
        report.compilations.append(job.row)
        save_catalog(catalog, cat_path)

    before = {i: a.status for i, a in catalog.ads.items()}
    active = select_active(catalog, ctx.today)
    report.retired = sorted(i for i, a in catalog.ads.items()
                            if a.status == "retired" and before.get(i) == "active")
    report.pool_hours = pool_hours(catalog, active)
    save_catalog(catalog, cat_path)

    reachable = True
    if opts.deliver:
        report.uptime_before = _uptime(tools, report)
        reachable = report.uptime_before is not None
        if reachable:
            try:
                plan = tools.deliver(catalog, active, cfg["unraid_root"])
                pushed = sum(1 for ad_id, pool, remote in plan.push
                             if catalog.ads[ad_id].delivered.get(pool) == remote)
                still = {r for a in catalog.ads.values() for r in a.delivered.values()}
                report.delivery = {"pushed": pushed, "push_failed": len(plan.push) - pushed,
                                   "deleted": sum(1 for r in plan.delete if r not in still)}
            except Exception as e:
                report.failures.append(f"deliver: {describe(e)}")
            save_catalog(catalog, cat_path)
        else:
            report.delivery = {"status": "skipped_unreachable"}

    if not opts.sync:
        report.sync = {"status": "skipped"}
    elif not sync_configured(cfg):
        report.sync = {"status": "not_configured"}
    elif not reachable:
        report.sync = {"status": "skipped_unreachable"}
    else:
        try:
            report.sync = tools.sync(cfg, catalog, active)
        except Exception as e:
            report.failures.append(f"sync: {describe(e)}")
            report.sync = {"status": "failed"}

    if opts.deliver and reachable:
        report.uptime_after = _uptime(tools, report)

    path = write_report(report, ctx.state / "reports")
    log(f"report: {path}")
    return report

