import numpy as np
import pytest

from breakdetect.candidates import Candidate, find_candidates
from breakdetect.features import Features, extract_features
from breakdetect.signals import SIGNAL_NAMES, candidate_signals

COLUMN = {name: i for i, name in enumerate(SIGNAL_NAMES)}


@pytest.fixture(scope="module")
def fade_gap(make_clip):
    f = extract_features(make_clip([("content", 70), ("fadeout", 1), ("black", 0.3), ("fadein", 1), ("content", 70)]))
    return f, find_candidates(f)[0]


def test_signal_vector_length_matches_names(fade_gap):
    f, c = fade_gap
    assert len(candidate_signals(c, f, None)) == len(SIGNAL_NAMES)


def test_fade_slopes_negative_then_positive(fade_gap):
    f, c = fade_gap
    signals = candidate_signals(c, f, None)
    assert signals[COLUMN["fade_out_slope"]] < 0
    assert signals[COLUMN["fade_in_slope"]] > 0


def test_missing_audio_features_do_not_score_as_silence(make_clip):
    f = extract_features(make_clip([("noaudio", 70), ("black", 0.5), ("noaudio", 70)]))
    signals = candidate_signals(find_candidates(f)[0], f, None)
    assert signals[COLUMN["quiet_depth_db"]] == 0
    assert signals[COLUMN["quiet_ms"]] == 0
    assert signals[COLUMN["context_loudness_db"]] == 0
    assert signals[COLUMN["audio_missing"]] == 1


def test_black_gap_signals_with_audio(make_clip):
    f = extract_features(make_clip([("content", 70), ("black", 0.5), ("content", 70)], chapters_ms=[70250]))
    signals = candidate_signals(find_candidates(f)[0], f, None)
    assert signals[COLUMN["audio_missing"]] == 0
    assert signals[COLUMN["dark_depth"]] > 0.1
    assert signals[COLUMN["quiet_depth_db"]] > 20
    assert 300 <= signals[COLUMN["dark_ms"]] <= 800
    assert abs(signals[COLUMN["rel_pos"]] - 0.5) < 0.01
    assert signals[COLUMN["near_chapter"]] == 1
    assert signals[COLUMN["series_offset_support"]] == 0
    assert signals[COLUMN["bumper_match"]] == 0


def _dark_features(spot: int) -> tuple[Features, Candidate]:
    thumbs = np.full((1500, 36, 64), 120, dtype=np.uint8)
    thumbs[700:710] = 0
    thumbs[700:710, 5:11, 40:48] = spot
    luma = thumbs.reshape(len(thumbs), -1).mean(axis=1).astype(np.float32) / 255
    f = Features(150_000, 10.0, luma, thumbs, None, [], "test")
    return f, Candidate(70_000, 71_000, 70_500, "dark", float(luma[700]), None)


def test_frame_peak_is_zero_for_full_black():
    f, c = _dark_features(spot=0)
    assert candidate_signals(c, f, None)[COLUMN["frame_peak"]] == 0


def test_frame_peak_sees_bright_spot_in_dark_scene():
    f, c = _dark_features(spot=240)
    assert candidate_signals(c, f, None)[COLUMN["frame_peak"]] > 0.5
