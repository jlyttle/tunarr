import argparse
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

from commercials import deliver as deliver_mod
from commercials import discover as discover_mod
from commercials import download as download_mod
from commercials import encode as enc
from commercials import fingerprint as fpr
from commercials import promo_filter as promo
from commercials import split
from commercials import tunarr_sync as ts
from commercials.catalog import Catalog, load_catalog
from commercials.deliver import HOST, SSH
from commercials.paths import media_root, state_root
from commercials.report import latest_report, markdown
from commercials.retention import POOLS
from commercials.runner import (
    PLEX_URL,
    RunContext,
    RunOptions,
    Tools,
    describe,
    fetch_plex_token,
    redact,
    run,
)

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
PLEX_HOST_ROOT = "/mnt/user/plex"  # the Plex container sees it as /data
PLEX_CONTAINER_ROOT = "/data"
PLEX_SETTLE_S = 60  # let Plex index the refreshed folder before Tunarr scans it


def _ffmpeg(args: list[str]) -> str:
    """Run ffmpeg and return its stderr."""
    return subprocess.run(["ffmpeg", *args], capture_output=True, text=True, errors="replace",
                          check=True).stderr


def _ffmpeg_ok(args: list[str]) -> None:
    _ffmpeg(args)


def _duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return float(out.strip())


def _uptime() -> str:
    return subprocess.run([SSH, "-o", "ConnectTimeout=15", HOST, "uptime"],
                          capture_output=True, text=True, check=True, timeout=60).stdout.strip()


def plex_folder(unraid_root: str) -> str:
    """The Plex-side path of a host folder under /mnt/user/plex."""
    if not unraid_root.startswith(PLEX_HOST_ROOT + "/"):
        raise ValueError(f"unraid_root {unraid_root!r} is not under {PLEX_HOST_ROOT}")
    return PLEX_CONTAINER_ROOT + unraid_root[len(PLEX_HOST_ROOT):]


def _sync(cfg: dict, catalog: Catalog, active: dict[str, set[str]]) -> dict[str, str]:
    """Plex partial refresh, Tunarr library scan, then replace each pool's filler list."""
    token = fetch_plex_token()
    try:
        plex = cfg["plex"]
        tunarr = cfg["tunarr"]
        ts.plex_refresh(ts.plex_refresh_url(PLEX_URL, token, str(plex["section_key"]),
                                             plex_folder(cfg["unraid_root"])))
        time.sleep(PLEX_SETTLE_S)
        client = ts.TunarrClient(tunarr["base_url"])
        client.scan_library(tunarr["media_source_id"], tunarr["library_id"])
        out = {}
        for pool in POOLS:
            delivered = {i for i in active.get(pool, set()) if pool in catalog.ads[i].delivered}
            r = ts.sync_with_retry(client, cfg["filler_list_ids"].get(pool), pool, delivered,
                                   library_id=tunarr["library_id"])
            out[pool] = "updated" if r.updated else (r.reason or "not_updated")
        return out
    except Exception as e:
        raise RuntimeError(redact(describe(e), token)) from None


def real_tools(config_dir: Path) -> Tools:
    refs: list[promo.NetworkRefs] | None = None

    def promo_score(path: Path, start: float, end: float) -> float:
        nonlocal refs
        if refs is None:
            refs = promo.load_refs(config_dir / "network_refs")
        return promo.score_segment(path, start, end, refs)

    return Tools(
        discover=lambda sources, catalog, since: discover_mod.discover(sources, catalog, since),
        download=download_mod.download,
        duration=_duration,
        detect=lambda p: _ffmpeg(split.detect_args(p)),
        cut=lambda src, seg, dest: _ffmpeg_ok(split.cut_args(src, seg, dest)),
        promo_score=promo_score,
        probe=enc.probe_streams,
        mean_volume=lambda p: enc.parse_mean_volume(_ffmpeg(enc.volumedetect_args(p))),
        loudness=lambda p: enc.parse_loudnorm(_ffmpeg(enc.loudnorm_measure_args(p))),
        encode=lambda src, dest, measured: _ffmpeg_ok(enc.encode_args(src, dest, measured)),
        fingerprint=fpr.fingerprint_file,
        uptime=_uptime,
        deliver=deliver_mod.deliver,
        sync=_sync,
    )


def cmd_run(args: argparse.Namespace) -> int:
    ctx = RunContext(media=media_root(), state=state_root(), config_dir=CONFIG_DIR, today=date.today())
    opts = RunOptions(dry_run=args.dry_run, deliver=not args.no_deliver, sync=not args.no_sync,
                      limit=args.limit, since_weeks=args.since_weeks)
    report = run(opts, ctx, real_tools(CONFIG_DIR))
    if not opts.dry_run:
        print(markdown(report))
    return 1 if report.failures else 0


def cmd_add_ref(args: argparse.Namespace) -> int:
    promo.add_reference(args.network, Path(args.clip), CONFIG_DIR / "network_refs")
    print(f"added {args.clip} to {args.network} references")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    catalog = load_catalog(state_root() / "catalog.json")
    for pool in POOLS:
        ads = [a for a in catalog.ads.values() if a.status == "active" and pool in a.pools]
        print(f"{pool}: {len(ads)} active ads, {sum(a.duration_s for a in ads) / 3600:.2f} h")
    counts: dict[str, int] = {}
    for c in catalog.compilations.values():
        counts[c.status] = counts.get(c.status, 0) + 1
    print("compilations: " + (", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "none"))
    last = latest_report(state_root() / "reports")
    if last is None:
        print("last run: none")
    else:
        print(f"last run: {last.started}: added {len(last.added)}, retired {len(last.retired)}, "
              f"rejected {sum(last.rejected_by_reason.values())}, failures {len(last.failures)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="commercials")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="discover, split, encode, deliver and sync")
    r.add_argument("--dry-run", action="store_true", help="show what would happen; write nothing")
    r.add_argument("--no-deliver", action="store_true", help="skip Unraid delivery and uptime checks")
    r.add_argument("--no-sync", action="store_true", help="skip the Plex and Tunarr sync")
    r.add_argument("--limit", type=int, default=10, help="max compilations processed this run")
    r.add_argument("--since-weeks", type=int, default=8, help="only discover uploads this recent")
    r.set_defaults(func=cmd_run)
    a = sub.add_parser("add-ref", help="add a hand-picked network promo clip to the references")
    a.add_argument("network")
    a.add_argument("clip")
    a.set_defaults(func=cmd_add_ref)
    s = sub.add_parser("status", help="pool hours and the last run")
    s.set_defaults(func=cmd_status)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
