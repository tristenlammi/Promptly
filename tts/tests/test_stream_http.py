"""/tts/stream against a running tts service (WP-T1). Set ``TTS_URL``.

Run inside a throwaway tts container started from the worktree's image (never
the main ``Promptly-TTS``): ``docker exec <it> python -m pytest -q -s tests/test_stream_http.py``
with ``TTS_URL=http://127.0.0.1:8000``.
"""
from __future__ import annotations

import os
import statistics
import time

import numpy as np
import pytest
import requests

import streaming

URL = os.environ.get("TTS_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not URL, reason="set TTS_URL to a running tts service")

REPLY = "You've got three things today, the dentist at nine, Sam's call at two, and the bins go out tonight."
PARAGRAPH = (
    "You've got three things today. The dentist is at nine, so leave by half past eight. "
    "Sam's call is at two, and he wanted to go over the budget for the garden. "
    "The bins go out tonight, and it's the recycling week as well. "
    "Tomorrow looks quieter, with only the school pickup at three. "
    "Want me to set a reminder for the registration?"
)
# WP-T0 reset the first-audio target to ~300 ms for a 4-6 word first clause
# (Kokoro create at 4 threads measured 308-314 ms for this same clause on a
# busy dev box). Room for other sessions' load on the shared machine.
FIRST_CHUNK_BUDGET_MS = float(os.environ.get("TTS_FIRST_CHUNK_MS", "400"))


def _post(text: str, **body):
    return requests.post(f"{URL}/tts/stream", json={"text": text, **body}, stream=True, timeout=60)


def _first_chunk_ms(text: str, **body) -> tuple[float, bytes]:
    t0 = time.perf_counter()
    with _post(text, **body) as resp:
        resp.raise_for_status()
        it = resp.iter_content(chunk_size=None)
        first = next(it)
        took = (time.perf_counter() - t0) * 1000
        rest = b"".join(it)
    return took, first + rest


def _decode_opus(data: bytes) -> np.ndarray:
    import opuslib

    dec = opuslib.Decoder(streaming.SAMPLE_RATE, 1)
    pcm = b"".join(dec.decode(p, streaming.FRAME_SAMPLES) for p in streaming.read_framed(data))
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768


def _health() -> dict:
    return requests.get(f"{URL}/health", timeout=5).json()


def test_health_shows_threads_and_streams():
    h = _health()
    assert h["threads"] == int(os.environ.get("TTS_THREADS", "4"))
    assert {"active", "done", "cancelled", "slots"} <= set(h["streams"])


def test_first_audio_lands_within_the_wp_t0_number():
    _first_chunk_ms("Warming up the voice.")
    times = [_first_chunk_ms(REPLY)[0] for _ in range(6)]
    med = statistics.median(times)
    print(f"\n  first chunk (opus, 'You've got three things today,'): median {med:.0f} ms, all {[round(t) for t in times]}")
    assert med <= FIRST_CHUNK_BUDGET_MS


def test_first_clause_off_waits_for_the_whole_sentence():
    on = statistics.median(_first_chunk_ms(REPLY)[0] for _ in range(3))
    off = statistics.median(_first_chunk_ms(REPLY, first_clause=False)[0] for _ in range(3))
    print(f"\n  first chunk with first clause {on:.0f} ms, without {off:.0f} ms")
    assert on < off


def test_opus_and_pcm_carry_the_same_speech():
    with _post(REPLY) as resp:
        assert resp.headers["X-Audio-Format"] == "opus"
        assert resp.headers["X-Sample-Rate"] == "24000"
        assert resp.headers["X-Opus-Framing"] == "u16be-length"
        opus = resp.content
    with _post(REPLY, format="pcm") as resp:
        assert resp.headers["X-Audio-Format"] == "pcm_s16le"
        pcm = np.frombuffer(resp.content, dtype="<i2").astype(np.float32) / 32768
    decoded = _decode_opus(opus)
    seconds = len(pcm) / streaming.SAMPLE_RATE
    assert 4.0 < seconds < 12.0
    assert abs(len(decoded) - len(pcm)) <= streaming.FRAME_SAMPLES
    assert len(opus) < len(pcm) * 2 / 8  # Opus is far smaller than 16-bit PCM
    assert np.sqrt(np.mean(decoded**2)) > 0.02  # it's speech, not silence


def test_hanging_up_stops_the_speech():
    before = _health()["streams"]
    pieces = len(streaming.split_pieces(PARAGRAPH))
    assert pieces >= 6
    with _post(PARAGRAPH, format="pcm") as resp:
        next(resp.iter_content(chunk_size=None))
    # Closed after the first chunk: the service notices and makes nothing more.
    deadline = time.time() + 5
    while time.time() < deadline:
        h = _health()["streams"]
        if h["active"] == 0 and h["cancelled"] > before["cancelled"]:
            break
        time.sleep(0.05)
    after = _health()["streams"]
    assert after["active"] == 0
    assert after["cancelled"] == before["cancelled"] + 1
    made = after["pieces"] - before["pieces"]
    assert made < pieces, f"made {made} of {pieces} pieces after hanging up"
    time.sleep(1.0)
    assert _health()["streams"]["pieces"] == after["pieces"]


def test_two_streams_at_once_both_finish():
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda t: _first_chunk_ms(t, format="pcm")[1], [REPLY, "The dentist is at nine on Thursday."]))
    assert all(len(r) > 24_000 for r in results)


@pytest.mark.parametrize(
    "body, status",
    [
        ({"text": "Hello.", "voice": "nobody"}, 400),
        ({"text": "..."}, 400),
        ({"text": "x" * 5000}, 413),
        ({"text": "Hello.", "format": "mp3"}, 422),
        ({"text": ""}, 422),
    ],
)
def test_bad_requests(body, status):
    assert requests.post(f"{URL}/tts/stream", json=body, timeout=10).status_code == status
