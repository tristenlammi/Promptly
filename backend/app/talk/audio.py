"""Audio plumbing for Talk (WP-T2): frames on the wire and the playhead.

The backend never decodes or encodes audio. Microphone frames go to Whisper as
they come; speech comes back from Kokoro as 20 ms frames (Opus packets, or raw
PCM16 at 24 kHz), and goes down to the client one frame per message.

Every binary message on ``/api/talk/ws``, either way, starts with a 4-byte
big-endian sequence number:

* client -> server: ``seq`` + one Opus packet, or PCM16 mono at 16 kHz;
* server -> client: ``seq`` + one 20 ms frame of speech (Opus packet, or
  960 bytes of PCM16 mono at 24 kHz).

**The playhead.** Speech is sent at the pace it plays, a little ahead
(``LEAD_MS``) so the client has a cushion. That keeps the client's buffer short
(stopping is instant), and it means the server knows, to within that cushion,
how much the person has actually heard: what a barge-in cuts the saved reply
back to. A client that knows better says so (``interrupt {played_ms}``).
"""
from __future__ import annotations

import struct
import time
from dataclasses import dataclass, field
from typing import Callable

FRAME_MS = 20
TTS_SAMPLE_RATE = 24_000
PCM_FRAME_BYTES = TTS_SAMPLE_RATE * FRAME_MS // 1000 * 2  # 960
STT_SAMPLE_RATE = 16_000
LEAD_MS = 300
SEQ = struct.Struct(">I")


def with_seq(seq: int, payload: bytes) -> bytes:
    return SEQ.pack(seq & 0xFFFFFFFF) + payload


def split_seq(data: bytes) -> tuple[int, bytes] | None:
    if len(data) < SEQ.size:
        return None
    return SEQ.unpack_from(data)[0], data[SEQ.size :]


class OpusDeframer:
    """The tts sidecar's Opus stream (each packet after a 2-byte big-endian
    length) cut back into packets, whatever the HTTP chunking."""

    def __init__(self) -> None:
        self._buf = b""

    def push(self, data: bytes) -> list[bytes]:
        self._buf += data
        out: list[bytes] = []
        while len(self._buf) >= 2:
            (n,) = struct.unpack_from(">H", self._buf)
            if len(self._buf) < 2 + n:
                break
            out.append(self._buf[2 : 2 + n])
            self._buf = self._buf[2 + n :]
        return out

    def flush(self) -> list[bytes]:
        self._buf = b""
        return []


class PcmFramer:
    """Raw PCM16 at 24 kHz cut into 20 ms frames (the last one padded)."""

    def __init__(self) -> None:
        self._buf = b""

    def push(self, data: bytes) -> list[bytes]:
        self._buf += data
        n = len(self._buf) // PCM_FRAME_BYTES * PCM_FRAME_BYTES
        out = [self._buf[i : i + PCM_FRAME_BYTES] for i in range(0, n, PCM_FRAME_BYTES)]
        self._buf = self._buf[n:]
        return out

    def flush(self) -> list[bytes]:
        if not self._buf:
            return []
        frame = self._buf + b"\x00" * (PCM_FRAME_BYTES - len(self._buf))
        self._buf = b""
        return [frame]


@dataclass
class _Run:
    wall: float  # when this stretch started playing
    audio_ms: int  # where in the reply's audio it started


@dataclass
class Playhead:
    """Where playback is, from when frames were sent (see the module doc)."""

    lead_ms: int = LEAD_MS
    clock: Callable[[], float] = time.monotonic
    sent_ms: int = 0
    _next_start: float | None = None
    _runs: list[_Run] = field(default_factory=list)

    def send_at(self) -> float:
        """When the next frame may go."""
        if self._next_start is None:
            return self.clock()
        return self._next_start - self.lead_ms / 1000

    def sent(self, frame_ms: int = FRAME_MS) -> None:
        now = self.clock()
        if self._next_start is None or self._next_start < now:
            # The first frame, or the client ran dry: playback (re)starts now.
            self._next_start = now
            self._runs.append(_Run(now, self.sent_ms))
        self._next_start += frame_ms / 1000
        self.sent_ms += frame_ms

    def heard_ms(self, now: float | None = None) -> int:
        now = self.clock() if now is None else now
        heard = 0
        for i, run in enumerate(self._runs):
            if run.wall > now:
                break
            end = self._runs[i + 1].audio_ms if i + 1 < len(self._runs) else self.sent_ms
            heard = min(end, run.audio_ms + round((now - run.wall) * 1000))
        return max(0, heard)

    def finished_at(self) -> float | None:
        """When everything sent so far will have played."""
        return self._next_start
