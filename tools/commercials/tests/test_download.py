from pathlib import Path

from commercials.download import ytdlp_args


def test_ytdlp_args():
    args = ytdlp_args("abc123", Path("/dl"))
    assert args[args.index("-f") + 1] == "bv*[height<=1080]+ba/b[height<=1080]"
    assert args[args.index("--sponsorblock-remove") + 1] == "sponsor,intro,outro,selfpromo"
    assert args[args.index("--merge-output-format") + 1] == "mkv"
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
