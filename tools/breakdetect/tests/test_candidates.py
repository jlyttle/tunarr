import pytest

from breakdetect.candidates import find_candidates
from breakdetect.features import extract_features


@pytest.fixture(scope="module")
def black_gap(make_clip):
    return extract_features(make_clip([("content", 70), ("black", 0.5), ("content", 70)]))


@pytest.fixture(scope="module")
def fade_gap(make_clip):
    return extract_features(make_clip([("content", 70), ("fadeout", 1), ("black", 0.3), ("fadein", 1), ("content", 70)]))


def test_black_gap_is_candidate(black_gap):
    candidates = find_candidates(black_gap)
    assert len(candidates) == 1
    assert abs(candidates[0].cut_ms - 70250) <= 150
    assert candidates[0].kind == "dark+quiet"


def test_fade_gap_is_candidate(fade_gap):
    assert len(find_candidates(fade_gap)) == 1


def test_edge_candidates_excluded(make_clip):
    f = extract_features(make_clip([("black", 2), ("content", 130), ("black", 2)]))
    assert find_candidates(f) == []


def test_mid_file_segment_gap_is_candidate(make_clip):
    f = extract_features(make_clip([("content", 200), ("fadeout", 1), ("black", 2), ("content", 200)]))
    assert len(find_candidates(f)) == 1


def test_dark_scene_with_audio_is_still_candidate_but_kind_dark(make_clip):
    f = extract_features(make_clip([("content", 70), ("darkscene", 5), ("content", 70)]))
    candidates = find_candidates(f)
    assert len(candidates) == 1
    assert candidates[0].kind == "dark"
    assert candidates[0].min_rms_db is not None


def test_video_only_file_yields_dark_candidates_without_rms(make_clip):
    f = extract_features(make_clip([("noaudio", 70), ("black", 0.5), ("noaudio", 70)]))
    candidates = find_candidates(f)
    assert len(candidates) == 1
    assert candidates[0].kind == "dark"
    assert candidates[0].min_rms_db is None


def test_cut_is_midpoint_of_span(black_gap):
    c = find_candidates(black_gap)[0]
    assert c.cut_ms == (c.start_ms + c.end_ms) // 2
    assert c.min_luma < 0.05
