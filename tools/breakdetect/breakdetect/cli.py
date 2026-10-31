import argparse
import sys
from pathlib import Path

from breakdetect.cache import BatchResult, FeatureCache, default_cache_root, run_batch
from breakdetect.labels import import_seeds, save_labels
from breakdetect.media import discover_episodes

HWACCELS = ["auto", "videotoolbox", "vaapi", "qsv"]


def _expand(inputs: list[Path]) -> list[Path]:
    return [p for item in inputs for p in (discover_episodes(item) if item.is_dir() else [item])]


def _format_result(r: BatchResult) -> str:
    detail = r.error if r.status == "failed" else f"{r.seconds:.1f}s"
    return f"{r.status:9} {r.rel_path}  {detail}"


def _summary(results: list[BatchResult]) -> str:
    extracted = [r for r in results if r.status == "extracted"]
    failed = sum(r.status == "failed" for r in results)
    total = sum(r.seconds for r in extracted)
    media_minutes = sum(r.media_seconds for r in extracted) / 60
    per_minute = f"{total / media_minutes:.2f}" if media_minutes else "n/a"
    return (
        f"{len(results)} episodes: {len(extracted)} extracted, "
        f"{len(results) - len(extracted) - failed} cached, {failed} failed; "
        f"{total:.1f}s extraction, {per_minute} s per media-minute"
    )


def _extract(args: argparse.Namespace) -> int:
    cache = FeatureCache(args.cache)
    results = run_batch(_expand(args.paths), args.workers, args.hwaccel, cache)
    for r in results:
        print(_format_result(r))
    print(_summary(results))
    return 1 if any(r.status == "failed" for r in results) else 0


def _import_seeds(args: argparse.Namespace) -> int:
    imported = import_seeds(args.dataset, args.pilot_review)
    for labels in imported.values():
        save_labels(labels)
        print(f"{labels.show}: {len(labels.episodes)} episodes")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="breakdetect")
    sub = parser.add_subparsers(dest="command", required=True)
    extract = sub.add_parser("extract", help="extract and cache features")
    extract.add_argument("paths", nargs="+", type=Path)
    extract.add_argument("--workers", type=int, default=2)
    extract.add_argument("--hwaccel", choices=HWACCELS)
    extract.add_argument("--cache", type=Path, default=default_cache_root())
    extract.set_defaults(handler=_extract)
    seeds = sub.add_parser("import-seeds", help="import seed labels from the research dataset and pilot review")
    seeds.add_argument("dataset", type=Path)
    seeds.add_argument("pilot_review", type=Path)
    seeds.set_defaults(handler=_import_seeds)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
