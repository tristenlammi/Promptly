"""Turn logic of the live lane (WP-T1) with scripted voices, passes and turn checks.

No models: "speech" is a tone, the VAD is an energy check, a pass returns one
word per 300 ms of tone it heard, and Smart Turn answers from a script. Run in
the whisper image (needs numpy and faster-whisper on the path for ``live``):

    docker run --rm -v "$PWD/whisper:/app" -w /app promptly-whisper:<tag> \
        sh -c "pip install -q pytest && python -m pytest -q tests/test_live_logic.py"
"""
from __future__ import annotations

import asyncio
import time

import numpy as np
import pytest

import live
from live import WINDOW, LiveConfig, LiveLane, LiveSession, PassResult, Segment

SR = live.SAMPLE_RATE
WORDS = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen".split()


def tone(windows: int) -> np.ndarray:
    t = np.arange(windows * WINDOW) / SR
    return (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def quiet(windows: int) -> np.ndarray:
    return np.zeros(windows * WINDOW, dtype=np.float32)


def ms(n: int) -> int:
    """Windows in about n milliseconds."""
    return max(1, round(n / live.WINDOW_MS))


def energy_vad(window: np.ndarray) -> float:
    return 1.0 if float(np.sqrt(np.mean(window**2))) > 0.01 else 0.0


class FakeWhisper:
    """One word per 300 ms of tone heard; records every pass."""

    def __init__(self, delay: float = 0.005) -> None:
        self.delay = delay
        self.calls: list[int] = []

    def __call__(self, audio: np.ndarray, language: str | None) -> PassResult:
        self.calls.append(len(audio))
        time.sleep(self.delay)
        voiced = sum(1 for i in range(0, len(audio) - WINDOW + 1, WINDOW) if energy_vad(audio[i : i + WINDOW]) > 0.5)
        n = int(voiced * live.WINDOW_MS // 300)
        return PassResult([Segment(" " + " ".join(WORDS[:n]) + ".", 0.01, -0.2)] if n else [], language)


class ScriptedTurn:
    """Smart Turn answers in order (the last one repeats); records each check."""

    def __init__(self, *answers: float, delay: float = 0.0) -> None:
        self.answers = list(answers)
        self.delay = delay
        self.calls = 0

    def __call__(self, audio: np.ndarray) -> float:
        time.sleep(self.delay)
        answer = self.answers[min(self.calls, len(self.answers) - 1)]
        self.calls += 1
        return answer


async def drive(session: LiveSession, audio: np.ndarray, *, speed: float = 1.0, frame_ms: int = 20, settle: float = 0.5) -> None:
    """Feed audio in frames at ``speed`` x real time, then let passes land."""
    step = SR * frame_ms // 1000
    start = time.perf_counter()
    for i in range(0, len(audio), step):
        session.feed(audio[i : i + step])
        due = start + (i + step) / SR / speed
        await asyncio.sleep(max(0.0, due - time.perf_counter()))
    deadline = time.perf_counter() + settle
    while time.perf_counter() < deadline:
        await asyncio.sleep(0.01)


def make(smart=None, whisper=None, lane=None, **cfg) -> tuple[LiveSession, list[dict]]:
    events: list[dict] = []
    session = LiveSession(
        vad=energy_vad,
        transcribe=whisper or FakeWhisper(),
        smart_turn=smart,
        lane=lane or LiveLane(2),
        emit=events.append,
        language="en",
        config=LiveConfig(**cfg),
    )
    return session, events


def kinds(events: list[dict]) -> list[str]:
    return [e["type"] for e in events if e["type"] != "partial"]


def run(coro):
    return asyncio.run(coro)


# ----------------------------------------------------------------- turns


def test_one_turn_ends_on_smart_turn_and_gives_the_final():
    async def go():
        session, events = make(ScriptedTurn(0.95))
        await drive(session, np.concatenate([quiet(ms(400)), tone(ms(1500)), quiet(ms(1500))]), speed=4)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final"]
    end = next(e for e in events if e["type"] == "turn_end")
    final = next(e for e in events if e["type"] == "final")
    assert end["reason"] == "complete" and end["probability"] == 0.95
    # The decision comes at the 250 ms pause, not later.
    assert 250 <= end["at_ms"] - end["speech_end_ms"] <= 330
    assert final["text"].startswith("one two three four five") and "dropped" not in final
    assert any(e["type"] == "partial" for e in events)


def test_not_finished_waits_then_times_out():
    async def go():
        smart = ScriptedTurn(0.2)
        session, events = make(smart)
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(1000)), quiet(ms(2500))]), speed=4)
        await session.close()
        return events, smart

    events, smart = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final"]
    end = events[[e["type"] for e in events].index("turn_end")]
    assert end["reason"] == "timeout"
    assert end["silence_ms"] >= 250 + 1200 and end["at_ms"] - end["speech_end_ms"] < 250 + 1200 + 100
    assert smart.calls == 1


def test_mid_thought_pause_does_not_end_the_turn():
    """'I want to go to the... Bunnings': the first pause scores incomplete."""

    async def go():
        smart = ScriptedTurn(0.1, 0.95)
        whisper = FakeWhisper()
        session, events = make(smart, whisper)
        audio = np.concatenate([quiet(ms(300)), tone(ms(1200)), quiet(ms(800)), tone(ms(900)), quiet(ms(1500))])
        await drive(session, audio, speed=4)
        await session.close()
        return events, smart

    events, smart = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final"]
    final = next(e for e in events if e["type"] == "final")
    # The final heard both halves (2.1 s of speech: 7 words), not the first only.
    assert final["text"] == "one two three four five six seven."
    assert smart.calls == 2
    assert next(e for e in events if e["type"] == "turn_end")["reason"] == "complete"


def test_speech_coming_back_voids_a_late_check_and_the_speculative_final():
    """Smart Turn says complete, but only after they've started talking again."""

    async def go():
        smart = ScriptedTurn(0.97, delay=0.3)
        session, events = make(smart)
        audio = np.concatenate([quiet(ms(300)), tone(ms(1000)), quiet(ms(350)), tone(ms(1000)), quiet(ms(1500))])
        await drive(session, audio, speed=1)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final"]
    assert next(e for e in events if e["type"] == "final")["text"] == "one two three four five six."


def test_two_turns_in_a_row():
    async def go():
        session, events = make(ScriptedTurn(0.9))
        audio = np.concatenate([quiet(ms(300)), tone(ms(700)), quiet(ms(1000)), tone(ms(1300)), quiet(ms(1000))])
        await drive(session, audio, speed=4)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final", "speech_start", "turn_end", "final"]
    finals = [e for e in events if e["type"] == "final"]
    assert [f["turn"] for f in finals] == [1, 2]
    assert finals[0]["text"] == "one two." and finals[1]["text"] == "one two three four."


def test_a_cough_is_dropped_not_a_turn():
    async def go():
        session, events = make(ScriptedTurn(0.9))
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(160)), quiet(ms(800))]), speed=4)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "dropped"]
    assert events[-1]["reason"] == "too_short"


def test_silence_gives_nothing():
    async def go():
        whisper = FakeWhisper()
        session, events = make(ScriptedTurn(0.9), whisper)
        await drive(session, quiet(ms(2000)), speed=8)
        await session.close()
        return events, whisper

    events, whisper = run(go())
    assert events == [] and whisper.calls == []


def test_without_smart_turn_a_silence_hold_ends_the_turn():
    async def go():
        session, events = make(None)
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(1000)), quiet(ms(1200))]), speed=4)
        await session.close()
        return events

    events = run(go())
    end = next(e for e in events if e["type"] == "turn_end")
    assert end["reason"] == "silence" and 700 <= end["at_ms"] - end["speech_end_ms"] <= 760
    assert kinds(events)[-1] == "final"


def test_flush_ends_the_turn_now():
    async def go():
        session, events = make(ScriptedTurn(0.1))
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(1000))]), speed=4, settle=0.05)
        session.flush()
        await asyncio.sleep(0.3)
        session.flush()  # nothing in progress: an empty turn, so the caller isn't left waiting
        await asyncio.sleep(0.1)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "turn_end", "final", "turn_end", "final"]
    ends = [e for e in events if e["type"] == "turn_end"]
    finals = [e for e in events if e["type"] == "final"]
    assert [e["reason"] for e in ends] == ["flush", "flush"]
    assert finals[0]["text"] == "one two three." and finals[1]["text"] == "" and finals[1]["dropped"] == "no_speech"


def test_reset_forgets_the_turn():
    async def go():
        session, events = make(ScriptedTurn(0.9))
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(800))]), speed=4, settle=0.05)
        session.reset()
        await drive(session, np.concatenate([quiet(ms(400)), tone(ms(700)), quiet(ms(800))]), speed=4)
        await session.close()
        return events

    events = run(go())
    assert kinds(events) == ["speech_start", "speech_start", "turn_end", "final"]
    assert [e["turn"] for e in events if e["type"] == "final"] == [2]


def test_a_very_long_turn_is_cut_at_the_limit():
    async def go():
        session, events = make(ScriptedTurn(0.1), max_turn_s=2.0)
        await drive(session, np.concatenate([quiet(ms(300)), tone(ms(3000)), quiet(ms(1600))]), speed=8)
        await session.close()
        return events

    events = run(go())
    assert next(e for e in events if e["type"] == "turn_end")["reason"] == "max_length"


def test_a_pass_that_started_after_the_last_word_is_the_final():
    """No second pass: the partial already heard everything (WP-T0 'reuse')."""

    async def go():
        whisper = FakeWhisper()
        # 12 silent windows fill the pre-roll; 30 speech windows; the first
        # partial is due 4 windows (128 ms) after the last word.
        step_ms = int((9 + 30 + 4) * live.WINDOW_MS)
        session, events = make(ScriptedTurn(0.9, delay=0.05), whisper, partial_step_ms=step_ms)
        await drive(session, np.concatenate([quiet(12), tone(30), quiet(ms(1000))]), speed=2)
        await session.close()
        return events, whisper

    events, whisper = run(go())
    final = next(e for e in events if e["type"] == "final")
    assert final["reused"] is True and final["text"] == "one two three."
    assert len(whisper.calls) == 1


def test_finals_wait_for_a_busy_lane_and_partials_are_dropped():
    """Two speakers on one slot: every final arrives; partials give way."""

    async def go():
        lane = LiveLane(1)
        whisper = FakeWhisper(delay=0.25)
        a, ev_a = make(ScriptedTurn(0.9), whisper, lane)
        b, ev_b = make(ScriptedTurn(0.9), whisper, lane)
        audio = np.concatenate([quiet(ms(300)), tone(ms(2000)), quiet(ms(1500))])
        await asyncio.gather(drive(a, audio, speed=1, settle=1.5), drive(b, audio, speed=1, settle=1.5))
        await a.close()
        await b.close()
        return ev_a, ev_b, lane, a, b

    ev_a, ev_b, lane, a, b = run(go())
    for events in (ev_a, ev_b):
        assert kinds(events) == ["speech_start", "turn_end", "final"]
        assert next(e for e in events if e["type"] == "final")["text"] == "one two three four five six."
    assert lane.partials_dropped > 0 and a.stats["partials_dropped"] + b.stats["partials_dropped"] == lane.partials_dropped
    assert lane.busy == 0 and lane.waiting == 0


# ---------------------------------------------------------------- pieces


def test_lane_priority():
    async def go():
        lane = LiveLane(1)
        assert lane.try_partial() is True
        assert lane.try_partial() is False
        waiter = asyncio.create_task(lane.acquire_final())
        await asyncio.sleep(0.01)
        assert not waiter.done() and lane.waiting == 1
        assert lane.try_partial() is False  # a final is queued: partials give way
        lane.release()
        await asyncio.wait_for(waiter, 1)
        assert lane.busy == 1
        cancelled = asyncio.create_task(lane.acquire_final())
        await asyncio.sleep(0.01)
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        lane.release()
        assert lane.busy == 0 and lane.waiting == 0
        return lane.partials_dropped

    assert run(go()) == 2


def test_local_agreement_only_settles_words_two_passes_share():
    agree = live._Agreement()
    assert agree.update("What's on") == ("", "What's on")
    assert agree.update("What's on my cal") == ("What's on", "What's on my cal")
    assert agree.update("What's on my calendar") == ("What's on my", "What's on my calendar")
    assert agree.update("What's on my calendar today?") == ("What's on my calendar", "What's on my calendar today?")
    # A pass that disagrees with settled words doesn't unsettle them.
    stable, _ = agree.update("Once on my calendar today")
    assert stable == "What's on my calendar"


@pytest.mark.parametrize(
    "segments, text, dropped",
    [
        ([Segment(" Set a timer for ten minutes.", 0.02, -0.3)], "Set a timer for ten minutes.", None),
        ([Segment(" Thanks for watching!", 0.3, -0.5)], "", "blocklist"),
        ([Segment(" Subtitles by the Amara.org community", 0.4, -0.6)], "", "blocklist"),
        ([Segment(" you", 0.5, -0.9)], "", "blocklist"),
        ([Segment(" Okay.", 0.95, -0.4)], "", "no_speech"),
        ([Segment(" the", 0.7, -1.4)], "", "no_speech"),
        ([Segment(" ...", 0.1, -0.2)], "", "no_speech"),
        ([Segment(" Yes.", 0.3, -0.3)], "Yes.", None),
        ([Segment(" Thank you.", 0.1, -0.2)], "Thank you.", None),
    ],
)
def test_hallucination_filter(segments, text, dropped):
    assert live.filter_text(PassResult(segments, "en")) == (text, dropped)
