import hashlib
import json
import mimetypes
import os
import subprocess
import tempfile
import threading
import unicodedata
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

from breakdetect.cache import FeatureCache
from breakdetect.candidates import find_candidates
from breakdetect.features import FPS, Features
from breakdetect.labels import DEDUPE_WINDOW_MS, Decision, EpisodeLabels, ShowLabels, load_or_empty, save_labels, slugify
from breakdetect.media import default_roots, discover_episodes, file_identity, relative_path

STATIC_DIR = Path(__file__).parent / "static"
LABELS = {"break", "not_break", "unsure"}
CLIP_BEFORE_MS = 5000
CLIP_SECONDS = 8
STRIP_OFFSETS_S = range(-4, 5)
STRIP_SCALE = 2
CHUNK = 1 << 20
PAGES = {"/": "index.html", "/episode": "episode.html", "/review.js": "review.js", "/review.css": "review.css"}


class HttpError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class ReviewApp:
    show_dir: Path
    cache: FeatureCache
    roots: list[Path]

    def __post_init__(self) -> None:
        self.show = self.show_dir.name
        self.slug = slugify(self.show)
        self.clips_dir = self.cache.root.parent / "clips"
        self.labels_lock = threading.Lock()
        self.extract_lock = threading.Lock()

    def resolve(self, rel: str | None) -> Path:
        if not rel or ".." in Path(rel).parts or Path(rel).is_absolute():
            raise HttpError(HTTPStatus.BAD_REQUEST, "invalid rel")
        path = self._find(rel)
        if path is None:
            raise HttpError(HTTPStatus.NOT_FOUND, "no such file")
        if not path.resolve().is_relative_to(self.show_dir.resolve()):
            raise HttpError(HTTPStatus.BAD_REQUEST, "path is outside the show")
        return path

    def _find(self, rel: str) -> Path | None:
        for root in self.roots:
            for form in ("NFC", "NFD"):
                path = root / unicodedata.normalize(form, rel)
                if path.is_file():
                    return path if path.resolve().is_relative_to(root.resolve()) else self._outside()
        return None

    def _outside(self) -> None:
        raise HttpError(HTTPStatus.BAD_REQUEST, "path is outside the roots")

    def features(self, path: Path) -> Features:
        with self.extract_lock:
            return self.cache.ensure(path)

    def show_summary(self) -> dict:
        labels = load_or_empty(self.slug, self.show)
        return {"show": self.show, "episodes": [self._episode_summary(p, labels) for p in discover_episodes(self.show_dir)]}

    def _episode_summary(self, path: Path, labels: ShowLabels) -> dict:
        rel = relative_path(path, self.roots)
        entry = labels.episodes.get(rel, EpisodeLabels())
        return {
            "rel": rel,
            "name": path.name,
            "complete": entry.complete,
            "held_out": entry.held_out,
            "decisions": len(entry.decisions),
            "user_decisions": sum(d.source == "user" for d in entry.decisions),
        }

    def episode(self, rel: str) -> dict:
        path = self.resolve(rel)
        features = self.features(path)
        entry = load_or_empty(self.slug, self.show).episodes.get(relative_path(path, self.roots), EpisodeLabels())
        return {
            "rel": rel,
            "name": path.name,
            "duration_ms": features.duration_ms,
            "complete": entry.complete,
            "held_out": entry.held_out,
            "rows": build_rows(features, entry.decisions),
        }

    def set_decision(self, rel: str, cut_ms: int, label: str) -> dict:
        if label not in LABELS:
            raise HttpError(HTTPStatus.BAD_REQUEST, "invalid label")
        path = self.resolve(rel)
        with self.labels_lock:
            labels = load_or_empty(self.slug, self.show)
            entry = self._entry(labels, path)
            entry.decisions = [d for d in entry.decisions if abs(d.cut_ms - cut_ms) > DEDUPE_WINDOW_MS]
            entry.decisions.append(Decision(cut_ms, label, "user"))
            entry.decisions.sort(key=lambda d: d.cut_ms)
            entry.complete = False
            save_labels(labels)
        return {"ok": True}

    def _entry(self, labels: ShowLabels, path: Path) -> EpisodeLabels:
        entry = labels.episodes.setdefault(relative_path(path, self.roots), EpisodeLabels())
        if not entry.identity:
            entry.identity = file_identity(path)
        return entry

    def complete(self, rel: str, complete: bool, held_out: bool) -> dict:
        path = self.resolve(rel)
        features = self.features(path)
        with self.labels_lock:
            labels = load_or_empty(self.slug, self.show)
            entry = self._entry(labels, path)
            if complete and not all_decided(build_rows(features, entry.decisions)):
                raise HttpError(HTTPStatus.CONFLICT, "every break needs a decision from you")
            entry.complete = complete
            entry.held_out = held_out
            entry.identity = file_identity(path)
            entry.duration_ms = features.duration_ms
            save_labels(labels)
        return {"ok": True}

    def clip(self, rel: str, ms: int) -> Path:
        path = self.resolve(rel)
        start_ms = max(0, ms - CLIP_BEFORE_MS)
        key = hashlib.sha1(f"{relative_path(path, self.roots)}|{file_identity(path)}|{start_ms}".encode()).hexdigest()
        out = self.clips_dir / key[:2] / f"{key}.mp4"
        if not out.exists():
            render_clip(path, start_ms, out)
        return out

    def strip(self, rel: str, ms: int) -> bytes:
        return encode_jpeg(strip_image(self.features(self.resolve(rel)), ms))


def all_decided(rows: list[dict]) -> bool:
    return all(r["decision"] is not None and r["decision"]["source"] == "user" for r in rows)


def _nearest_candidate(decision: Decision, candidates: list) -> int | None:
    near = [i for i, c in enumerate(candidates) if abs(c.cut_ms - decision.cut_ms) <= DEDUPE_WINDOW_MS]
    return min(near, key=lambda i: abs(candidates[i].cut_ms - decision.cut_ms)) if near else None


def _prefer(current: Decision | None, challenger: Decision) -> Decision:
    if current is None or (challenger.source == "user" and current.source != "user"):
        return challenger
    return current


def _row(cut_ms: int, start_ms: int | None, end_ms: int | None, kind: str | None, decision: Decision | None) -> dict:
    return {
        "cut_ms": cut_ms,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "kind": kind,
        "decision": {"label": decision.label, "source": decision.source} if decision else None,
        "score": None,
    }


def build_rows(features: Features, decisions: list[Decision]) -> list[dict]:
    candidates = find_candidates(features)
    attached: dict[int, Decision] = {}
    loose: list[Decision] = []
    for d in decisions:
        index = _nearest_candidate(d, candidates)
        if index is None:
            loose.append(d)
        else:
            attached[index] = _prefer(attached.get(index), d)
    rows = [_row(c.cut_ms, c.start_ms, c.end_ms, c.kind, attached.get(i)) for i, c in enumerate(candidates)]
    rows += [_row(d.cut_ms, None, None, None, d) for d in loose]
    return sorted(rows, key=lambda r: r["cut_ms"])


def clip_args(path: Path, start_ms: int, out: Path) -> list[str]:
    return [
        "ffmpeg", "-v", "error", "-nostdin", "-y",
        "-ss", f"{start_ms / 1000:.3f}", "-i", str(path), "-t", str(CLIP_SECONDS),
        "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac",
        "-movflags", "+faststart", str(out),
    ]


def render_clip(path: Path, start_ms: int, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out.parent, suffix=".tmp.mp4")
    os.close(fd)
    try:
        subprocess.run(clip_args(path, start_ms, Path(tmp)), check=True, capture_output=True)
        os.replace(tmp, out)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def strip_image(features: Features, ms: int) -> np.ndarray:
    count = len(features.thumbs)
    height, width = features.thumbs.shape[1:]
    center = round(ms / 1000 * FPS)
    frames = []
    for offset in STRIP_OFFSETS_S:
        index = center + round(offset * FPS)
        frames.append(features.thumbs[index] if 0 <= index < count else np.zeros((height, width), dtype=np.uint8))
    return np.repeat(np.repeat(np.hstack(frames), STRIP_SCALE, axis=0), STRIP_SCALE, axis=1)


def encode_jpeg(image: np.ndarray) -> bytes:
    height, width = image.shape
    args = ["ffmpeg", "-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{width}x{height}", "-i", "pipe:0",
            "-frames:v", "1", "-f", "mjpeg", "pipe:1"]
    return subprocess.run(args, input=image.tobytes(), check=True, capture_output=True).stdout


def parse_range(header: str, size: int) -> tuple[int, int] | None:
    unit, _, spec = header.partition("=")
    first, _, last = spec.split(",")[0].strip().partition("-")
    if unit.strip() != "bytes" or not (first.isdigit() or last.isdigit()):
        return None
    if not first:
        start, end = max(0, size - int(last)), size - 1
    else:
        start, end = int(first), min(int(last), size - 1) if last.isdigit() else size - 1
    return (start, end) if 0 <= start <= end else None


def make_handler(app: ReviewApp) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args) -> None:
            pass

        def do_GET(self) -> None:
            self._guard(self._get)

        def do_POST(self) -> None:
            self._guard(self._post)

        def _guard(self, action) -> None:
            try:
                action()
            except HttpError as e:
                self._json({"error": str(e)}, e.status)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (subprocess.CalledProcessError, ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
                self._json({"error": f"{type(e).__name__}: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def _query(self) -> dict[str, str]:
            return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

        def _ms(self) -> int:
            try:
                return int(self._query()["ms"])
            except (KeyError, ValueError):
                raise HttpError(HTTPStatus.BAD_REQUEST, "ms must be an integer")

        def _get(self) -> None:
            route = urlparse(self.path).path
            query = self._query()
            if route in PAGES:
                self._file(STATIC_DIR / PAGES[route])
            elif route == "/api/show":
                self._json(app.show_summary())
            elif route == "/api/episode":
                self._json(app.episode(query.get("rel", "")))
            elif route == "/clip":
                self._video(app.clip(query.get("rel", ""), self._ms()))
            elif route == "/strip":
                self._send(app.strip(query.get("rel", ""), self._ms()), "image/jpeg")
            elif route == "/video":
                self._video(app.resolve(query.get("rel")))
            else:
                raise HttpError(HTTPStatus.NOT_FOUND, "not found")

        def _body(self) -> dict:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if not isinstance(body, dict):
                raise HttpError(HTTPStatus.BAD_REQUEST, "body must be an object")
            return body

        def _post(self) -> None:
            route = urlparse(self.path).path
            body = self._body()
            if route == "/api/decision":
                self._json(app.set_decision(body["rel"], int(body["cut_ms"]), body["label"]))
            elif route == "/api/add-break":
                self._json(app.set_decision(body["rel"], int(body["ms"]), "break"))
            elif route == "/api/complete":
                self._json(app.complete(body["rel"], bool(body["complete"]), bool(body.get("held_out", False))))
            else:
                raise HttpError(HTTPStatus.NOT_FOUND, "not found")

        def _send(self, data: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
            self._send(json.dumps(payload).encode(), "application/json", status)

        def _file(self, path: Path, cache_control: str = "no-store") -> None:
            data = path.read_bytes()
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            self.end_headers()
            self.wfile.write(data)

        def _video(self, path: Path) -> None:
            size = path.stat().st_size
            header = self.headers.get("Range")
            span = parse_range(header, size) if header else (0, size - 1)
            if span is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end = span
            self.send_response(HTTPStatus.PARTIAL_CONTENT if header else HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "video/x-matroska")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if header:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            self._copy(path, start, end - start + 1)

        def _copy(self, path: Path, start: int, length: int) -> None:
            with path.open("rb") as f:
                f.seek(start)
                while length > 0:
                    chunk = f.read(min(CHUNK, length))
                    if not chunk:
                        return
                    self.wfile.write(chunk)
                    length -= len(chunk)

    return Handler


def make_server(show_dir: Path, cache: FeatureCache, port: int = 8765, roots: list[Path] | None = None) -> ThreadingHTTPServer:
    app = ReviewApp(show_dir, cache, roots if roots is not None else default_roots())
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
