import numpy as np

from breakdetect.features import AUDIO_WINDOW, SILENCE_FLOOR_DB, _rms_db_from_bytes, extract_features, load_features, save_features

CONTENT_BLACK_CONTENT = [("content", 8), ("black", 1), ("content", 8)]


def test_extract_finds_black_and_silence(make_clip):
    f = extract_features(make_clip(CONTENT_BLACK_CONTENT))
    assert f.luma[int(8.5 * 10)] < 0.05
    assert f.luma[40] > 0.2
    assert f.audio_rms_db[85] < -60
    assert f.audio_rms_db[40] > -30
    assert abs(f.duration_ms - 17000) < 150
    assert f.thumbs.shape[1:] == (36, 64)


def test_extract_video_only_file(make_clip):
    f = extract_features(make_clip([("noaudio", 3)]))
    assert f.audio_rms_db is None
    assert len(f.luma) > 0


def test_extract_reports_chapters(make_clip):
    f = extract_features(make_clip(CONTENT_BLACK_CONTENT, chapters_ms=[8000]))
    assert f.chapters_ms == [8000]


def test_save_and_load_round_trip(make_clip, tmp_path):
    f = extract_features(make_clip(CONTENT_BLACK_CONTENT, chapters_ms=[8000]))
    save_features(f, tmp_path / "f.npz")
    g = load_features(tmp_path / "f.npz")
    assert (g.thumbs == f.thumbs).all()
    assert (g.audio_rms_db == f.audio_rms_db).all()
    assert (g.duration_ms, g.chapters_ms, g.extractor_version) == (f.duration_ms, f.chapters_ms, f.extractor_version)


def test_rms_takes_max_across_channels_and_floors_silence():
    quiet = np.zeros((2 * AUDIO_WINDOW, 2), dtype=np.int16)
    quiet[:AUDIO_WINDOW, 1] = 16384
    db = _rms_db_from_bytes(quiet.tobytes(), 2)
    assert len(db) == 2
    assert abs(db[0] - 20 * np.log10(0.5)) < 0.01
    assert db[1] == np.float32(SILENCE_FLOOR_DB)


def test_rms_spans_multiple_blocks():
    loud = np.full((2500 * AUDIO_WINDOW, 1), 3277, dtype=np.int16)
    db = _rms_db_from_bytes(loud.tobytes(), 1)
    assert len(db) == 2500
    assert np.allclose(db, 20 * np.log10(3277 / 32768), atol=0.01)


def test_luma_and_audio_are_time_aligned(make_clip):
    f = extract_features(make_clip(CONTENT_BLACK_CONTENT))
    assert abs(len(f.luma) - f.duration_ms / 100) <= 2
    assert abs(len(f.audio_rms_db) - len(f.luma)) <= 2
    black_video = np.flatnonzero(f.luma < 0.05)
    silent_audio = np.flatnonzero(f.audio_rms_db < -60)
    assert abs(black_video.mean() - silent_audio.mean()) <= 1.5
    assert abs(black_video.min() - silent_audio.min()) <= 2
