import subprocess
import sys
from pathlib import Path


def _url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def ytdlp_args(video_id: str, dest_dir: Path) -> list[str]:
    # Chapters are not embedded in the merged mkv; they are read from <id>.info.json.
    return [
        "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--sponsorblock-remove", "sponsor,intro,outro,selfpromo",
        "--merge-output-format", "mkv",
        "--write-info-json",
        "--no-progress",
        "-o", f"{dest_dir}/{video_id}.%(ext)s",
        _url(video_id),
    ]


def info_args(video_id: str, dest_dir: Path) -> list[str]:
    return [
        "--skip-download", "--write-info-json", "--no-progress",
        "-o", f"{dest_dir}/{video_id}.%(ext)s",
        _url(video_id),
    ]


def info_path(mkv: Path) -> Path:
    return mkv.with_suffix(".info.json")


def download(video_id: str, dest_dir: Path) -> Path:
    """Download `<id>.mkv` and `<id>.info.json`, reusing whichever already exists."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    mkv = dest_dir / f"{video_id}.mkv"
    if mkv.exists():
        if not info_path(mkv).exists():
            subprocess.run([sys.executable, "-m", "yt_dlp", *info_args(video_id, dest_dir)], check=True)
        return mkv
    subprocess.run([sys.executable, "-m", "yt_dlp", *ytdlp_args(video_id, dest_dir)], check=True)
    return mkv
