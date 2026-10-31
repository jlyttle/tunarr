import os
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from breakdetect.media import Probe, probe

EXTRACTOR_VERSION = "1"
FPS = 10.0
THUMB_W, THUMB_H = 64, 36
AUDIO_RATE = 8000
AUDIO_WINDOW = AUDIO_RATE // 10
SILENCE_FLOOR_DB = -120.0
RMS_BLOCK_WINDOWS = 1000
STDERR_TAIL_CHARS = 2000


class ExtractError(RuntimeError):
    pass


@dataclass
class Features:
    duration_ms: int
    fps: float
    luma: np.ndarray
    thumbs: np.ndarray
    audio_rms_db: np.ndarray | None
    chapters_ms: list[int]
    extractor_version: str


def _ffmpeg_args(path: Path, has_audio: bool, hwaccel: str | None, threads: int) -> list[str]:
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if hwaccel:
        args += ["-hwaccel", hwaccel]
    args += ["-threads", str(threads), "-i", str(path)]
    args += ["-map", "0:v:0", "-vf", f"fps={FPS:g}:start_time=0,scale={THUMB_W}:{THUMB_H}:flags=area,format=gray"]
    args += ["-f", "rawvideo", "pipe:1"]
    if has_audio:
        args += ["-map", "0:a:0", "-af", f"aresample={AUDIO_RATE}:first_pts=0,aformat=sample_fmts=s16", "-f", "s16le", "pipe:3"]
    return args


def _drain(stream, sink: list[bytes]) -> threading.Thread:
    def run() -> None:
        sink.append(stream.read())

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def _run_ffmpeg(args: list[str], has_audio: bool) -> tuple[bytes, bytes]:
    read_fd, write_fd = os.pipe() if has_audio else (None, None)
    pass_fds = (write_fd,) if has_audio else ()
    if has_audio:
        args = [a.replace("pipe:3", f"pipe:{write_fd}") for a in args]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=pass_fds)
    video, audio, err = [], [], []
    readers = [_drain(proc.stdout, video), _drain(proc.stderr, err)]
    if has_audio:
        os.close(write_fd)
        readers.append(_drain(os.fdopen(read_fd, "rb"), audio))
    for reader in readers:
        reader.join()
    code = proc.wait()
    if code != 0:
        tail = err[0].decode(errors="replace")[-STDERR_TAIL_CHARS:]
        raise ExtractError(f"ffmpeg exited with {code}: {tail}")
    return video[0], audio[0] if has_audio else b""


def _thumbs_from_bytes(raw: bytes) -> np.ndarray:
    frame = THUMB_W * THUMB_H
    return np.frombuffer(raw, dtype=np.uint8)[: len(raw) // frame * frame].reshape(-1, THUMB_H, THUMB_W)


def _block_rms(block: np.ndarray) -> np.ndarray:
    framed = block.astype(np.float32) / 32768.0
    return np.sqrt((framed**2).mean(axis=1)).max(axis=1)


def _rms_db_from_bytes(raw: bytes, channels: int) -> np.ndarray:
    samples = np.frombuffer(raw, dtype=np.int16)
    samples = samples[: len(samples) // channels * channels].reshape(-1, channels)
    windows = len(samples) // AUDIO_WINDOW
    framed = samples[: windows * AUDIO_WINDOW].reshape(windows, AUDIO_WINDOW, channels)
    rms = np.empty(windows, dtype=np.float32)
    for start in range(0, windows, RMS_BLOCK_WINDOWS):
        rms[start : start + RMS_BLOCK_WINDOWS] = _block_rms(framed[start : start + RMS_BLOCK_WINDOWS])
    with np.errstate(divide="ignore"):
        db = 20 * np.log10(rms)
    return np.maximum(db, SILENCE_FLOOR_DB).astype(np.float32)


def extract_features(path: Path, hwaccel: str | None = None, threads: int = 0) -> Features:
    info: Probe = probe(path)
    video, audio = _run_ffmpeg(_ffmpeg_args(path, info.has_audio, hwaccel, threads), info.has_audio)
    thumbs = _thumbs_from_bytes(video)
    return Features(
        duration_ms=info.duration_ms,
        fps=FPS,
        luma=(thumbs.mean(axis=(1, 2)) / 255.0).astype(np.float32),
        thumbs=thumbs,
        audio_rms_db=_rms_db_from_bytes(audio, info.audio_channels) if info.has_audio else None,
        chapters_ms=info.chapters_ms,
        extractor_version=EXTRACTOR_VERSION,
    )


def save_features(f: Features, dest: Path) -> None:
    arrays = {
        "duration_ms": np.int64(f.duration_ms),
        "fps": np.float64(f.fps),
        "luma": f.luma,
        "thumbs": f.thumbs,
        "chapters_ms": np.asarray(f.chapters_ms, dtype=np.int64),
        "extractor_version": np.str_(f.extractor_version),
    }
    if f.audio_rms_db is not None:
        arrays["audio_rms_db"] = f.audio_rms_db
    np.savez_compressed(dest, **arrays)


def load_features(src: Path) -> Features:
    with np.load(src, allow_pickle=False) as z:
        return Features(
            duration_ms=int(z["duration_ms"]),
            fps=float(z["fps"]),
            luma=z["luma"],
            thumbs=z["thumbs"],
            audio_rms_db=z["audio_rms_db"] if "audio_rms_db" in z.files else None,
            chapters_ms=[int(c) for c in z["chapters_ms"]],
            extractor_version=str(z["extractor_version"]),
        )
