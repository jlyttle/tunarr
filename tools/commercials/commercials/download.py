import subprocess
import sys
from pathlib import Path


def ytdlp_args(video_id: str, dest_dir: Path) -> list[str]:
    return [
        "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--sponsorblock-remove", "sponsor,intro,outro,selfpromo",
        "--merge-output-format", "mkv",
        "-o", f"{dest_dir}/{video_id}.%(ext)s",
        f"https://www.youtube.com/watch?v={video_id}",
    ]


def download(video_id: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "yt_dlp", *ytdlp_args(video_id, dest_dir)], check=True)
    return dest_dir / f"{video_id}.mkv"
