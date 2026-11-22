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
        "--remux-video", "mkv",  # a single-file format (no merge) is remuxed to mkv too
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


VIDEO_EXTS = (".mkv", ".mp4", ".webm", ".mov", ".m4v")


def find_video(video_id: str, dest_dir: Path) -> Path | None:
    """`<id>.mkv`, else any finished `<id>.<video ext>`.

    Only a file named exactly `<id>.<ext>` counts: never `.part`, `.info.json`, or the
    per-format leftovers (`<id>.f<format>.<ext>`) an interrupted merge leaves behind.
    """
    mkv = dest_dir / f"{video_id}.mkv"
    if mkv.exists():
        return mkv
    found = sorted(p for p in dest_dir.glob(f"{video_id}.*")
                   if p.stem == video_id and p.suffix in VIDEO_EXTS and p.is_file())
    return found[0] if found else None


def download(video_id: str, dest_dir: Path) -> Path:
    """Download `<id>.mkv` and `<id>.info.json`, reusing whichever already exists."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    video = find_video(video_id, dest_dir)
    if video is not None:
        if not info_path(video).exists():
            subprocess.run([sys.executable, "-m", "yt_dlp", *info_args(video_id, dest_dir)], check=True)
        return video
    subprocess.run([sys.executable, "-m", "yt_dlp", *ytdlp_args(video_id, dest_dir)], check=True)
    video = find_video(video_id, dest_dir)
    if video is None:
        raise FileNotFoundError(f"yt-dlp left no video file for {video_id} in {dest_dir}")
    return video
