"""Live speech for Talk (WP-T1): turn-taking on a stream of audio.

The ``/live`` WebSocket in ``server.py`` feeds 16 kHz mono audio into a
:class:`LiveSession` and sends its events back. Everything here is
transport-agnostic and takes its models as plain callables, so the turn logic
is tested with scripted voices and turn checks as well as the real models.

How a turn works (numbers from ``docs/talking-plan.md``, "WP-T0 measurements"):

* **Silero VAD** (bundled with faster-whisper) scores every 32 ms window.
  Three speech windows in a row start a turn (``speech_start``), keeping 300 ms
  of audio from before so the first syllable isn't clipped.
* **Partials** are paced by the pass, not the clock: a new pass starts when the
  previous one has finished and at least 400 ms of new audio has arrived. Each
  pass re-decodes the whole utterance; words two passes in a row agree on
  (LocalAgreement-2) become ``stable``. Partials only take a free slot of the
  ``live`` lane; when every slot is busy they're dropped, finals never are.
* At **250 ms of silence** two things start at once: **Smart Turn v3** on the
  last 8 s, and the **speculative final** pass. If a pass already running
  started after the last word, it becomes the final instead of queueing another.
* Smart Turn says complete: ``turn_end`` at once (~280 ms after the last word),
  ``final`` when the pass lands (~600 ms). Not complete: wait up to 1.2 s more
  ("I want to go to... um... Bunnings"). Speech coming back cancels the check
  and throws the speculative final away.
* **Hallucination filter:** a turn with under 300 ms of speech is ``dropped``;
  segments Whisper itself thinks are no speech, and a short phrase blocklist
  ("Thanks for watching"), come back as an empty final with ``dropped`` set.

Audio is never written anywhere: the utterance lives in memory until its final
is sent, and only sizes and timings are logged.
"""
from __future__ import annotations

import asyncio
import collections
import hashlib
import logging
import os
import re
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

logger = logging.getLogger("promptly.whisper.live")

SAMPLE_RATE = 16_000
WINDOW = 512  # Silero v5's window at 16 kHz
WINDOW_MS = WINDOW * 1000 / SAMPLE_RATE  # 32 ms

# Smart Turn v3.2 (Pipecat, BSD 2-clause), the int8 CPU build, pinned by hash.
# Same file and hash WP-T0 measured (backend/app/talk/bench.py).
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"
SMART_TURN_URL = (
    "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/"
    "f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx"
)
SMART_TURN_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class LiveConfig:
    onset: float = 0.5  # Silero probability that counts as speech
    offset: float = 0.35  # ...and stays speech once started (hysteresis)
    start_windows: int = 3  # ~96 ms of speech starts a turn
    preroll_ms: int = 300
    pause_ms: int = _env_int("WHISPER_LIVE_PAUSE_MS", 250)
    hold_ms: int = _env_int("WHISPER_LIVE_HOLD_MS", 1200)
    # Without Smart Turn (download failed), a plain silence hold ends the turn.
    fallback_silence_ms: int = _env_int("WHISPER_LIVE_FALLBACK_MS", 700)
    resume_windows: int = 3  # speech windows in a row that cancel a pause
    min_speech_ms: int = _env_int("WHISPER_LIVE_MIN_SPEECH_MS", 300)
    partial_step_ms: int = 400
    # A pass only counts as the final if it heard this much past the last word.
    final_tail_ms: int = 96
    max_turn_s: float = 28.0  # Whisper sees 30 s at most
    smart_turn_threshold: float = 0.5
    smart_turn_window_s: float = 8.0


# ------------------------------------------------------------------ models


class SileroStream:
    """Silero VAD v5 one window at a time, using faster-whisper's bundled ONNX.

    faster-whisper scores a whole clip at once; a live stream needs the decoder
    state and the previous window's last 64 samples carried between calls.
    One thread: each window is a few hundred microseconds of work.
    """

    CONTEXT = 64
    _sessions: tuple[Any, Any] | None = None

    @classmethod
    def _shared(cls) -> tuple[Any, Any]:
        # ONNX sessions are stateless and thread-safe: load once, share them;
        # each stream keeps its own decoder state and context.
        if cls._sessions is None:
            import onnxruntime
            from faster_whisper.utils import get_assets_path

            opts = onnxruntime.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            opts.log_severity_level = 4
            assets = get_assets_path()
            cls._sessions = tuple(
                onnxruntime.InferenceSession(
                    os.path.join(assets, name), providers=["CPUExecutionProvider"], sess_options=opts
                )
                for name in ("silero_encoder_v5.onnx", "silero_decoder_v5.onnx")
            )
        return cls._sessions

    def __init__(self) -> None:
        self._enc, self._dec = self._shared()
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros(self.CONTEXT, dtype=np.float32)

    def __call__(self, window: np.ndarray) -> float:
        x = np.concatenate([self._context, window]).astype(np.float32)[None, :]
        self._context = window[-self.CONTEXT :].copy()
        enc = self._enc.run(None, {"input": x})[0].reshape(1, 128)
        out, self._state = self._dec.run(None, {"input": enc, "state": self._state})
        return float(np.asarray(out).reshape(-1)[0])


def ensure_smart_turn(cache_dir: str | os.PathLike) -> Path:
    """The Smart Turn model in ``cache_dir`` (``data/whisper``), downloaded once
    and checked against the pinned SHA-256. A file that doesn't match is removed."""
    folder = Path(cache_dir)
    path = folder / SMART_TURN_FILE
    if not path.exists():
        folder.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        logger.info("Downloading %s ...", SMART_TURN_FILE)
        with urllib.request.urlopen(SMART_TURN_URL, timeout=120) as resp, open(tmp, "wb") as fh:
            while chunk := resp.read(1 << 20):
                fh.write(chunk)
        tmp.replace(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SMART_TURN_SHA256:
        path.unlink(missing_ok=True)
        raise RuntimeError(f"Smart Turn model hash mismatch ({digest[:12]}...); removed it")
    return path


class SmartTurn:
    """Smart Turn v3: is the speaker done? Pinned to one thread (~30 ms a check)."""

    def __init__(self, path: str | os.PathLike) -> None:
        import onnxruntime as ort
        from faster_whisper.feature_extractor import FeatureExtractor

        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])
        self._input = self._session.get_inputs()[0].name
        self._extractor = FeatureExtractor(feature_size=80, chunk_length=8)

    def __call__(self, audio: np.ndarray) -> float:
        """Probability the turn is complete, from the last 8 s (front-padded),
        normalised and turned into Whisper log-mels as Pipecat's inference does."""
        n = 8 * SAMPLE_RATE
        audio = np.asarray(audio[-n:], dtype=np.float32)
        if len(audio) < n:
            audio = np.pad(audio, (n - len(audio), 0))
        audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
        feats = self._extractor(audio.astype(np.float32), padding=0)[:, :800]
        if feats.shape[1] < 800:
            feats = np.pad(feats, ((0, 0), (0, 800 - feats.shape[1])))
        out = self._session.run(None, {self._input: feats[None, :, :].astype(np.float32)})[0]
        return float(np.asarray(out).reshape(-1)[0])


# ------------------------------------------------------------- passes, text


@dataclass
class Segment:
    text: str
    no_speech_prob: float = 0.0
    avg_logprob: float = 0.0


@dataclass
class PassResult:
    segments: list[Segment]
    language: str | None = None

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.segments).strip()


def whisper_pass(model, audio: np.ndarray, language: str | None) -> PassResult:
    """One live pass. The same settings for partials and finals, so any pass can
    become the final (WP-T0: beam 5 vs greedy made no timing difference worth two
    configurations). One temperature, so a bad decode can't double the time."""
    segments, info = model.transcribe(
        audio,
        language=language,
        beam_size=5,
        temperature=0.0,
        vad_filter=False,
        condition_on_previous_text=False,
        without_timestamps=True,
    )
    segs = [Segment(s.text, float(s.no_speech_prob), float(s.avg_logprob)) for s in segments]
    return PassResult(segs, info.language)


_NORM = re.compile(r"[^\w']+", re.UNICODE)

# Whole utterances Whisper invents from noise and silence (subtitle credits from
# its training data). Matched on normalised text: exact phrases, and fragments.
_HALLUCINATED = {
    "you",
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "thank you for watching and see you next time",
    "please subscribe",
    "like and subscribe",
}
_HALLUCINATED_PARTS = (
    "thanks for watching",
    "thank you for watching",
    "subscribe to my channel",
    "subscribe to the channel",
    "amara org",
    "subtitles by",
    "captions by",
    "transcription by",
    "transcribed by",
)


def normalise(text: str) -> str:
    return " ".join(_NORM.sub(" ", text.lower().replace("’", "'")).split())


def filter_text(result: PassResult) -> tuple[str, str | None]:
    """The words to keep from a pass, and why it was dropped (or None)."""
    kept = [s for s in result.segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)]
    text = "".join(s.text for s in kept).strip()
    norm = normalise(text)
    if not norm:
        return "", "no_speech"
    if result.segments and len(norm.split()) <= 3:
        mean_ns = sum(s.no_speech_prob for s in result.segments) / len(result.segments)
        if mean_ns > 0.8:
            return "", "no_speech"
    if norm in _HALLUCINATED or any(p in norm for p in _HALLUCINATED_PARTS):
        return "", "blocklist"
    return text, None


# ------------------------------------------------------------------ the lane


class LiveLane:
    """Slots for live passes, shared by every live session (``WHISPER_LIVE_SLOTS``).

    Finals wait for a slot, first come first served. Partials only take a slot
    that is free right now with no final waiting; otherwise they're dropped.
    """

    def __init__(self, slots: int) -> None:
        self.slots = max(1, slots)
        self.busy = 0
        self.partials_dropped = 0
        self._waiters: collections.deque[asyncio.Future] = collections.deque()

    def try_partial(self) -> bool:
        if self.busy < self.slots and not self._waiters:
            self.busy += 1
            return True
        self.partials_dropped += 1
        return False

    async def acquire_final(self) -> None:
        if self.busy < self.slots and not self._waiters:
            self.busy += 1
            return
        fut = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        try:
            await fut  # release() hands the slot over (busy stays counted)
        except asyncio.CancelledError:
            if fut.done() and not fut.cancelled():
                self.release()  # it was handed over just as we were cancelled
            else:
                try:
                    self._waiters.remove(fut)
                except ValueError:
                    pass
            raise

    def release(self) -> None:
        while self._waiters:
            fut = self._waiters.popleft()
            if not fut.done():
                fut.set_result(None)
                return
        self.busy = max(0, self.busy - 1)

    @property
    def waiting(self) -> int:
        return len(self._waiters)


# ------------------------------------------------------------- local agreement


def _words(text: str) -> list[str]:
    return text.split()


def _same(a: str, b: str) -> bool:
    return normalise(a) == normalise(b)


@dataclass
class _Agreement:
    """LocalAgreement-2: a word is stable once two passes in a row agree on it."""

    committed: list[str] = field(default_factory=list)
    previous: list[str] = field(default_factory=list)

    def update(self, text: str) -> tuple[str, str]:
        cur = _words(text)
        n = len(self.committed)
        if len(cur) >= n and all(_same(a, b) for a, b in zip(self.committed, cur[:n])):
            while n < len(cur) and n < len(self.previous) and _same(cur[n], self.previous[n]):
                n += 1
            # Agreed words take the latest pass's spelling and punctuation.
            self.committed = cur[:n]
            full = cur
        else:
            full = self.committed + cur[n:] if len(cur) > n else list(self.committed)
        self.previous = cur
        return " ".join(self.committed), " ".join(full)


# ------------------------------------------------------------------ session


@dataclass
class _Turn:
    id: int
    started_at: int  # session sample clock at the start of the buffer
    chunks: list[np.ndarray] = field(default_factory=list)
    n: int = 0
    first_speech: int = 0
    last_speech_end: int = 0
    silence_ms: float = 0.0
    checking: bool = False
    check_gen: int = 0
    probability: float | None = None
    resume_streak: int = 0
    ended: bool = False
    reason: str = ""
    ended_wall: float = 0.0
    last_pass_n: int = 0
    candidate: PassResult | None = None
    candidate_cover: int = 0
    candidate_ms: float = 0.0
    candidate_reused: bool = False
    final_sent: bool = False
    agreement: _Agreement = field(default_factory=_Agreement)
    last_partial: tuple[str, str] = ("", "")

    def append(self, w: np.ndarray) -> None:
        self.chunks.append(w)
        self.n += len(w)

    def audio(self, upto: int | None = None) -> np.ndarray:
        if len(self.chunks) != 1:
            self.chunks = [np.concatenate(self.chunks)] if self.chunks else [np.zeros(0, np.float32)]
        a = self.chunks[0]
        return a if upto is None else a[:upto]

    def speech_ms(self) -> float:
        return (self.last_speech_end - self.first_speech) * 1000 / SAMPLE_RATE


Emit = Callable[[dict[str, Any]], None]


class LiveSession:
    """One person's live audio: frames in, turn events out.

    ``vad(window) -> probability`` scores one 512-sample window;
    ``transcribe(audio, language) -> PassResult`` is one Whisper pass (run in a
    thread); ``smart_turn(audio) -> probability`` or None to fall back to a
    plain silence hold. ``emit`` is called on the event loop, in order.
    """

    def __init__(
        self,
        *,
        vad: Callable[[np.ndarray], float],
        transcribe: Callable[[np.ndarray, str | None], PassResult],
        smart_turn: Callable[[np.ndarray], float] | None,
        lane: LiveLane,
        emit: Emit,
        language: str | None = None,
        config: LiveConfig | None = None,
    ) -> None:
        self.vad = vad
        self.transcribe = transcribe
        self.smart_turn = smart_turn
        self.lane = lane
        self.emit = emit
        self.language = language
        self.cfg = config or LiveConfig()
        self.clock = 0  # samples scored by the VAD
        self._pending = np.zeros(0, dtype=np.float32)
        self._in_speech = False
        self._start_streak = 0
        preroll_windows = int(self.cfg.preroll_ms / WINDOW_MS) + self.cfg.start_windows
        self._preroll: collections.deque[np.ndarray] = collections.deque(maxlen=preroll_windows)
        self._next_id = 1
        self.turn: _Turn | None = None
        self.closing: list[_Turn] = []
        self._pass_task: asyncio.Task | None = None
        self._tasks: set[asyncio.Task] = set()
        self._closed = False
        self.stats = {"passes": 0, "partials": 0, "partials_dropped": 0, "turns": 0, "pass_ms_total": 0.0}

    # ----------------------------------------------------------- input
    def feed(self, samples: np.ndarray) -> None:
        if self._closed or len(samples) == 0:
            return
        buf = np.concatenate([self._pending, np.asarray(samples, dtype=np.float32)])
        whole = len(buf) // WINDOW * WINDOW
        for i in range(0, whole, WINDOW):
            self._window(buf[i : i + WINDOW])
        self._pending = buf[whole:]
        self._schedule()

    def flush(self) -> None:
        """The person says they're done (tap to talk): end the turn now."""
        if self._closed:
            return
        t = self.turn
        if t is not None and len(self._pending):
            t.append(self._pending)
        self._pending = np.zeros(0, dtype=np.float32)
        if t is None:
            tid = self._take_id()
            self.emit({"type": "turn_end", "turn": tid, "reason": "flush", "probability": None, "silence_ms": 0, "at_ms": self._ms(self.clock)})
            self.emit({"type": "final", "turn": tid, "text": "", "dropped": "no_speech", "language": self.language, "audio_ms": 0, "speech_ms": 0, "pass_ms": 0, "wait_ms": 0, "reused": False})
            return
        if not t.checking:
            t.last_speech_end = t.n
        self._end(t, "flush")
        self._schedule()

    def reset(self) -> None:
        """Forget the turn in progress (muted, or the caller moved on)."""
        if self.turn is not None:
            self.turn.check_gen += 1
        self.turn = None
        self._preroll.clear()
        self._start_streak = 0

    async def close(self) -> None:
        self._closed = True
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    # ------------------------------------------------------------ VAD
    def _ms(self, samples: int) -> int:
        return int(round(samples * 1000 / SAMPLE_RATE))

    def _take_id(self) -> int:
        tid = self._next_id
        self._next_id += 1
        return tid

    def _window(self, w: np.ndarray) -> None:
        cfg = self.cfg
        p = self.vad(w)
        speech = p >= cfg.onset or (self._in_speech and p >= cfg.offset)
        self._in_speech = speech
        self.clock += len(w)
        t = self.turn
        if t is None:
            self._preroll.append(w)
            self._start_streak = self._start_streak + 1 if speech else 0
            if self._start_streak >= cfg.start_windows:
                t = _Turn(id=self._take_id(), started_at=self.clock - sum(len(x) for x in self._preroll))
                for x in self._preroll:
                    t.append(x)
                t.first_speech = t.n - cfg.start_windows * WINDOW
                t.last_speech_end = t.n
                self._preroll.clear()
                self._start_streak = 0
                self.turn = t
                self.stats["turns"] += 1
                self.emit({"type": "speech_start", "turn": t.id, "at_ms": self._ms(t.started_at + t.first_speech)})
            return

        t.append(w)
        if t.checking:
            t.resume_streak = t.resume_streak + 1 if speech else 0
            if t.resume_streak >= cfg.resume_windows:
                # They carried on: the check and the speculative final are void.
                t.checking = False
                t.check_gen += 1
                t.probability = None
                t.silence_ms = 0.0
                t.last_speech_end = t.n
                t.resume_streak = 0
            else:
                t.silence_ms += WINDOW_MS
                self._maybe_end(t)
        else:
            if speech:
                t.silence_ms = 0.0
                t.last_speech_end = t.n
            else:
                t.silence_ms += WINDOW_MS
                if t.silence_ms >= cfg.pause_ms:
                    self._pause(t)
        if self.turn is t and not t.ended and t.n >= cfg.max_turn_s * SAMPLE_RATE:
            if not t.checking:
                t.last_speech_end = t.n
            self._end(t, "max_length")

    # ---------------------------------------------------------- turns
    def _pause(self, t: _Turn) -> None:
        if t.speech_ms() < self.cfg.min_speech_ms:
            # A cough, a click, a short "mm": not a turn.
            self.emit({"type": "dropped", "turn": t.id, "reason": "too_short", "speech_ms": round(t.speech_ms()), "at_ms": self._ms(self.clock)})
            self.turn = None
            return
        t.checking = True
        t.check_gen += 1
        t.probability = None
        t.resume_streak = 0
        if self.smart_turn is not None:
            self._spawn(self._check(t, t.check_gen, t.audio()[-int(self.cfg.smart_turn_window_s * SAMPLE_RATE) :].copy()))
        # The speculative final is started by _schedule (or adopted from a pass
        # already running that started after the last word).

    async def _check(self, t: _Turn, gen: int, audio: np.ndarray) -> None:
        prob = await asyncio.to_thread(self.smart_turn, audio)
        if t.check_gen != gen or t.ended or self._closed:
            return
        t.probability = prob
        self._maybe_end(t)
        self._schedule()

    def _maybe_end(self, t: _Turn) -> None:
        if t.ended or not t.checking:
            return
        cfg = self.cfg
        if self.smart_turn is None:
            if t.silence_ms >= cfg.fallback_silence_ms:
                self._end(t, "silence")
        elif t.probability is not None and t.probability >= cfg.smart_turn_threshold:
            self._end(t, "complete")
        elif t.silence_ms >= cfg.pause_ms + cfg.hold_ms:
            self._end(t, "timeout")

    def _end(self, t: _Turn, reason: str) -> None:
        t.ended = True
        t.reason = reason
        t.ended_wall = time.perf_counter()
        if self.turn is t:
            self.turn = None
        self.closing.append(t)
        self.emit(
            {
                "type": "turn_end",
                "turn": t.id,
                "reason": reason,
                "probability": None if t.probability is None else round(t.probability, 3),
                "silence_ms": round(t.silence_ms),
                "speech_end_ms": self._ms(t.started_at + t.last_speech_end),
                "at_ms": self._ms(self.clock),
            }
        )
        logger.info("live turn %d ended (%s) after %.1fs of audio", t.id, reason, t.n / SAMPLE_RATE)
        self._send_final_if_ready(t)

    def _final_ready(self, t: _Turn) -> bool:
        if t.candidate is None:
            return False
        tail = 0 if t.reason in ("flush", "max_length") else int(self.cfg.final_tail_ms * SAMPLE_RATE / 1000)
        need = min(t.n, t.last_speech_end + tail)
        return t.candidate_cover >= need

    def _send_final_if_ready(self, t: _Turn) -> None:
        if not t.ended or t.final_sent or not self._final_ready(t):
            return
        t.final_sent = True
        if t in self.closing:
            self.closing.remove(t)
        text, dropped = filter_text(t.candidate)
        event = {
            "type": "final",
            "turn": t.id,
            "text": text,
            "language": t.candidate.language or self.language,
            "audio_ms": self._ms(t.candidate_cover),
            "speech_ms": round(t.speech_ms()),
            "pass_ms": round(t.candidate_ms),
            "wait_ms": round((time.perf_counter() - t.ended_wall) * 1000),
            "reused": t.candidate_reused,
        }
        if dropped:
            event["dropped"] = dropped
        self.emit(event)
        logger.info("live turn %d final: pass %.0f ms, waited %d ms", t.id, t.candidate_ms, event["wait_ms"])
        t.chunks = []  # the audio goes as soon as its words are out

    # --------------------------------------------------------- passes
    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _schedule(self) -> None:
        if self._closed or (self._pass_task is not None and not self._pass_task.done()):
            return
        # Finals first: turns that ended, then the turn being checked.
        waiting = list(self.closing)
        if self.turn is not None and self.turn.checking:
            waiting.append(self.turn)
        for t in waiting:
            if not t.final_sent and not self._final_ready(t):
                self._start_pass(t, final=True, have_slot=False)
                return
        t = self.turn
        if t is None or t.checking:
            return
        step = self.cfg.partial_step_ms * SAMPLE_RATE // 1000
        if t.n - t.last_pass_n < step:
            return
        if self.lane.try_partial():
            self._start_pass(t, final=False, have_slot=True)
        else:
            self.stats["partials_dropped"] += 1
            t.last_pass_n = t.n  # skip this step; try again 400 ms on

    def _start_pass(self, t: _Turn, *, final: bool, have_slot: bool) -> None:
        cover = t.n
        t.last_pass_n = cover
        audio = t.audio().copy()
        self._pass_task = self._spawn(self._run_pass(t, cover, audio, final, have_slot))

    async def _run_pass(self, t: _Turn, cover: int, audio: np.ndarray, final: bool, have_slot: bool) -> None:
        if not have_slot:
            await self.lane.acquire_final()
        loop = asyncio.get_running_loop()
        t0 = time.perf_counter()
        fut = loop.run_in_executor(None, self.transcribe, audio, self.language)
        try:
            result = await asyncio.shield(fut)
        except asyncio.CancelledError:
            # The thread can't be stopped; hold the slot until it really ends.
            fut.add_done_callback(lambda _f: self.lane.release())
            raise
        except Exception:  # noqa: BLE001
            self.lane.release()
            logger.exception("live pass failed")
            self._pass_task = None
            if not self._closed:
                self.emit({"type": "error", "message": "A live speech pass failed."})
            return
        self.lane.release()
        ms = (time.perf_counter() - t0) * 1000
        self.stats["passes"] += 1
        self.stats["pass_ms_total"] += ms
        self._pass_task = None
        if self._closed:
            return
        self._on_pass(t, cover, result, final, ms)
        self._schedule()

    def _on_pass(self, t: _Turn, cover: int, result: PassResult, final: bool, ms: float) -> None:
        if t.final_sent:
            return
        if cover >= t.last_speech_end and (t.candidate is None or cover >= t.candidate_cover):
            # Heard everything said so far: a candidate final, valid until they
            # speak again (_final_ready also wants a little audio past the word).
            t.candidate, t.candidate_cover, t.candidate_ms, t.candidate_reused = result, cover, ms, not final
        if t.ended:
            self._send_final_if_ready(t)
            return
        if self.turn is not t:
            return  # reset meanwhile
        text, dropped = filter_text(result)
        stable, full = t.agreement.update(text if not dropped else "")
        if (stable, full) != t.last_partial and full:
            t.last_partial = (stable, full)
            self.stats["partials"] += 1
            self.emit({"type": "partial", "turn": t.id, "text": full, "stable": stable, "at_ms": self._ms(t.started_at + cover)})
