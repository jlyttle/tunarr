import json
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from breakdetect.media import file_identity, identity_key, probe, relative_path

PROBE_WORKERS = 8


class DurationCache:
    def __init__(self, file: Path, roots: list[Path]):
        self.file = file
        self.roots = roots
        self.known: dict[str, int] = json.loads(file.read_text()) if file.exists() else {}

    def _key(self, path: Path) -> str:
        return f"{relative_path(path, self.roots)}|{identity_key(file_identity(path))}"

    def lookup(self, paths: list[Path]) -> dict[Path, int]:
        keys = {path: self._key(path) for path in paths}
        missing = [path for path, key in keys.items() if key not in self.known]
        if missing:
            with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
                for path, duration in zip(missing, pool.map(lambda p: probe(p).duration_ms, missing)):
                    self.known[keys[path]] = duration
            self._save()
        return {path: self.known[key] for path, key in keys.items()}

    def _save(self) -> None:
        self.file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.file.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(self.known, out)
            os.replace(tmp, self.file)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
