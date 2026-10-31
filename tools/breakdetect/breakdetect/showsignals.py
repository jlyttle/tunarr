import hashlib
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import Candidate, find_candidates
from breakdetect.features import Features
from breakdetect.labels import slugify
from breakdetect.media import discover_episodes
from breakdetect.series import SeriesContext, build_series_context_from
from breakdetect.signals import SIGNAL_NAMES, SIGNALS_VERSION, candidate_signals

ShowSignals = dict[str, tuple[list[Candidate], np.ndarray]]


def signals_dir(cache: FeatureCache) -> Path:
    return cache.root.parent / "signals"


def _cached_paths(cache: FeatureCache, show_dir: Path) -> list[Path]:
    return [p for p in discover_episodes(show_dir) if cache.has(p)]


def _signals_key(cache: FeatureCache, paths: list[Path]) -> str:
    entries = sorted((cache.rel_path(p), cache.key(p)) for p in paths)
    return hashlib.sha1(repr((SIGNALS_VERSION, entries)).encode()).hexdigest()


def _load_cached(cache: FeatureCache, path: Path) -> Features:
    features = cache.get(path)
    if features is None:
        raise FileNotFoundError(f"features vanished from cache: {path}")
    return features


def _context(cache: FeatureCache, paths: list[Path]) -> SeriesContext:
    def items() -> Iterable[tuple[str, Features, list[Candidate]]]:
        for path in paths:
            features = _load_cached(cache, path)
            yield cache.rel_path(path), features, find_candidates(features)

    return build_series_context_from(items())


def _compute(cache: FeatureCache, paths: list[Path]) -> ShowSignals:
    ctx = _context(cache, paths)
    result: ShowSignals = {}
    for path in paths:
        rel = cache.rel_path(path)
        features = _load_cached(cache, path)
        candidates = find_candidates(features)
        rows = [candidate_signals(c, features, ctx, rel) for c in candidates]
        result[rel] = (candidates, np.array(rows, dtype=np.float64).reshape(-1, len(SIGNAL_NAMES)))
    return result


def _pack(result: ShowSignals) -> dict[str, np.ndarray]:
    rels = list(result)
    candidates = [c for rel in rels for c in result[rel][0]]
    return {
        "rels": np.array(rels, dtype=np.str_),
        "counts": np.array([len(result[rel][0]) for rel in rels], dtype=np.int64),
        "spans": np.array([[c.start_ms, c.end_ms, c.cut_ms] for c in candidates], dtype=np.int64).reshape(-1, 3),
        "kinds": np.array([c.kind for c in candidates], dtype=np.str_),
        "min_luma": np.array([c.min_luma for c in candidates], dtype=np.float64),
        "min_rms_db": np.array([np.nan if c.min_rms_db is None else c.min_rms_db for c in candidates], dtype=np.float64),
        "signals": np.vstack([result[rel][1] for rel in rels]) if rels else np.empty((0, len(SIGNAL_NAMES))),
    }


def _unpack(z: dict[str, np.ndarray]) -> ShowSignals:
    result: ShowSignals = {}
    start = 0
    for rel, count in zip(z["rels"], z["counts"]):
        rows = range(start, start + int(count))
        candidates = [
            Candidate(
                int(z["spans"][i][0]),
                int(z["spans"][i][1]),
                int(z["spans"][i][2]),
                str(z["kinds"][i]),
                float(z["min_luma"][i]),
                None if np.isnan(z["min_rms_db"][i]) else float(z["min_rms_db"][i]),
            )
            for i in rows
        ]
        result[str(rel)] = (candidates, z["signals"][start : start + int(count)])
        start += int(count)
    return result


def _store(result: ShowSignals, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, suffix=".tmp.npz")
    os.close(fd)
    try:
        np.savez_compressed(tmp, **_pack(result))
        os.replace(tmp, dest)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def show_signals(show_dir: Path, cache: FeatureCache) -> ShowSignals:
    paths = _cached_paths(cache, show_dir)
    dest = signals_dir(cache) / f"{slugify(show_dir.name)}-{_signals_key(cache, paths)}.npz"
    if dest.exists():
        with np.load(dest, allow_pickle=False) as z:
            return _unpack({name: z[name] for name in z.files})
    result = _compute(cache, paths)
    _store(result, dest)
    return result
