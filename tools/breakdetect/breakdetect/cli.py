import argparse
import sys
from pathlib import Path

from breakdetect.cache import BatchResult, FeatureCache, default_cache_root, run_batch
from breakdetect.evaluate import evaluate, format_table, save_evaluation, show_dirs_to_slugs, thresholds_out_of_date, write_report
from breakdetect.labels import import_seeds, load_or_empty, merge_labels, save_labels
from breakdetect.media import default_roots, discover_episodes
from breakdetect.review.server import make_server
from breakdetect.train import model_path, train

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
    for slug, incoming in imported.items():
        labels = merge_labels(load_or_empty(slug, incoming.show), incoming)
        save_labels(labels)
        print(f"{labels.show}: {len(labels.episodes)} episodes")
    return 0


def _review(args: argparse.Namespace) -> int:
    server = make_server(args.show_dir, FeatureCache(args.cache), args.port)
    print(f"Reviewing {args.show_dir.name} at http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
    return 0


def _train(args: argparse.Namespace) -> int:
    try:
        episodes, positives, negatives = train(FeatureCache(args.cache), default_roots())
    except ValueError as e:
        print(f"train: {e}", file=sys.stderr)
        return 1
    print(f"trained on {episodes} episodes: {positives} positives, {negatives} negatives")
    if thresholds_out_of_date(model_path().read_text()):
        print("warning: thresholds.json was computed for a different model; run `breakdetect evaluate` to refresh", file=sys.stderr)
    return 0


def _evaluate(args: argparse.Namespace) -> int:
    cache = FeatureCache(args.cache)
    evaluation = evaluate(cache, default_roots())
    save_evaluation(evaluation)
    requested = show_dirs_to_slugs(args.show_dirs)
    known = {r.show for r in evaluation.reports}
    missing = [s for s in requested or [] if s not in known]
    for slug in missing:
        print(f"evaluate: no label file for {slug}", file=sys.stderr)
    shown = [r for r in evaluation.reports if requested is None or r.show in requested]
    print(format_table(shown))
    print(f"report: {write_report(evaluation.reports, cache)}")
    return 1 if missing else 0


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
    review = sub.add_parser("review", help="serve the local break review page")
    review.add_argument("show_dir", type=Path)
    review.add_argument("--port", type=int, default=8765)
    review.add_argument("--cache", type=Path, default=default_cache_root())
    review.set_defaults(handler=_review)
    fit = sub.add_parser("train", help="fit the scoring model on complete, non-held-out labelled episodes")
    fit.add_argument("--cache", type=Path, default=default_cache_root())
    fit.set_defaults(handler=_train)
    ev = sub.add_parser("evaluate", help="leave-one-episode-out evaluation and per-show precision gate")
    ev.add_argument("show_dirs", nargs="*", type=Path)
    ev.add_argument("--cache", type=Path, default=default_cache_root())
    ev.set_defaults(handler=_evaluate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
