"""One spoken conversation (WP-T2): the state machine behind ``/api/talk/ws``.

Frames in, frames and events out, over any :class:`~.protocol.Transport`.
Everything that changes the conversation's state happens in one actor task
(``_run``) fed by an inbox, so the microphone, Whisper, the reply and the
speech never race each other. The pieces around it:

* **Listening**: the microphone goes straight to Whisper's ``/live`` lane
  (:class:`~.links.LiveStt`), which says when speech starts, sends partial
  words, decides the turn is over (Smart Turn) and sends the final words.
* **Thinking**: the final words are saved as your message and the chat
  generator starts on them at once (``reply.py``, the speculative start). If
  you carry on talking before any of the answer has played, the answer is
  thrown away unheard and the two parts become one turn (whisper may split
  "...on Thursday [pause] morning" in two; T1 leaves the joining to here).
* **Speaking**: the reply is cut into pieces as it streams (``speech.py``),
  each made into speech by Kokoro, and sent at playing pace
  (:class:`~.audio.Playhead`), so the server knows how much you've heard.
* **Barge-in**: talking over it stops it, once Whisper has heard two real
  words that aren't its own voice coming back (``words.py``, the self-echo
  filter) or a backchannel like "mm", or a stop word on its own. The audio
  stops, the reply is cancelled, and the saved message is cut back to what
  you heard, marked ``voice.interrupted``.

The session lives in process memory (single worker, like the chat streams)
and for ``RESUME_S`` after the socket drops, so a reconnect picks it up.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.auth.models import User

from . import links, reply as chat
from .access import VoicePrefs, record_turn
from .audio import FRAME_MS, TTS_SAMPLE_RATE, Playhead, split_seq, with_seq
from .protocol import CLOSE_UNAVAILABLE, PROTOCOL_VERSION, Hello, Transport
from .speech import Piece, SpeechSplitter, heard_raw
from .words import asks_to_stop, barges_in, is_goodbye, just_stop_or_thanks, real_words, without_wake_word

logger = logging.getLogger("promptly.talk")

RESUME_S = 30.0
IDLE_S = 120.0
# Speech this soon after Promptly stopped talking may still be its own echo.
ECHO_TAIL_S = 1.5
# How much of what it said the echo filter compares against.
ECHO_WINDOW_WORDS = 40
INTERRUPTED_NOTHING = "…"
MODEL_FAILED = "Sorry, I couldn't get an answer just now."
# How far ahead of what's been heard speech is made. Kokoro makes a long
# sentence in ~1 s on a busy box (WP-T0), so 3 s keeps playback fed without
# spending CPU on sentences a barge-in throws away.
SPEECH_AHEAD_MS = 3000

_END = object()


@dataclass
class Heard:
    """One stretch of speech Whisper is hearing (its ``turn`` number)."""

    tid: int
    started: float
    over_speech: bool = False  # began while Promptly was talking
    barged: bool = False  # ...and stopped it
    real: bool = False  # a partial had words of the person's own
    speech_end: float | None = None
    endpoint_ms: int | None = None


@dataclass
class UserTurn:
    text: str
    message_id: uuid.UUID | None = None
    voice: dict[str, Any] | None = None
    speech_end: float = 0.0  # when they stopped talking (monotonic)
    endpoint_ms: int | None = None
    stt_ms: int | None = None
    typed: bool = False
    pending: bool = False  # saved, its answer held back while they say more


@dataclass
class Reply:
    turn: UserTurn
    stream: Any  # chat.stream_runner.StreamSession
    started: float
    splitter: SpeechSplitter = field(default_factory=SpeechSplitter)
    pieces: list[Piece] = field(default_factory=list)
    ranges: dict[int, list[int]] = field(default_factory=dict)  # piece -> [start_ms, end_ms]
    piece_q: asyncio.Queue = field(default_factory=asyncio.Queue)
    frames: asyncio.Queue = field(default_factory=asyncio.Queue)
    playhead: Playhead = field(default_factory=Playhead)
    release: asyncio.Event = field(default_factory=asyncio.Event)  # set = may play
    tasks: list[asyncio.Task] = field(default_factory=list)
    first_delta: float | None = None
    first_audio: float | None = None
    generated: bool = False
    message_id: uuid.UUID | None = None
    all_sent: bool = False
    played: bool = False
    cancelled: bool = False
    tts_failed: bool = False
    failed_say: str | None = None  # the model failed: say this instead
    barge_ins: int = 0
    pieces_started: int = 0

    def __post_init__(self) -> None:
        self.release.set()

    @property
    def unheard(self) -> bool:
        return self.first_audio is None

    def caption(self) -> str:
        said = " ".join(p.text for p in self.pieces)
        rest = chat_speech(self.splitter.raw[self.splitter.spoken_upto :])
        return f"{said} {rest}".strip() if said else rest

    def spoken_chars(self) -> int:
        return len(" ".join(p.text for p in self.pieces[: self.pieces_started]))

    def echo_window(self) -> str:
        """What it has said lately and is saying now: what its echo sounds like."""
        heard = self.playhead.heard_ms()
        texts = [
            p.text
            for p in self.pieces
            if p.index in self.ranges and self.ranges[p.index][0] <= heard + 1500
        ]
        words = " ".join(texts).split()
        return " ".join(words[-ECHO_WINDOW_WORDS:])

    def heard_offset(self, heard_ms: int) -> int:
        """How far into the raw reply someone hearing ``heard_ms`` got."""
        upto = 0
        for p in self.pieces:
            span = self.ranges.get(p.index)
            if span is None or span[0] >= heard_ms:
                break
            start, end = span
            if heard_ms >= end:
                upto = p.raw_end
                continue
            upto = heard_raw(self.splitter.raw, p, (heard_ms - start) / max(1, end - start))
            break
        return upto


def chat_speech(raw: str) -> str:
    from .speech import to_speech

    return to_speech(raw)


# Live sessions by id: for resume, and the server's live-slot count.
_SESSIONS: dict[uuid.UUID, "TalkSession"] = {}


def live_count() -> int:
    return sum(1 for s in _SESSIONS.values() if not s.ended)


def find(session_id: uuid.UUID) -> "TalkSession | None":
    s = _SESSIONS.get(session_id)
    return s if s is not None and not s.ended else None


class TalkSession:
    def __init__(
        self,
        *,
        user: User,
        hello: Hello,
        conv: chat.ConvInfo,
        prefs: VoicePrefs,
        connection: Any,
    ) -> None:
        self.id = uuid.uuid4()
        self.user = user
        self.hello = hello
        self.conv = conv
        self.prefs = prefs
        self.connection = connection  # stands in for the request in audit rows
        self.turn_mode = hello.turn_mode or prefs.turn_mode
        self.interrupt_mode = hello.interrupt_mode or prefs.interrupt
        self.play_format = hello.play_format
        self.transport: Transport | None = None
        self.state = "listening"
        self.muted = False
        self.ended = False
        self.end_reason: str | None = None
        self.stt: links.LiveStt | None = None
        self.tts_http = links.tts_client()
        self.inbox: asyncio.Queue = asyncio.Queue()
        self.heard: dict[int, Heard] = {}
        self.turn: UserTurn | None = None  # the latest turn
        self.reply: Reply | None = None
        self.last_reply: Reply | None = None
        self.last_played: float = 0.0
        self.last_activity = time.monotonic()
        self._out_seq = 0
        self._in_seq: int | None = None
        self.frames_in = 0
        self._actor: asyncio.Task | None = None
        self._attached = asyncio.Event()
        self._resume_timer: asyncio.Task | None = None
        self._side: set[asyncio.Task] = set()

    # ------------------------------------------------------------ lifecycle
    async def start(self, transport: Transport) -> None:
        """Open the live link to Whisper and say we're ready. Raises
        :class:`links.SpeechUnavailable` when there's no live speech."""
        self.stt = links.LiveStt(codec=self.hello.codec, language=_lang(self.hello.lang), on_event=self._stt_event)
        await self.stt.open()
        _SESSIONS[self.id] = self
        self._actor = asyncio.create_task(self._run(), name=f"talk-{self.id}")
        await self.attach(transport, resumed=False)
        logger.info("talk: session open (device=%s codec=%s play=%s)", self.hello.device, self.hello.codec, self.play_format)

    async def attach(self, transport: Transport, *, resumed: bool) -> None:
        if self._resume_timer is not None:
            self._resume_timer.cancel()
            self._resume_timer = None
        self.transport = transport
        self._attached.set()
        await self.send(
            {
                "type": "ready",
                "protocol": PROTOCOL_VERSION,
                "session_id": str(self.id),
                "conversation_id": None if self.conv.ephemeral else str(self.conv.id),
                "title": None if self.conv.ephemeral else self.conv.title,
                "resumed": resumed,
                "turn_mode": self.turn_mode,
                "interrupt_mode": self.interrupt_mode,
                "audio": {"format": self.play_format, "sample_rate": TTS_SAMPLE_RATE, "frame_ms": FRAME_MS},
                "limits": {"resume_s": int(RESUME_S), "idle_s": int(IDLE_S)},
            }
        )
        await self._send_state()
        if resumed and self.reply is not None and not self.reply.cancelled:
            await self.send({"type": "reply", "text": self.reply.caption()})

    def detach(self, transport: Transport) -> None:
        """The socket went away. The conversation waits ``RESUME_S`` for it."""
        if self.transport is not transport or self.ended:
            return
        self.transport = None
        self._attached.clear()
        self.post("detached")
        self._resume_timer = asyncio.create_task(self._resume_deadline())

    async def _resume_deadline(self) -> None:
        try:
            await asyncio.sleep(RESUME_S)
        except asyncio.CancelledError:
            return
        self.post("end", reason="dropped")

    def post(self, kind: str, **data: Any) -> None:
        if not self.ended:
            self.inbox.put_nowait((kind, data))

    async def send(self, event: dict[str, Any]) -> None:
        t = self.transport
        if t is not None:
            await t.send_json(event)

    async def wait_closed(self) -> None:
        if self._actor is not None:
            try:
                await self._actor
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    # ------------------------------------------------------------ inputs
    async def client_audio(self, data: bytes) -> None:
        """A microphone frame: straight to Whisper (not via the inbox)."""
        parsed = split_seq(data)
        if parsed is None or self.ended:
            return
        seq, payload = parsed
        if self._in_seq is not None and seq != (self._in_seq + 1) & 0xFFFFFFFF:
            logger.debug("talk: %d microphone frame(s) missing", (seq - self._in_seq - 1) & 0xFFFFFFFF)
        self._in_seq = seq
        if self.muted or self.stt is None:
            return
        self.frames_in += 1
        await self.stt.audio(payload)

    def client_message(self, message: dict[str, Any]) -> None:
        self.post("client", message=message)

    def _stt_event(self, event: dict[str, Any]) -> None:
        self.post("stt", event=event)

    # ------------------------------------------------------------ actor
    async def _run(self) -> None:
        try:
            while not self.ended:
                try:
                    kind, data = await asyncio.wait_for(self.inbox.get(), timeout=5.0)
                except asyncio.TimeoutError:
                    await self._check_idle()
                    continue
                try:
                    await self._handle(kind, data)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - one bad event mustn't end the conversation
                    logger.exception("talk: %s event failed", kind)
                    await self._error("failed", "Sorry, something went wrong there.")
        finally:
            if not self.ended:
                await self._close("error")

    async def _handle(self, kind: str, data: dict[str, Any]) -> None:
        if kind == "stt":
            await self._on_stt(data["event"])
        elif kind == "client":
            await self._on_client(data["message"])
        elif kind == "reply_event":
            await self._on_reply_event(data["reply"], data["event"])
        elif kind == "first_audio":
            r = data["reply"]
            if r is self.reply and not r.cancelled:
                await self._set_state("speaking")
        elif kind == "piece_started":
            r = data["reply"]
            if r is self.reply and not r.cancelled:
                r.pieces_started = max(r.pieces_started, data["index"] + 1)
                await self.send({"type": "spoken", "chars": r.spoken_chars()})
        elif kind == "all_sent":
            await self._on_all_sent(data["reply"])
        elif kind == "played":
            await self._on_played(data["reply"])
        elif kind == "tts_failed":
            r = data["reply"]
            if r is self.reply and not r.tts_failed:
                r.tts_failed = True
                await self._error("speech_unavailable", None, show=links.UNAVAILABLE)
        elif kind == "detached":
            if self.stt is not None:
                await self.stt.command("reset")
            await self._forget_heard()
        elif kind == "end":
            await self._close(data.get("reason") or "bye")

    async def _check_idle(self) -> None:
        busy = self.reply is not None or self.heard or self.state != "listening"
        if busy or self.transport is None:
            self.last_activity = time.monotonic()
            return
        if time.monotonic() - self.last_activity >= IDLE_S:
            await self._close("idle")

    # ------------------------------------------------------------ client
    async def _on_client(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "mute":
            if not self.muted:
                self.muted = True
                if self.stt is not None:
                    await self.stt.command("reset")
                await self._forget_heard()
                await self._send_state()
        elif kind == "unmute":
            if self.muted:
                self.muted = False
                self.last_activity = time.monotonic()
                await self._send_state()
        elif kind == "interrupt":
            played = msg.get("played_ms")
            played = int(played) if isinstance(played, (int, float)) and not isinstance(played, bool) and played >= 0 else None
            if self.reply is not None and not self.reply.cancelled:
                await self._barge_in(self.reply, played_ms=played)
        elif kind == "end_turn":
            if self.stt is not None:
                await self.stt.command("flush")
        elif kind == "text":
            words = " ".join(str(msg.get("words") or "").split())[:4000]
            if words:
                self.last_activity = time.monotonic()
                await self._typed(words)
        elif kind == "confirm":
            # Nothing waits for a yes yet: spoken approvals arrive with WP-T3.
            await self._error("nothing_to_confirm", None, show="There's nothing waiting for a yes or no.")
        elif kind == "bye":
            await self._close("bye")
        elif kind == "hello":
            pass  # a resumed client may say hello again; the session already knows it

    async def _typed(self, words: str) -> None:
        now = time.monotonic()
        typed = UserTurn(text=words, speech_end=now, typed=True)
        r = self.reply
        if r is not None and not r.cancelled:
            if r.unheard and not r.turn.typed and r.turn.message_id is not None:
                await self._join(r.turn, typed)  # more of the same turn
                return
            await self._barge_in(r)
        if is_goodbye(words):
            await self._goodbye()
            return
        await self._new_turn(typed)

    # ------------------------------------------------------------ speech
    async def _on_stt(self, ev: dict[str, Any]) -> None:
        kind = ev.get("type")
        if kind == "link_lost":
            await self._stt_lost()
            return
        if kind == "error":
            logger.info("talk: whisper reported an error (%s)", ev.get("code"))
            return
        tid = ev.get("turn")
        if not isinstance(tid, int) or self.muted:
            return
        now = time.monotonic()
        if kind == "speech_start":
            self.last_activity = now
            h = Heard(tid=tid, started=now)
            r = self.reply
            if r is not None and not r.cancelled:
                if r.unheard:
                    r.release.clear()  # hold the answer: they may be carrying on
                elif not r.played:
                    h.over_speech = True
            elif self.last_reply is not None and now - self.last_played < ECHO_TAIL_S:
                h.over_speech = True  # its own voice may still be in the room
            self.heard[tid] = h
        elif kind == "partial":
            await self._on_partial(tid, str(ev.get("text") or ""))
        elif kind == "turn_end":
            h = self.heard.get(tid) or self.heard.setdefault(tid, Heard(tid=tid, started=now))
            at, end = ev.get("at_ms"), ev.get("speech_end_ms")
            h.endpoint_ms = int(at - end) if isinstance(at, (int, float)) and isinstance(end, (int, float)) else None
            h.speech_end = now - (h.endpoint_ms or 0) / 1000
            if not h.over_speech and self.reply is None and self.state == "listening":
                await self._set_state("thinking")
        elif kind == "final":
            h = self.heard.pop(tid, None) or Heard(tid=tid, started=now)
            if h.speech_end is None:
                h.speech_end = now
            text = without_wake_word(str(ev.get("text") or ""))
            if ev.get("dropped") or not text:
                await self._nothing_heard()
            else:
                await self._on_final(h, text, now)
        elif kind == "dropped":
            self.heard.pop(tid, None)
            await self._nothing_heard()

    async def _on_partial(self, tid: int, text: str) -> None:
        h = self.heard.get(tid)
        if h is None or not text:
            return
        r = self.reply
        if h.over_speech:
            source = r if (r is not None and not r.cancelled) else self.last_reply
            spoken = source.echo_window() if source is not None else ""
            own = real_words(text, spoken)
            if not own and not asks_to_stop(text, spoken):
                return  # its own voice, or "mm": not shown, not acted on
            h.real = True
            if (
                not h.barged
                and r is not None
                and not r.cancelled
                and not r.played
                and self.interrupt_mode == "talk"
                and barges_in(text, spoken)
            ):
                h.barged = True
                await self._barge_in(r)
            await self.send({"type": "partial", "text": text})
            return
        if real_words(text):
            h.real = True
            if r is not None and not r.cancelled and r.unheard:
                # They carried on before hearing anything: that answer is void.
                await self._abandon(r)
        await self.send({"type": "partial", "text": text})

    async def _nothing_heard(self) -> None:
        """A turn that came to nothing (a cough, silence, noise, or speech
        forgotten on mute or a dropped connection): what was waiting on it
        goes ahead."""
        if any(h.real for h in self.heard.values()):
            return
        r = self.reply
        if r is not None and not r.cancelled:
            if not self.heard:
                r.release.set()
        elif self.turn is not None and self.turn.message_id is not None and self.turn.pending:
            # An answer was held back for speech that turned out to be nothing.
            await self._answer(self.turn)
        elif self.state == "thinking":
            await self._set_state("listening")

    async def _forget_heard(self) -> None:
        self.heard.clear()
        await self._nothing_heard()

    async def _on_final(self, h: Heard, text: str, now: float) -> None:
        self.last_activity = now
        r = self.reply
        if h.over_speech:
            if not h.barged:
                source = r if (r is not None and not r.cancelled) else self.last_reply
                spoken = source.echo_window() if source is not None else ""
                playing = r is not None and not r.cancelled and not r.played
                if playing and self.interrupt_mode == "tap":
                    return  # Tap to interrupt: speech while it talks is ignored
                if not real_words(text, spoken) and not asks_to_stop(text, spoken):
                    return  # its own echo, or a backchannel
                if playing:
                    h.barged = True
                    await self._barge_in(r)
            if is_goodbye(text):
                await self._goodbye()
                return
            if just_stop_or_thanks(text):
                await self._set_state("listening")
                return  # "stop", "okay, got it": it stopped, nothing to answer
        turn = UserTurn(
            text=text,
            speech_end=h.speech_end or now,
            endpoint_ms=h.endpoint_ms,
            stt_ms=int((now - (h.speech_end or now)) * 1000),
        )
        prev = self.turn
        if (
            not h.over_speech
            and prev is not None
            and not prev.typed
            and prev.message_id is not None
            and (self.reply is None or (self.reply.turn is prev and self.reply.unheard))
            and (self.reply is not None or prev.pending)
        ):
            await self._join(prev, turn)
            return
        if is_goodbye(text):
            await self._goodbye()
            return
        await self._new_turn(turn)

    # ------------------------------------------------------------ turns
    def _spoken_meta(self, turn: UserTurn) -> dict[str, Any] | None:
        if turn.typed:
            return None
        return {"spoken": True, "stt_ms": turn.stt_ms}

    async def _new_turn(self, turn: UserTurn) -> None:
        try:
            await chat.check_quotas(self.connection, self.user)
            turn.voice = self._spoken_meta(turn)
            turn.message_id = await chat.add_user_turn(self.conv, self.user, turn.text, turn.voice)
        except chat.TurnRefused as e:
            await self._error("refused", e.say)
            await self._set_state("listening")
            return
        self.turn = turn
        await self.send({"type": "heard", "text": turn.text, "message_id": None if self.conv.ephemeral else str(turn.message_id)})
        await self._answer(turn)

    async def _join(self, prev: UserTurn, more: UserTurn) -> None:
        """They paused and carried on: one turn, one answer."""
        if self.reply is not None and not self.reply.cancelled:
            await self._abandon(self.reply)
        prev.text = f"{prev.text} {more.text}".strip()
        prev.speech_end = more.speech_end
        prev.endpoint_ms = more.endpoint_ms
        prev.stt_ms = more.stt_ms
        prev.voice = {"spoken": True, "stt_ms": more.stt_ms, "joined": True}
        await chat.extend_user_turn(self.conv, self.user, prev.message_id, prev.text, prev.voice)
        await self.send({"type": "heard", "text": prev.text, "message_id": None if self.conv.ephemeral else str(prev.message_id)})
        await self._answer(prev)

    async def _answer(self, turn: UserTurn) -> None:
        """Start the reply (speculatively: they may yet carry on)."""
        if any(h.real and not h.over_speech for h in self.heard.values()):
            # They're already saying more: wait for it, then answer it all.
            turn.pending = True
            return
        turn.pending = False
        try:
            stream = await chat.start_reply(self.conv, self.user, turn.message_id, self.connection)
        except chat.TurnRefused as e:
            await self._error("refused", e.say)
            await self._set_state("listening")
            return
        r = Reply(turn=turn, stream=stream, started=time.monotonic())
        if self.heard:
            r.release.clear()  # speech under way: hold the answer until we know
        self.reply = r
        r.tasks = [
            asyncio.create_task(self._follow(r), name="talk-follow"),
            asyncio.create_task(self._make_speech(r), name="talk-tts"),
            asyncio.create_task(self._play(r), name="talk-play"),
        ]
        await self._set_state("thinking")

    async def _abandon(self, r: Reply) -> None:
        """Throw an answer away unheard (speculative start, cancelled)."""
        r.cancelled = True
        await self._stop_tasks(r)
        if self.reply is r:
            self.reply = None
        r.turn.pending = True
        await chat.discard(r.stream, self.conv, r.turn.message_id)
        logger.info("talk: speculative answer dropped, they carried on")

    async def _barge_in(self, r: Reply, *, played_ms: int | None = None) -> None:
        """They talked over it (or pressed Stop): stop now, keep what was heard."""
        if r.cancelled:
            return
        r.cancelled = True
        heard_ms = played_ms if played_ms is not None else r.playhead.heard_ms()
        heard_ms = min(heard_ms, r.playhead.sent_ms)
        await self._stop_tasks(r)
        await self.send({"type": "stop_audio"})
        if self.reply is r:
            self.reply = None
        r.barge_ins += 1
        await self._set_state("listening")
        cut = r.heard_offset(heard_ms)
        content = r.splitter.raw[:cut].rstrip() or INTERRUPTED_NOTHING
        message_id = r.message_id
        if not r.generated:
            message_id = await chat.stop(r.stream) or await chat.latest_reply_for(self.conv, r.turn.message_id)
        if message_id is not None:
            await chat.mark_reply(
                message_id,
                content=content,
                voice={"spoken": True, "interrupted": True, "heard_chars": 0 if content == INTERRUPTED_NOTHING else len(content)},
            )
        logger.info("talk: interrupted after %d ms of the answer", heard_ms)
        self.last_reply = r
        self.last_played = time.monotonic()
        await self._finish(r)

    async def _stop_tasks(self, r: Reply) -> None:
        current = asyncio.current_task()
        tasks = [t for t in r.tasks if t is not current and not t.done()]
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _goodbye(self) -> None:
        """ "That's all", "bye": the conversation ends (the client plays its
        closing tone); nothing goes to the model."""
        await self._close("goodbye")

    # ------------------------------------------------------------ the reply
    async def _follow(self, r: Reply) -> None:
        """The chat generator's events, into the inbox."""
        try:
            async for _i, chunk in r.stream.subscribe(from_index=0):
                event = chat.parse_event(chunk)
                if event is not None:
                    self.post("reply_event", reply=r, event=event)
        except asyncio.CancelledError:
            raise

    async def _on_reply_event(self, r: Reply, ev: dict[str, Any]) -> None:
        if r is not self.reply or r.cancelled or r.generated:
            return
        if "delta" in ev:
            text = str(ev.get("delta") or "")
            if not text:
                return
            if r.first_delta is None:
                r.first_delta = time.monotonic()
            for piece in r.splitter.feed(text):
                r.pieces.append(piece)
                r.piece_q.put_nowait(piece)
            await self.send({"type": "reply", "text": r.caption()})
        elif ev.get("event") == "tool_started":
            label = ev.get("label") or ev.get("name")
            if isinstance(label, str):
                await self.send({"type": "tool", "label": label[:120]})
        elif "error" in ev and not ev.get("done"):
            r.failed_say = MODEL_FAILED
            await self._error("model", MODEL_FAILED, show=str(ev.get("error"))[:300])
        if ev.get("done"):
            r.generated = True
            mid = ev.get("message_id")
            try:
                r.message_id = uuid.UUID(str(mid)) if mid else await chat.latest_reply_for(self.conv, r.turn.message_id)
            except ValueError:
                r.message_id = None
            for piece in r.splitter.finish():
                r.pieces.append(piece)
                r.piece_q.put_nowait(piece)
            if r.failed_say and not r.pieces:
                # Nothing came back to say: say why, out loud (not saved).
                end = len(r.splitter.raw)
                piece = Piece(text=r.failed_say, raw_start=end, raw_end=end, gap_ms=0, index=0)
                r.pieces.append(piece)
                r.piece_q.put_nowait(piece)
            r.piece_q.put_nowait(None)
            if r.message_id is not None:
                await chat.mark_reply(r.message_id, voice={"spoken": True, "interrupted": False})
            await self.send(
                {
                    "type": "reply",
                    "text": r.caption(),
                    "message_id": None if self.conv.ephemeral or r.message_id is None else str(r.message_id),
                    "done": True,
                }
            )

    async def _make_speech(self, r: Reply) -> None:
        """Kokoro, piece by piece, into the frame queue."""
        produced = 0
        try:
            while True:
                piece = await r.piece_q.get()
                if piece is None:
                    break
                if r.tts_failed:
                    continue
                # Kokoro shares the CPU: don't make speech nobody may hear.
                while produced - r.playhead.heard_ms() > SPEECH_AHEAD_MS:
                    await asyncio.sleep(0.05)
                start = produced
                try:
                    async for frame in links.speak(
                        self.tts_http,
                        piece.text,
                        voice=self.prefs.voice,
                        speed=self.prefs.speed,
                        fmt=self.play_format,
                        tail_ms=piece.gap_ms,
                    ):
                        if produced == start:
                            r.ranges[piece.index] = [start, start]
                        produced += FRAME_MS
                        r.ranges[piece.index][1] = produced
                        r.frames.put_nowait((frame, piece.index))
                except links.SpeechUnavailable:
                    self.post("tts_failed", reply=r)
                    r.tts_failed = True
        finally:
            r.frames.put_nowait(_END)

    async def _play(self, r: Reply) -> None:
        """Frames to the client at playing pace (see ``audio.Playhead``)."""
        last_piece = -1
        while True:
            item = await r.frames.get()
            if item is _END:
                self.post("all_sent", reply=r)
                return
            frame, index = item
            await r.release.wait()
            await self._attached.wait()
            delay = r.playhead.send_at() - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            if r.cancelled:
                return
            t = self.transport
            if t is None:
                await self._attached.wait()
                t = self.transport
            await t.send_bytes(with_seq(self._out_seq, frame))
            self._out_seq += 1
            r.playhead.sent(FRAME_MS)
            if r.first_audio is None:
                r.first_audio = time.monotonic()
                self.post("first_audio", reply=r)
            if index != last_piece:
                last_piece = index
                self.post("piece_started", reply=r, index=index)

    async def _on_all_sent(self, r: Reply) -> None:
        if r.cancelled or r.all_sent:
            return
        r.all_sent = True
        done_at = r.playhead.finished_at()
        wait = 0.0 if done_at is None else max(0.0, done_at - time.monotonic())

        async def _later() -> None:
            await asyncio.sleep(wait)
            self.post("played", reply=r)

        task = asyncio.create_task(_later())
        self._side.add(task)
        task.add_done_callback(self._side.discard)

    async def _on_played(self, r: Reply) -> None:
        if r.cancelled or r.played:
            return
        r.played = True
        self.last_reply = r
        self.last_played = time.monotonic()
        if self.reply is r:
            self.reply = None
            await self._set_state("listening")
        await self._finish(r)

    async def _finish(self, r: Reply) -> None:
        """One answered turn: its timings (no words) into ``talk_metrics``."""
        t = r.turn
        await record_turn(
            user_id=self.user.id,
            conversation_id=None if self.conv.ephemeral else self.conv.id,
            session_id=self.id,
            device=self.hello.device,
            endpoint_ms=t.endpoint_ms,
            stt_ms=t.stt_ms,
            ttft_ms=None if r.first_delta is None else int((r.first_delta - r.started) * 1000),
            first_audio_ms=None if r.first_audio is None else int((r.first_audio - t.speech_end) * 1000),
            barge_ins=r.barge_ins,
        )

    # ------------------------------------------------------------ helpers
    async def _set_state(self, state: str) -> None:
        if state == self.state:
            return
        self.state = state
        await self._send_state()

    async def _send_state(self) -> None:
        shown = "muted" if self.muted and self.state == "listening" else self.state
        await self.send({"type": "state", "state": shown, "muted": self.muted})

    async def _error(self, code: str, say: str | None, *, show: str | None = None) -> None:
        await self.send({"type": "error", "code": code, "say": say, "show": show or say})

    async def _stt_lost(self) -> None:
        if self.ended:
            return
        logger.info("talk: whisper link lost, reconnecting once")
        old = self.stt
        self.stt = None
        if old is not None:
            await old.close()
        fresh = links.LiveStt(codec=self.hello.codec, language=_lang(self.hello.lang), on_event=self._stt_event)
        try:
            await fresh.open()
        except links.SpeechUnavailable as e:
            await self._error("speech_unavailable", e.say)
            await self._close("speech_unavailable", code=CLOSE_UNAVAILABLE)
            return
        self.stt = fresh
        await self._forget_heard()

    async def _close(self, reason: str, *, code: int = 1000) -> None:
        if self.ended:
            return
        self.ended = True
        self.end_reason = reason
        if self._resume_timer is not None:
            self._resume_timer.cancel()
        r = self.reply
        if r is not None and not r.cancelled:
            if r.unheard:
                if self.conv.ephemeral:
                    await self._abandon(r)
                else:
                    # Never heard, but asked: the chat keeps the answer.
                    r.cancelled = True
                    await self._stop_tasks(r)
            else:
                await self._barge_in(r)
        for task in list(self._side):
            task.cancel()
        if self.stt is not None:
            await self.stt.close()
        await self.tts_http.aclose()
        _SESSIONS.pop(self.id, None)
        if self.conv.ephemeral:
            # Gone before the client hears goodbye.
            try:
                await chat.forget_conversation(self.conv)
            except Exception:  # noqa: BLE001 - the sweeper gets it within the hour
                logger.exception("talk: couldn't remove a phone conversation")
        await self.send({"type": "bye", "reason": reason})
        if self.transport is not None:
            await self.transport.close(code)
        logger.info("talk: session closed (%s) after %d frames in", reason, self.frames_in)


def _lang(value: str | None) -> str | None:
    lang = (value or "").strip().lower()
    if not lang or lang == "auto":
        return None
    return lang.split("-", 1)[0][:8]
