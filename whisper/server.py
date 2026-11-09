"""Promptly speech-to-text worker (Voice Phase 1).

A tiny FastAPI service wrapping ``faster-whisper``. The backend POSTs a
short audio clip (the browser records dictation with ``MediaRecorder``,
usually WebM/Opus) to ``/transcribe`` and gets back the transcript text.

Design notes
------------
* **One model, loaded once.** ``WhisperModel`` is instantiated at import
  time and reused for every request. The first instantiation downloads
  the model weights from Hugging Face into ``/root/.cache`` — mounted to
  a host volume in compose so it's a one-time cost, not per-boot.
* **int8 on CPU by default.** The defaults (``base`` / ``int8`` / ``cpu``)
  are tuned for "drop in and run" on a homelab box with no GPU. An
  operator with a GPU sets ``WHISPER_DEVICE=cuda`` +
  ``WHISPER_COMPUTE_TYPE=float16`` and can bump ``WHISPER_MODEL`` to
  ``small`` / ``medium`` / ``large-v3`` for higher accuracy.
* **VAD trimming.** ``vad_filter=True`` drops leading/trailing silence so
  a clip where the user paused before speaking still transcribes cleanly
  and a bit faster.
* **Stateless + internal-only.** Like the code sandbox this lives on the
  internal ``promptly`` docker network; only the backend reaches it.
* **Live speech for Talk** (``WS /live``, WP-T1): a separate, smaller model
  (``WHISPER_LIVE_MODEL``, ``base`` by default) in its own ``live`` lane with
  ``WHISPER_LIVE_SLOTS`` slots, so live turns never queue behind dictation or
  meetings (which keep ``WHISPER_MODEL``). Turn logic is in ``live.py``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import threading
import time

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel

import live

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("promptly.whisper")

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
# How many CPU threads CTranslate2 may use per transcription. 0 lets the
# library pick (= number of cores). Capped via env on shared boxes so a
# long clip doesn't peg every core.
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "0"))
# Hard ceiling on a single clip. Dictation turns are short; anything past
# this is almost certainly a stuck recording or an abusive upload.
MAX_AUDIO_BYTES = int(os.environ.get("WHISPER_MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))

logger.info(
    "Loading Whisper model %r (device=%s compute=%s) — first run downloads weights…",
    MODEL_NAME,
    DEVICE,
    COMPUTE_TYPE,
)
_t0 = time.monotonic()
model = WhisperModel(
    MODEL_NAME,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=CPU_THREADS,
    # Two transcriptions can run at once: one per lane below.
    num_workers=2,
)

# Two lanes (R-197). A meeting is transcribed in long chunks that take
# minutes each; dictation and voice mode used to queue behind them on this
# single process and time out. Batch work (meetings) goes one chunk at a
# time in its own lane; short interactive clips have the other.
_LANES = {"interactive": asyncio.Semaphore(1), "batch": asyncio.Semaphore(1)}
_waiting = {"interactive": 0, "batch": 0}
logger.info("Model ready in %.1fs", time.monotonic() - _t0)

# ---------------------------------------------------------------- live lane
# WP-T0 measured ``small`` at 2.7x real time as a live lane on CPU, so Talk
# hears with ``base`` while dictation and meetings keep WHISPER_MODEL. Always
# its own instance, so its threads and slots don't touch the other lanes.
# "off" skips loading it (saves ~320 MB; /live then refuses).
LIVE_MODEL_NAME = os.environ.get("WHISPER_LIVE_MODEL", "base").strip()
LIVE_SLOTS = max(1, int(os.environ.get("WHISPER_LIVE_SLOTS", "2")))
LIVE_THREADS = int(os.environ.get("WHISPER_LIVE_THREADS", "4"))
# Sockets at once. Passes are what the slots limit; this only bounds memory.
LIVE_MAX_SESSIONS = int(os.environ.get("WHISPER_LIVE_MAX_SESSIONS", "8"))
# Smart Turn lives next to the Whisper weights, in ./data/whisper.
SMART_TURN_DIR = os.environ.get("WHISPER_SMART_TURN_DIR", "/root/.cache/smart-turn")
# One binary message: at most 2 s of PCM16 (Opus packets are far smaller).
LIVE_MAX_FRAME_BYTES = 64 * 1024

live_model: WhisperModel | None = None
if LIVE_MODEL_NAME.lower() not in {"", "off", "none", "false", "0"}:
    _t0 = time.monotonic()
    live_model = WhisperModel(
        LIVE_MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=LIVE_THREADS,
        num_workers=LIVE_SLOTS,
    )
    logger.info("Live model %r ready in %.1fs (%d slots)", LIVE_MODEL_NAME, time.monotonic() - _t0, LIVE_SLOTS)

live_lane = live.LiveLane(LIVE_SLOTS)
_live_sessions = 0
_smart_turn: live.SmartTurn | None = None
_smart_turn_state = "loading" if live_model is not None else "off"


def _load_smart_turn() -> None:
    """Fetch (first start only) and load Smart Turn without holding up /transcribe.
    If it can't be had, /live still works with a plain silence hold."""
    global _smart_turn, _smart_turn_state
    try:
        _smart_turn = live.SmartTurn(live.ensure_smart_turn(SMART_TURN_DIR))
        _smart_turn_state = "ok"
        logger.info("Smart Turn ready")
    except Exception as exc:  # noqa: BLE001
        _smart_turn_state = "unavailable"
        logger.warning("Smart Turn unavailable, live turns end on silence alone: %s", exc)


if live_model is not None:
    threading.Thread(target=_load_smart_turn, name="smart-turn-load", daemon=True).start()

app = FastAPI(title="Promptly Whisper", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        # Clips waiting for each lane — shown in Admin → Health.
        "queued": dict(_waiting),
        "live": {
            "model": LIVE_MODEL_NAME if live_model is not None else None,
            "slots": LIVE_SLOTS,
            "busy": live_lane.busy,
            "finals_waiting": live_lane.waiting,
            "sessions": _live_sessions,
            "partials_dropped": live_lane.partials_dropped,
            "smart_turn": _smart_turn_state,
        },
    }


def _run(path: str, lang: str | None):
    segments, info = model.transcribe(
        path,
        language=lang,
        vad_filter=True,
        # ``condition_on_previous_text=False`` stops Whisper from
        # looping/repeating on short clips with little context.
        condition_on_previous_text=False,
    )
    # ``segments`` is a lazy generator — transcription actually runs as
    # we iterate it, so iterate here, off the event loop.
    return "".join(seg.text for seg in segments).strip(), info


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    # BCP-47 / ISO-639 language hint. Empty / "auto" lets Whisper detect.
    language: str | None = Form(default=None),
    # "batch" for meeting chunks; anything else is an interactive clip.
    lane: str | None = Form(default=None),
) -> dict:
    lane_name = "batch" if (lane or "").strip().lower() == "batch" else "interactive"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio exceeds {MAX_AUDIO_BYTES // (1024 * 1024)} MB limit.",
        )

    lang = (language or "").strip().lower()
    if lang in {"", "auto"}:
        lang = None
    elif "-" in lang:
        # Normalise "en-US" → "en"; Whisper wants the bare language code.
        lang = lang.split("-", 1)[0]

    # faster-whisper decodes via PyAV from a path, so spool to a temp file.
    # ``delete=False`` + manual unlink keeps it working on Windows-mounted
    # volumes too (an open NamedTemporaryFile can't be re-opened there).
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        _waiting[lane_name] += 1
        started = False
        try:
            async with _LANES[lane_name]:
                _waiting[lane_name] -= 1
                started = True
                t0 = time.monotonic()
                # Off the event loop, so /health and the other lane keep
                # answering while this one works.
                text, info = await asyncio.to_thread(_run, tmp_path, lang)
        finally:
            if not started:  # cancelled while waiting
                _waiting[lane_name] -= 1
        elapsed = time.monotonic() - t0
        logger.info(
            "transcribed %d bytes in %.2fs (lang=%s) -> %d chars",
            len(data),
            elapsed,
            info.language,
            len(text),
        )
        return {"text": text, "language": info.language}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface a clean 500
        logger.exception("transcription failed")
        raise HTTPException(
            status_code=500, detail=f"Transcription failed: {exc}"
        ) from exc
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ------------------------------------------------------------ WS /live (Talk)
#
# Internal protocol, spoken by the backend's Talk session (WP-T2):
#
#   connect   /live?language=en&codec=pcm16|opus
#             pcm16: little-endian 16-bit mono at 16 kHz, any frame size.
#             opus:  one raw Opus packet per binary message, decoded at 16 kHz.
#   in        binary audio; JSON text {"type": "flush"} (tap to talk: end the
#             turn now), {"type": "reset"} (drop the turn in progress, e.g.
#             muted), {"type": "bye"} (send outstanding finals, then close).
#   out       JSON text: ready, speech_start, partial {text, stable}, turn_end
#             {reason: complete|timeout|silence|flush|max_length, probability},
#             final {text, dropped?, pass_ms, wait_ms, reused}, dropped
#             {reason: too_short}, error {message, code?}. Every event carries
#             its turn number; a final always follows its turn_end, and an empty
#             final (with ``dropped``) means nothing worth answering was heard.
#
# Close codes: 4503 live speech is off on this server, 1013 too many live
# sessions (try again later), 1003 unsupported codec, 1009 frame too big.

_LIVE_CODECS = {"pcm16", "opus"}


def _live_language(value: str | None) -> str | None:
    lang = (value or "").strip().lower()
    if lang in {"", "auto"}:
        return None
    return lang.split("-", 1)[0]


class _Pcm16In:
    def __init__(self) -> None:
        self._odd = b""

    def __call__(self, data: bytes) -> np.ndarray:
        data = self._odd + data
        cut = len(data) - (len(data) % 2)
        self._odd = data[cut:]
        return np.frombuffer(data[:cut], dtype="<i2").astype(np.float32) / 32768.0


class _OpusIn:
    def __init__(self) -> None:
        import opuslib

        self._dec = opuslib.Decoder(live.SAMPLE_RATE, 1)

    def __call__(self, packet: bytes) -> np.ndarray:
        pcm = self._dec.decode(packet, 1920)  # room for 120 ms at 16 kHz
        return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def _live_pass(audio: np.ndarray, language: str | None) -> live.PassResult:
    return live.whisper_pass(live_model, audio, language)


async def _refuse(ws: WebSocket, code: int, message: str) -> None:
    await ws.send_text(json.dumps({"type": "error", "code": code, "message": message}))
    await ws.close(code=code)


@app.websocket("/live")
async def live_socket(ws: WebSocket) -> None:
    global _live_sessions
    await ws.accept()
    params = ws.query_params
    codec = (params.get("codec") or "pcm16").strip().lower()
    if live_model is None:
        await _refuse(ws, 4503, "Live speech is turned off on this server.")
        return
    if codec not in _LIVE_CODECS:
        await _refuse(ws, 1003, f"Unsupported codec {codec!r}.")
        return
    if _live_sessions >= LIVE_MAX_SESSIONS:
        await _refuse(ws, 1013, "Too many live sessions right now.")
        return
    decode = _OpusIn() if codec == "opus" else _Pcm16In()
    language = _live_language(params.get("language"))

    outbox: asyncio.Queue[dict | None] = asyncio.Queue()
    session = live.LiveSession(
        vad=live.SileroStream(),
        transcribe=_live_pass,
        smart_turn=_smart_turn,
        lane=live_lane,
        emit=outbox.put_nowait,
        language=language,
    )

    async def sender() -> None:
        while (event := await outbox.get()) is not None:
            await ws.send_text(json.dumps(event))

    _live_sessions += 1
    send_task = asyncio.create_task(sender())
    started = time.monotonic()
    received = 0
    logger.info("live session open (codec=%s, smart_turn=%s)", codec, _smart_turn_state)
    try:
        outbox.put_nowait(
            {
                "type": "ready",
                "model": LIVE_MODEL_NAME,
                "sample_rate": live.SAMPLE_RATE,
                "codec": codec,
                "language": language,
                "smart_turn": _smart_turn is not None,
            }
        )
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data = msg.get("bytes")
            if data is not None:
                if len(data) > LIVE_MAX_FRAME_BYTES:
                    outbox.put_nowait({"type": "error", "code": 1009, "message": "Audio frame too big."})
                    await asyncio.sleep(0)
                    await ws.close(code=1009)
                    break
                received += len(data)
                try:
                    samples = decode(data)
                except Exception:  # noqa: BLE001 - a corrupt packet is skipped, not fatal
                    continue
                session.feed(samples)
                continue
            try:
                command = json.loads(msg.get("text") or "{}")
            except ValueError:
                continue
            kind = command.get("type") if isinstance(command, dict) else None
            if kind == "flush":
                session.flush()
            elif kind == "reset":
                session.reset()
            elif kind == "bye":
                if session.turn is not None:
                    session.flush()
                deadline = time.monotonic() + 10
                while session.closing and time.monotonic() < deadline:
                    await asyncio.sleep(0.02)
                outbox.put_nowait({"type": "bye"})
                outbox.put_nowait(None)
                await send_task
                await ws.close(code=1000)
                break
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
        if not send_task.done():
            outbox.put_nowait(None)
            try:
                await asyncio.wait_for(send_task, timeout=1)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001 - socket already gone
                send_task.cancel()
        _live_sessions -= 1
        logger.info(
            "live session closed after %.1fs: %d bytes in, %d turns, %d passes, %d partials dropped",
            time.monotonic() - started,
            received,
            session.stats["turns"],
            session.stats["passes"],
            session.stats["partials_dropped"],
        )
