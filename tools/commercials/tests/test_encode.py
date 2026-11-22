import subprocess

import pytest

from commercials.encode import (
    StreamInfo,
    encode_args,
    loudnorm_measure_args,
    parse_loudnorm,
    parse_mean_volume,
    precheck,
    volumedetect_args,
)

LOUDNORM_STDERR = """\
size=N/A time=00:00:30.00 bitrate=N/A speed=60x
[Parsed_loudnorm_0 @ 0x600] 
{
\t"input_i" : "-20.50",
\t"input_tp" : "-3.10",
\t"input_lra" : "1.20",
\t"input_thresh" : "-31.00",
\t"output_i" : "-24.10",
\t"output_tp" : "-6.00",
\t"output_lra" : "0.90",
\t"output_thresh" : "-34.50",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.10"
}
"""

MEASURED = {
    "input_i": "-20.50", "input_tp": "-3.10", "input_lra": "1.20",
    "input_thresh": "-31.00", "target_offset": "0.10",
}
OK = StreamInfo(has_audio=True, width=1280, height=720)


def test_no_audio_rejected():
    assert precheck(StreamInfo(False, 1280, 720), -20.0) == "no_audio"


def test_silent_rejected():
    assert precheck(OK, -70.0) == "silent"
    assert precheck(OK, -20.0) is None


def test_vertical_rejected():
    assert precheck(StreamInfo(True, 720, 1280), -20.0) == "vertical"


def test_parsers():
    assert parse_loudnorm(LOUDNORM_STDERR)["input_i"] == "-20.50"
    assert parse_mean_volume("[Parsed_volumedetect_0 @ 0x1] mean_volume: -23.4 dB\n") == -23.4


def test_encode_args_pads_not_crops():
    a = " ".join(encode_args("in.mkv", "out.mp4", MEASURED))
    assert "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1" in a
    assert "crop" not in a
    assert "-movflags +faststart" in a
    assert "-crf 18" in a


def test_encode_args_loudnorm_target_minus_24():
    a = " ".join(encode_args("in.mkv", "out.mp4", MEASURED))
    assert "loudnorm=I=-24:TP=-2:LRA=11" in a
    assert "measured_I=-20.50" in a
    assert "measured_TP=-3.10" in a
    assert "measured_LRA=1.20" in a
    assert "measured_thresh=-31.00" in a
    assert "offset=0.10" in a
    assert "linear=true" in a


@pytest.mark.integration
def test_encoded_loudness(make_clip, tmp_path):
    from commercials.encode import probe_streams

    clip = make_clip([("bars", 10)])
    info = probe_streams(clip)
    assert info.has_audio and (info.width, info.height) == (640, 360)
    res = subprocess.run(["ffmpeg", *loudnorm_measure_args(clip)], capture_output=True, text=True, check=True)
    out = tmp_path / "o.mp4"
    subprocess.run(["ffmpeg", *encode_args(clip, out, parse_loudnorm(res.stderr))], check=True, capture_output=True)
    chk = subprocess.run(["ffmpeg", *loudnorm_measure_args(out)], capture_output=True, text=True, check=True)
    assert float(parse_loudnorm(chk.stderr)["input_i"]) == pytest.approx(-24.0, abs=1.0)
    out_info = probe_streams(out)
    assert (out_info.width, out_info.height) == (1280, 720)
    vol = subprocess.run(["ffmpeg", *volumedetect_args(out)], capture_output=True, text=True, check=True)
    assert parse_mean_volume(vol.stderr) > -60
