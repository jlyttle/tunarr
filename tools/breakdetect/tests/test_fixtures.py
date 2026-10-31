import json
import subprocess


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def test_make_clip_duration_and_streams(make_clip):
    info = probe(make_clip([("content", 5), ("black", 1), ("content", 5)]))
    kinds = [s["codec_type"] for s in info["streams"]]
    assert abs(float(info["format"]["duration"]) - 11.0) <= 0.1
    assert kinds.count("video") == 1
    assert kinds.count("audio") == 1
