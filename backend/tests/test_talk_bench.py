"""The Talk bench's own arithmetic (WP-T0). The measurements themselves need the
speech services and run by hand; these check the numbers it reports are right."""
from __future__ import annotations

import io
import wave

import numpy as np
import pytest

from app.talk import bench


def test_word_error_rate_counts_words_not_punctuation():
    assert bench.word_error_rate("Set a timer.", "set a timer") == 0.0
    assert bench.word_error_rate("Call Mum at six", "Call Mum at 6") == 0.25
    assert bench.word_error_rate("one two three four", "one three four") == 0.25
    assert bench.word_error_rate("", "") == 0.0
    assert bench.word_error_rate("", "noise") == 1.0


def test_stats_reports_median_and_slow_end():
    out = bench._stats([100.0, 300.0, 200.0, 400.0, 1000.0])
    assert out["median"] == 300.0
    assert out["p90"] == 1000.0
    assert out["min"] == 100.0 and out["max"] == 1000.0 and out["n"] == 5
    assert bench._stats([]) == {}


def test_clips_cover_one_to_six_seconds_and_cut_off_turns():
    ids = [c["id"] for c in bench.CLIPS]
    assert len(ids) == len(set(ids))
    assert any(not c["complete"] for c in bench.CLIPS)
    assert sum(1 for c in bench.CLIPS if c["complete"]) >= 6


def test_wav_round_trip_at_16k(tmp_path):
    tone = (0.3 * np.sin(np.linspace(0, 440 * 2 * np.pi, bench.SAMPLE_RATE))).astype(np.float32)
    path = tmp_path / "a.wav"
    path.write_bytes(bench._wav_bytes(tone, bench.SAMPLE_RATE))
    back = bench._read_wav(path)
    assert len(back) == len(tone)
    assert np.max(np.abs(back - tone)) < 1e-3


def test_resample_24k_to_16k_keeps_duration():
    samples = np.zeros(24_000, dtype=np.float32)
    assert len(bench._resample_to_16k(samples, 24_000)) == bench.SAMPLE_RATE


def test_wrong_sample_rate_is_refused(tmp_path):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24_000)
        w.writeframes(b"\0\0" * 10)
    path = tmp_path / "b.wav"
    path.write_bytes(buf.getvalue())
    with pytest.raises(SystemExit):
        bench._read_wav(path)


def test_cli_parses_each_command():
    with pytest.raises(SystemExit):
        bench.main(["--help"])
    for argv in (["run", "--help"], ["whisper", "--help"], ["smart-turn", "--help"], ["kokoro", "--help"]):
        with pytest.raises(SystemExit) as done:
            bench.main(argv)
        assert done.value.code == 0
