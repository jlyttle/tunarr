from pathlib import Path

from commercials.download import ytdlp_args


def test_ytdlp_args():
    args = ytdlp_args("abc123", Path("/dl"))
    assert args[args.index("-f") + 1] == "bv*[height<=1080]+ba/b[height<=1080]"
    assert args[args.index("--sponsorblock-remove") + 1] == "sponsor,intro,outro,selfpromo"
    assert args[args.index("--merge-output-format") + 1] == "mkv"
    assert args[args.index("-o") + 1] == "/dl/abc123.%(ext)s"
    assert args[-1] == "https://www.youtube.com/watch?v=abc123"
