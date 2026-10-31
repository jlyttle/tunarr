import hashlib
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from breakdetect.features import EXTRACTOR_VERSION, Features, extract_features, load_features, save_features
from breakdetect.media import default_roots, file_identity, relative_path

CACHE_ENV = "BREAKDETECT_CACHE"


def default_cache_root() -> Path:
    configured = os.environ.get(CACHE_ENV)
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[3] / ".local" / "breakdetect" / "features"


class FeatureCache:
    def __init__(self, root: Path, roots: list[Path] | None = None):
        self.root = root
        self.roots = roots if roots is not None else default_roots()

    def rel_path(self, path: Path) -> str:
        return relative_path(path, self.roots)

    def key(self, path: Path) -> str:
        raw = f"{self.rel_path(path)}|{file_identity(path)}|{EXTRACTOR_VERSION}"
        return hashlib.sha1(raw.encode()).hexdigest()

    def _entry(self, path: Path) -> Path:
        key = self.key(path)
        return self.root / key[:2] / f"{key}.npz"

    def get(self, path: Path) -> Features | None:
        entry = self._entry(path)
        return load_features(entry) if entry.exists() else None

    def ensure(self, path: Path, **extract_kwargs) -> Features:
        cached = self.get(path)
        if cached is not None:
            return cached
        features = extract_features(path, **extract_kwargs)
        self._store(path, features)
        return features

    def _store(self, path: Path, features: Features) -> None:
        entry = self._entry(path)
        entry.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=entry.parent, suffix=".tmp.npz")
        os.close(fd)
        try:
            save_features(features, Path(tmp))
            os.replace(tmp, entry)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise


@dataclass
class BatchResult:
    rel_path: str
    status: str
    seconds: float
    error: str | None = None
    media_seconds: float = 0.0


def _process(path: Path, cache: FeatureCache, hwaccel: str | None) -> BatchResult:
    started = time.monotonic()
    try:
        rel = cache.rel_path(path)
    except ValueError as e:
        return BatchResult(str(path), "failed", 0.0, str(e))
    try:
        was_cached = cache.get(path) is not None
        features = cache.ensure(path, hwaccel=hwaccel)
    except Exception as e:
        return BatchResult(rel, "failed", time.monotonic() - started, f"{type(e).__name__}: {e}")
    status = "cached" if was_cached else "extracted"
    return BatchResult(rel, status, time.monotonic() - started, None, features.duration_ms / 1000)


def run_batch(paths: list[Path], workers: int, hwaccel: str | None, cache: FeatureCache) -> list[BatchResult]:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda p: _process(p, cache, hwaccel), paths))
