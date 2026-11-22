from pathlib import Path

import pytest

from commercials.download import ytdlp_args


def test_ytdlp_args():
    args = ytdlp_args("abc123", Path("/dl"))
    assert args[args.index("-f") + 1] == "bv*[height<=1080]+ba/b[height<=1080]"
    assert args[args.index("--sponsorblock-remove") + 1] == "sponsor,intro,outro,selfpromo"
    assert args[args.index("--merge-output-format") + 1] == "mkv"
    assert args[args.index("--remux-video") + 1] == "mkv"  # single-file formats end up mkv too
    assert args[args.index("-o") + 1] == "/dl/abc123.%(ext)s"
    assert "--write-info-json" in args  # chapters live in <id>.info.json, not the mkv
    assert "--no-progress" in args  # keeps the launchd log readable
    assert args[-1] == "https://www.youtube.com/watch?v=abc123"


def test_download_reuses_existing_files(tmp_path, monkeypatch):
    from commercials import download as dl

    calls = []
    monkeypatch.setattr(dl.subprocess, "run", lambda args, check: calls.append(args))
    (tmp_path / "v1.mkv").write_bytes(b"x")
    (tmp_path / "v1.info.json").write_text("{}")
    assert dl.download("v1", tmp_path) == tmp_path / "v1.mkv"
    assert calls == []


def test_download_fetches_only_info_when_video_exists(tmp_path, monkeypatch):
    from commercials import download as dl

    calls = []
    monkeypatch.setattr(dl.subprocess, "run", lambda args, check: calls.append(args))
    (tmp_path / "v1.mkv").write_bytes(b"x")
    dl.download("v1", tmp_path)
    assert len(calls) == 1
    assert "--skip-download" in calls[0] and "--write-info-json" in calls[0]


def test_download_falls_back_to_other_video_extension(tmp_path, monkeypatch):
    from commercials import download as dl

    def fake_run(args, check):
        (tmp_path / "v1.webm").write_bytes(b"x")
        (tmp_path / "v1.info.json").write_text("{}")

    monkeypatch.setattr(dl.subprocess, "run", fake_run)
    assert dl.download("v1", tmp_path) == tmp_path / "v1.webm"
    assert dl.info_path(tmp_path / "v1.webm") == tmp_path / "v1.info.json"


def test_download_reuses_existing_non_mkv_video(tmp_path, monkeypatch):
    from commercials import download as dl

    monkeypatch.setattr(dl.subprocess, "run", lambda args, check: pytest.fail("no download expected"))
    (tmp_path / "v1.mp4").write_bytes(b"x")
    (tmp_path / "v1.info.json").write_text("{}")
    (tmp_path / "v1.mp4.part").write_bytes(b"x")
    assert dl.download("v1", tmp_path) == tmp_path / "v1.mp4"


def test_download_without_any_video_raises(tmp_path, monkeypatch):
    from commercials import download as dl

    monkeypatch.setattr(dl.subprocess, "run", lambda args, check: None)
    with pytest.raises(FileNotFoundError):
        dl.download("v1", tmp_path)


def test_find_video_ignores_per_format_leftovers(tmp_path):
    from commercials.download import find_video

    # yt-dlp leaves <id>.f<format>.<ext> when a merge is interrupted; they are not the video
    (tmp_path / "v1.f137.mp4").write_bytes(b"x")
    (tmp_path / "v1.f251.webm").write_bytes(b"x")
    assert find_video("v1", tmp_path) is None
    (tmp_path / "v1.webm").write_bytes(b"x")
    assert find_video("v1", tmp_path) == tmp_path / "v1.webm"


def test_download_after_leftovers_runs_ytdlp(tmp_path, monkeypatch):
    from commercials import download as dl

    calls = []

    def fake_run(args, check):
        calls.append(args)
        (tmp_path / "v1.mkv").write_bytes(b"x")

    monkeypatch.setattr(dl.subprocess, "run", fake_run)
    (tmp_path / "v1.f137.mp4").write_bytes(b"x")
    assert dl.download("v1", tmp_path) == tmp_path / "v1.mkv"
    assert len(calls) == 1 and "--skip-download" not in calls[0]
