import subprocess
import sys

import pytest

from commercials.split import (
    Segment,
    boundaries,
    cut_args,
    detect_args,
    parse_blackdetect,
    parse_chapters,
    parse_silencedetect,
    segments,
    snap_length,
)

BLACK_STDERR = """\
Input #0, matroska,webm, from 'x.mkv':
[Parsed_blackdetect_0 @ 0x794ec2dbc0] black_start:0 black_end:0.96 black_duration:0.96
[Parsed_blackdetect_0 @ 0x794ec2dbc0] black_start:15.015 black_end:15.315 black_duration:0.3
frame=  900 fps=0.0 q=-0.0 Lsize=N/A time=00:00:30.00 bitrate=N/A speed=60x
"""

SILENCE_STDERR = """\
[Parsed_silencedetect_0 @ 0x794ec2d680] silence_start: 0
[Parsed_silencedetect_0 @ 0x794ec2d680] silence_end: 1 | silence_duration: 1
[Parsed_silencedetect_0 @ 0x794ec2d680] silence_start: 15.0103
[Parsed_silencedetect_0 @ 0x794ec2d680] silence_end: 15.3 | silence_duration: 0.2897
[Parsed_silencedetect_0 @ 0x794ec2d680] silence_start: 29.9
"""


def test_parsers():
    assert parse_blackdetect(BLACK_STDERR) == [(0.0, 0.96), (15.015, 15.315)]
    # An unterminated trailing silence is dropped.
    assert parse_silencedetect(SILENCE_STDERR) == [(0.0, 1.0), (15.0103, 15.3)]


def test_snap_length():
    assert snap_length(29.7) == 30
    assert snap_length(30.6) is None
    assert snap_length(14.9) == 15
    assert snap_length(77) is None


def test_boundaries_need_black_and_silence():
    z = [(0.0, 0.0), (40.0, 40.0)]
    assert boundaries([(10.0, 10.5)], [], 40.0) == z
    assert boundaries([], [(10.0, 10.5)], 40.0) == z
    assert boundaries([(10.0, 10.5)], [(30.0, 30.5)], 40.0) == z


def test_boundaries_gap_is_overlap():
    assert boundaries([(10.0, 10.6)], [(10.2, 11.0)], 40.0) == [(0.0, 0.0), (10.2, 10.6), (40.0, 40.0)]


def test_boundaries_min_overlap():
    assert boundaries([(10.0, 10.5)], [(10.49, 11.0)], 40.0)[1:-1] == []


def test_boundaries_single_frame_black():
    # Real compilation cuts are often one black frame (0.033 s at 30 fps) over a 0.03 s silence.
    assert len(boundaries([(86.967, 87.0)], [(86.9688, 87.0)], 200.0)) == 3


def test_boundaries_clip_edges_are_not_duplicated():
    assert boundaries([(0.0, 0.5)], [(0.0, 0.5)], 40.0) == [(0.0, 0.0), (40.0, 40.0)]


def test_merged_ads_rejected():
    ok = segments([(0, 0), (30, 30), (75, 75)])
    assert [(s.spot_s, s.reject_reason) for s in ok] == [(30, None), (45, None)]
    assert segments([(0, 0), (30, 30), (90.2, 90.2)])[1] == Segment(30, 90.2, 60, None)
    merged = segments([(0, 0), (30, 30), (107, 107)])[1]
    assert merged.spot_s is None
    assert merged.reject_reason == "nonstandard_length"


def test_gap_edges_not_midpoint():
    # 30 s spot, 0.8 s black+silent gap, 30 s spot.
    gaps = boundaries([(30.0, 30.8)], [(30.0, 30.8)], 60.8)
    segs = segments(gaps)
    assert [s.spot_s for s in segs] == [30, 30]
    assert all(abs((s.end - s.start) - 30.0) < 0.05 for s in segs)


def test_parse_chapters():
    info = {"chapters": [{"start_time": 0, "title": "a"}, {"start_time": 41.0}, {"start_time": 11}]}
    assert parse_chapters(info) == [11.0, 41.0]
    assert parse_chapters({}) == []
    assert parse_chapters({"chapters": None}) == []


def test_chapter_boundary_needs_nearby_gap():
    near = boundaries([], [(30.2, 30.5)], 60.0, chapters=[30.0])
    assert near == [(0.0, 0.0), (30.2, 30.5), (60.0, 60.0)]
    assert boundaries([], [(31.0, 31.3)], 60.0, chapters=[30.0]) == [(0.0, 0.0), (60.0, 60.0)]
    assert boundaries([], [], 60.0, chapters=[30.0]) == [(0.0, 0.0), (60.0, 60.0)]


def test_chapters_split_merged_pod():
    # Without chapters only the 60 s mark is a gap, so the pod stays one 60 s segment.
    assert [s.spot_s for s in segments(boundaries([(30.05, 30.15)], [(0.0, 0.0)], 60.0))] == [60]
    gaps = boundaries([(30.05, 30.15)], [(0.0, 0.0)], 60.0, chapters=[30.0])
    assert [s.spot_s for s in segments(gaps)] == [30, 30]


def test_chapter_does_not_duplicate_existing_gap():
    gaps = boundaries([(30.0, 30.3)], [(30.0, 30.3)], 60.0, chapters=[30.1])
    assert len(gaps) == 3


def test_args():
    d = detect_args("in.mkv")
    assert "blackdetect=d=0.03:pix_th=0.10" in d
    assert "silencedetect=n=-50dB:d=0.03" in d
    c = cut_args("in.mkv", Segment(10, 40, 30, None), "out.mkv")
    assert c.index("-ss") < c.index("-i")
    assert c[c.index("-c:v") + 1] == "libx264" and c[c.index("-crf") + 1] == "16"
    assert c[c.index("-c:a") + 1] == "pcm_s16le"
    assert c[-1] == "out.mkv"


@pytest.mark.integration
def test_split_synthetic_compilation(make_clip):
    clip = make_clip([("bars", 15), ("black", 0.3), ("content", 30)])
    res = subprocess.run(["ffmpeg", *detect_args(clip)], capture_output=True, text=True, check=True)
    dur = 45.3
    segs = segments(boundaries(parse_blackdetect(res.stderr), parse_silencedetect(res.stderr), dur))
    assert [s.spot_s for s in segs] == [15, 30]
    assert all(s.reject_reason is None for s in segs)
