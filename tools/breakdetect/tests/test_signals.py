import pytest

from breakdetect.candidates import find_candidates
from breakdetect.features import extract_features
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
