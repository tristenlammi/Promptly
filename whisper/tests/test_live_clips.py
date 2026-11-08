"""The live lane on real speech models (WP-T1): Silero, Whisper ``base``, Smart Turn.

Fixture clips are made by Kokoro at test time (``tts/tests/make_live_clips.py``)
into a scratch folder; set ``LIVE_CLIPS`` to it. Audio is fed in 20 ms frames
at real time, so the timings printed at the end are what a speaker would get.

    docker run --rm -v "$CLIPS:/clips:ro" -v promptly-talkbench:/root/.cache \
        -v "$PWD/whisper:/src" -w /src -e LIVE_CLIPS=/clips promptly-whisper:<tag> \
        sh -c "pip install -q pytest && python -m pytest -q -s tests/test_live_clips.py"
"""
from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
import wave
from pathlib import Path

import numpy as np
import pytest

import live

CLIPS = os.environ.get("LIVE_CLIPS")
pytestmark = pytest.mark.skipif(not CLIPS, reason="set LIVE_CLIPS to the folder make_live_clips.py wrote")

SR = live.SAMPLE_RATE
TIMINGS: dict[str, list[float]] = {"turn_end_ms": [], "final_ms": [], "pass_ms": []}


def _manifest() -> list[dict]:
    return json.loads((Path(CLIPS) / "manifest.json").read_text())["clips"] if CLIPS else []


def _audio(clip: dict) -> np.ndarray:
    with wave.open(str(Path(CLIPS) / clip["file"]), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


@pytest.fixture(scope="module")
def models():
    from faster_whisper import WhisperModel

    whisper = WhisperModel(
        os.environ.get("WHISPER_LIVE_MODEL", "base"), device="cpu", compute_type="int8", cpu_threads=4, num_workers=2
    )
    smart = live.SmartTurn(live.ensure_smart_turn(os.environ.get("WHISPER_SMART_TURN_DIR", "/root/.cache/smart-turn")))
    warm = np.zeros(SR, dtype=np.float32)
    live.whisper_pass(whisper, warm, "en")
    smart(warm)
    return whisper, smart


class FirstPauseUnfinished:
    """Real Smart Turn, except the first check says 'not finished' (Kokoro says
    a cut-off sentence with a finished tone, so it can't stand in for a person
    pausing mid-thought; WP-T0)."""

    def __init__(self, smart) -> None:
        self.smart = smart
        self.calls = 0

    def __call__(self, audio: np.ndarray) -> float:
        self.calls += 1
        return 0.05 if self.calls == 1 else self.smart(audio)


async def _drive(clip: dict, whisper, smart_turn) -> tuple[list[dict], float]:
    """Feed the clip at real time; return events (with arrival times) and the
    wall time the last speech sample went in."""
    events: list[dict] = []
    session = live.LiveSession(
        vad=live.SileroStream(),
        transcribe=lambda audio, lang: live.whisper_pass(whisper, audio, lang),
        smart_turn=smart_turn,
        lane=live.LiveLane(2),
        emit=lambda e: events.append({**e, "_t": time.perf_counter()}),
        language="en",
    )
    audio = _audio(clip)
    step = SR // 50
    speech_end = int(clip["speech"][-1][1] * SR) if clip["speech"] else -1
    last_word_at = 0.0
    start = time.perf_counter()
    for i in range(0, len(audio), step):
        session.feed(audio[i : i + step])
        if i < speech_end <= i + step:
            last_word_at = time.perf_counter()
        due = start + (i + step) / SR
        await asyncio.sleep(max(0.0, due - time.perf_counter()))
    deadline = time.perf_counter() + 3
    while session.closing and time.perf_counter() < deadline:
        await asyncio.sleep(0.02)
    await session.close()
    return events, last_word_at


def _check(clip: dict, events: list[dict], last_word_at: float) -> None:
    ends = [e for e in events if e["type"] == "turn_end"]
    finals = [e for e in events if e["type"] == "final"]
    heard = [f["text"] for f in finals]
    assert len(ends) == clip["turns"], (clip["id"], [(e["reason"], e.get("probability")) for e in ends], heard)
    assert len(finals) == clip["turns"], (clip["id"], heard)
    for final, words in zip(finals, clip["words"]):
        said = live.normalise(final["text"]).split()
        assert "dropped" not in final, (clip["id"], final)
        assert all(w in said for w in words), (clip["id"], final["text"], words)
    order = [e["type"] for e in events if e["type"] in ("speech_start", "turn_end", "final")]
    assert order == ["speech_start", "turn_end", "final"] * clip["turns"], (clip["id"], order)
    if clip["turns"]:
        end, final = ends[-1], finals[-1]
        TIMINGS["turn_end_ms"].append((end["_t"] - last_word_at) * 1000)
        TIMINGS["final_ms"].append((final["_t"] - last_word_at) * 1000)
        TIMINGS["pass_ms"].append(final["pass_ms"])
        print(
            f"\n  {clip['id']:10s} turn_end {(end['_t'] - last_word_at) * 1000:5.0f} ms ({end['reason']}, "
            f"p={end['probability']})  final {(final['_t'] - last_word_at) * 1000:5.0f} ms "
            f"(pass {final['pass_ms']} ms, reused={final['reused']})  {final['text']!r}"
        )


@pytest.mark.parametrize("clip", [c for c in _manifest() if "turns" in c and not c.get("scripted")], ids=lambda c: c["id"])
def test_clip_gives_the_right_turns(clip, models):
    whisper, smart = models
    events, last_word_at = asyncio.run(_drive(clip, whisper, smart))
    _check(clip, events, last_word_at)
    if clip["id"] == "noise":
        assert not [e for e in events if e["type"] in ("speech_start", "partial")]


@pytest.mark.parametrize("clip", [c for c in _manifest() if c.get("scripted")], ids=lambda c: c["id"])
def test_mid_thought_pause_does_not_end_the_turn(clip, models):
    whisper, smart = models
    turn = FirstPauseUnfinished(smart)
    events, last_word_at = asyncio.run(_drive(clip, whisper, turn))
    _check(clip, events, last_word_at)
    assert turn.calls >= 2  # it paused, was told 'not finished', and carried on
    partials = [e["text"] for e in events if e["type"] == "partial"]
    assert partials, "no captions while speaking"


def test_partials_settle_into_words_while_speaking(models):
    clip = next(c for c in _manifest() if c["id"] == "dentist")
    whisper, smart = models
    events, _ = asyncio.run(_drive(clip, whisper, smart))
    partials = [e for e in events if e["type"] == "partial"]
    assert len(partials) >= 3
    assert len({p["turn"] for p in partials}) == 1
    stable = [p["stable"] for p in partials]
    assert any(len(s.split()) >= 4 for s in stable), stable
    # Settled words only grow (LocalAgreement keeps what two passes agreed on).
    for a, b in zip(stable, stable[1:]):
        assert b.startswith(a), (a, b)


def test_a_pause_inside_a_sentence_loses_no_words(models):
    """Kokoro pauses ~300 ms after "Thursday" and Smart Turn may call it done.
    Whether that's one turn or two, every word arrives, in order; joining a
    turn that carries on is the Talk session's job (speculative start, WP-T2)."""
    clip = next(c for c in _manifest() if c["id"] == "dentist_pause")
    whisper, smart = models
    events, _ = asyncio.run(_drive(clip, whisper, smart))
    finals = [e for e in events if e["type"] == "final"]
    assert 1 <= len(finals) <= 2
    said = live.normalise(" ".join(f["text"] for f in finals)).split()
    for word in ("dentist", "calendar", "thursday", "morning"):
        assert word in said, said
    print(f"\n  dentist_pause: {len(finals)} turn(s): {[f['text'] for f in finals]}")


def test_zz_latency_summary():
    """Printed for the report; asserted against WP-T0's reset targets with room
    for a busy box: decision ~280 ms, final text ~600 ms after the last word."""
    if not TIMINGS["final_ms"]:
        pytest.skip("no clip runs")
    med = {k: round(statistics.median(v)) for k, v in TIMINGS.items()}
    print(f"\n  median over {len(TIMINGS['final_ms'])} turns: {med}")
    assert med["turn_end_ms"] <= 450
    assert med["final_ms"] <= 1000
