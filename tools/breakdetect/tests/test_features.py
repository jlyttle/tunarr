from breakdetect.features import extract_features, load_features, save_features

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
