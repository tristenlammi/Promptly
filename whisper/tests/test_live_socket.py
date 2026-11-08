"""WS /live end to end against a running whisper service (WP-T1).

Set ``LIVE_URL`` (ws://127.0.0.1:8000/live) and ``LIVE_CLIPS`` (the folder
``tts/tests/make_live_clips.py`` wrote). Run inside a throwaway container from
the worktree's image, never the main ``Promptly-Whisper``.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import pytest

URL = os.environ.get("LIVE_URL", "")
CLIPS = os.environ.get("LIVE_CLIPS", "")
pytestmark = pytest.mark.skipif(not (URL and CLIPS), reason="set LIVE_URL and LIVE_CLIPS")


def _health() -> dict:
    base = URL.replace("ws://", "http://").rsplit("/live", 1)[0]
    with urllib.request.urlopen(f"{base}/health", timeout=5) as resp:
        return json.loads(resp.read())


@pytest.fixture(scope="module", autouse=True)
def smart_turn_ready():
    deadline = time.time() + 120
    while time.time() < deadline:
        if _health()["live"]["smart_turn"] != "loading":
            break
        time.sleep(1)
    assert _health()["live"]["smart_turn"] == "ok"


def _pcm(name: str) -> bytes:
    with wave.open(str(Path(CLIPS) / f"{name}.wav"), "rb") as w:
        return w.readframes(w.getnframes())


def _talk(name: str, *, codec: str = "pcm16", then: list[dict] | None = None, wait_for: int = 1, cut_s: float | None = None):
    """Stream a clip at real time; collect events until ``wait_for`` finals."""
    from websockets.sync.client import connect

    events: list[dict] = []
    pcm = _pcm(name)
    if cut_s is not None:
        pcm = pcm[: int(cut_s * 16000) * 2]
    with connect(f"{URL}?language=en&codec={codec}", max_size=None) as ws:
        events.append(json.loads(ws.recv(timeout=5)))

        def reader():
            try:
                for msg in ws:
                    events.append(json.loads(msg))
            except Exception:  # noqa: BLE001 - closed
                pass

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        start = time.perf_counter()
        if codec == "opus":
            import opuslib

            enc = opuslib.Encoder(16000, 1, opuslib.APPLICATION_VOIP)
            frames = [pcm[i : i + 640] for i in range(0, len(pcm) - 639, 640)]
            for i, frame in enumerate(frames):
                ws.send(enc.encode(frame, 320))
                time.sleep(max(0.0, start + (i + 1) * 0.02 - time.perf_counter()))
        else:
            for i in range(0, len(pcm), 640):
                ws.send(pcm[i : i + 640])
                time.sleep(max(0.0, start + (i + 640) / 32000 - time.perf_counter()))
        for command in then or []:
            ws.send(json.dumps(command))
        deadline = time.time() + 5
        while time.time() < deadline and sum(e["type"] == "final" for e in events) < wait_for:
            time.sleep(0.02)
        ws.send(json.dumps({"type": "bye"}))
        t.join(timeout=5)
    return events


def test_ready_then_a_turn_over_pcm():
    events = _talk("calendar")
    assert events[0]["type"] == "ready" and events[0]["model"] == "base" and events[0]["smart_turn"] is True
    kinds = [e["type"] for e in events if e["type"] not in ("partial",)]
    assert kinds == ["ready", "speech_start", "turn_end", "final", "bye"]
    final = next(e for e in events if e["type"] == "final")
    assert "calendar" in final["text"].lower()
    assert any(e["type"] == "partial" for e in events)


def test_live_audio_is_never_written_to_disk():
    """Run in the service's own container: a live turn leaves no new files."""

    def files() -> set[str]:
        found = set()
        for root in ("/tmp", "/app", "/root/.cache"):
            for dirpath, _dirs, names in os.walk(root):
                if "__pycache__" not in dirpath and "/app/tests" not in dirpath:
                    found.update(os.path.join(dirpath, n) for n in names)
        return found

    before = files()
    events = _talk("yes")
    assert any(e["type"] == "final" and e["text"] for e in events)
    assert files() - before == set()


def test_a_turn_over_opus():
    events = _talk("timer", codec="opus")
    final = next(e for e in events if e["type"] == "final")
    assert "timer" in final["text"].lower()


def test_flush_ends_a_turn_without_waiting_for_silence():
    # Cut the clip right after the speech, then say "done" (tap to talk).
    events = _talk("dentist", cut_s=4.5, then=[{"type": "flush"}])
    end = next(e for e in events if e["type"] == "turn_end")
    assert end["reason"] == "flush"
    assert "dentist" in next(e for e in events if e["type"] == "final")["text"].lower()


def test_noise_is_not_a_turn():
    events = _talk("noise", wait_for=0)
    assert [e["type"] for e in events] == ["ready", "bye"]


def test_bad_codec_is_refused():
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.client import connect

    with connect(f"{URL}?codec=mp3") as ws:
        event = json.loads(ws.recv(timeout=5))
        assert event["type"] == "error" and event["code"] == 1003
        with pytest.raises(ConnectionClosed) as closed:
            ws.recv(timeout=5)
    assert closed.value.rcvd.code == 1003


def test_two_people_talking_at_once_both_get_their_finals():
    results: dict[str, list[dict]] = {}

    def one(name: str) -> None:
        results[name] = _talk(name)

    threads = [threading.Thread(target=one, args=(n,)) for n in ("calendar", "dentist")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert "calendar" in next(e for e in results["calendar"] if e["type"] == "final")["text"].lower()
    assert "dentist" in next(e for e in results["dentist"] if e["type"] == "final")["text"].lower()


def test_dictation_still_works_beside_the_live_lane():
    import io
    import uuid

    body = io.BytesIO()
    boundary = uuid.uuid4().hex
    wav = (Path(CLIPS) / "timer.wav").read_bytes()
    body.write(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    body.write(wav)
    body.write(f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nen\r\n--{boundary}--\r\n".encode())
    base = URL.replace("ws://", "http://").rsplit("/live", 1)[0]
    req = urllib.request.Request(f"{base}/transcribe", data=body.getvalue(), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        assert "timer" in json.loads(resp.read())["text"].lower()


def test_health_reports_the_live_lane():
    live = _health()["live"]
    assert live["model"] == "base" and live["slots"] == 2 and live["sessions"] == 0 and live["busy"] == 0
