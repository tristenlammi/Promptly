"""Streaming speech for Talk (WP-T1): text pieces in, Opus or PCM frames out.

Kokoro's ``create_stream`` only splits at its 510-phoneme batch limit, so a
sentence comes back as one chunk after the whole sentence is made (WP-T0:
~300 ms for a 4-6 word clause, ~1 s for a long sentence, at 4 threads). Audio
starts early only if the first piece is short, so ``split_pieces`` makes the
first piece the first clause, cut to a few words when it runs long, and every
piece fits one Kokoro batch so a cancelled stream never leaves work behind.

``OpusFramer`` packs the audio as raw Opus packets (libopus, 20 ms at 24 kHz),
each prefixed with its length as a 2-byte big-endian number, so the backend can
forward packets one by one without an Ogg demuxer.
"""
from __future__ import annotations

import re
import struct
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 24_000  # Kokoro's output rate
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 480

# Pieces stay well inside one Kokoro batch (510 phonemes ~ 300+ characters).
MAX_PIECE_CHARS = 220
# The first piece: whole if the first clause is this short, else cut down.
FIRST_PIECE_WORDS = 6
# Silence between pieces, so cut-up text keeps its natural pauses
# (Kokoro trims each piece's own silence away).
GAP_AFTER_SENTENCE_MS = 220
GAP_AFTER_CLAUSE_MS = 90

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "st", "mt", "vs", "etc", "eg", "ie", "jr", "sr", "no", "approx", "prof",
}
_SENTENCE_END = re.compile(r"([.!?…]+[\"'”’)\]]*)(\s+)")
_CLAUSE_MARK = re.compile(r"[,;:—–]$|[,;:][\"'”’)\]]*$")
# Words a long first clause is best cut in front of.
_BREAK_BEFORE = {
    "and", "but", "or", "so", "because", "to", "for", "with", "at", "on", "in", "from", "that",
    "which", "who", "when", "while", "if", "then", "after", "before", "about", "of",
}


@dataclass
class Piece:
    text: str
    gap_ms: int  # silence to play after it (none after the last piece)


def _sentences(text: str) -> list[str]:
    out: list[str] = []
    for para in re.split(r"\n\s*\n|\n", text):
        para = " ".join(para.split())
        if not para:
            continue
        start = 0
        for m in _SENTENCE_END.finditer(para):
            before = para[start : m.start(1)].split()
            word = re.sub(r"[^\w]", "", before[-1]).lower() if before else ""
            if m.group(1) == "." and (word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha())):
                continue  # "Dr. Smith", "J. Smith"
            out.append(para[start : m.end(1)].strip())
            start = m.end()
        if para[start:].strip():
            out.append(para[start:].strip())
    return out


def _cap(sentence: str) -> list[str]:
    """Split a sentence that won't fit one batch: at clause marks, then words."""
    if len(sentence) <= MAX_PIECE_CHARS:
        return [sentence]
    parts: list[str] = []
    current: list[str] = []
    for word in sentence.split():
        if current and len(" ".join(current + [word])) > MAX_PIECE_CHARS:
            # Back up to the last clause mark in this piece, if there is one.
            cut = max((i for i, w in enumerate(current) if _CLAUSE_MARK.search(w)), default=-1)
            if cut >= 0 and cut < len(current) - 1:
                parts.append(" ".join(current[: cut + 1]))
                current = current[cut + 1 :]
            else:
                parts.append(" ".join(current))
                current = []
        current.append(word)
    if current:
        parts.append(" ".join(current))
    return parts


def _first_cut(words: list[str]) -> int:
    """How many words of a long first sentence to speak first."""
    for i, w in enumerate(words[:10]):
        if i >= 1 and _CLAUSE_MARK.search(w) and len(words) - (i + 1) >= 2:
            return i + 1  # the first clause mark after two words or more
    if len(words) <= FIRST_PIECE_WORDS + 2:
        return len(words)  # too short to be worth cutting
    for n in range(FIRST_PIECE_WORDS, 3, -1):  # 6, 5, 4: before a joining word
        if re.sub(r"[^\w]", "", words[n]).lower() in _BREAK_BEFORE:
            return n
    return FIRST_PIECE_WORDS


def _gap(piece: str) -> int:
    if re.search(r"[.!?…][\"'”’)\]]*$", piece):
        return GAP_AFTER_SENTENCE_MS
    if _CLAUSE_MARK.search(piece):
        return GAP_AFTER_CLAUSE_MS
    return 0


def split_pieces(text: str, *, first_clause: bool = True) -> list[Piece]:
    """Text to speak, in the order to make it: short first piece, then sentences."""
    texts: list[str] = []
    for i, sentence in enumerate(_sentences(text)):
        if i == 0 and first_clause:
            words = sentence.split()
            if len(words) > FIRST_PIECE_WORDS:
                n = _first_cut(words)
                head, tail = " ".join(words[:n]), " ".join(words[n:])
                texts.append(head)
                if tail:
                    texts.extend(_cap(tail))
                continue
        texts.extend(_cap(sentence))
    pieces = [Piece(t, _gap(t)) for t in texts if re.search(r"\w", t)]
    if pieces:
        pieces[-1].gap_ms = 0
    return pieces


# ------------------------------------------------------------------ encoding


def pcm16(samples: np.ndarray) -> bytes:
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (pcm * 32767.0).astype("<i2").tobytes()


def silence(ms: int) -> np.ndarray:
    return np.zeros(SAMPLE_RATE * ms // 1000, dtype=np.float32)


class OpusFramer:
    """Float samples in, length-prefixed 20 ms Opus packets out.

    Audio that doesn't fill a frame waits for the next push; ``flush`` pads the
    last frame with silence. One encoder per stream, so the codec state flows
    across pieces without clicks.
    """

    def __init__(self, bitrate: int = 32_000) -> None:
        import opuslib

        self._enc = opuslib.Encoder(SAMPLE_RATE, 1, opuslib.APPLICATION_AUDIO)
        self._enc.bitrate = bitrate
        self._rest = np.zeros(0, dtype=np.float32)
        self.packets = 0

    def push(self, samples: np.ndarray) -> bytes:
        buf = np.concatenate([self._rest, np.asarray(samples, dtype=np.float32)])
        whole = len(buf) // FRAME_SAMPLES * FRAME_SAMPLES
        out = bytearray()
        for i in range(0, whole, FRAME_SAMPLES):
            packet = self._enc.encode(pcm16(buf[i : i + FRAME_SAMPLES]), FRAME_SAMPLES)
            out += struct.pack(">H", len(packet)) + packet
            self.packets += 1
        self._rest = buf[whole:]
        return bytes(out)

    def flush(self) -> bytes:
        if not len(self._rest):
            return b""
        pad = np.zeros(FRAME_SAMPLES - len(self._rest), dtype=np.float32)
        return self.push(pad)


def read_framed(data: bytes) -> list[bytes]:
    """Split a length-prefixed Opus stream back into packets (tests, clients)."""
    packets, i = [], 0
    while i + 2 <= len(data):
        (n,) = struct.unpack(">H", data[i : i + 2])
        packets.append(data[i + 2 : i + 2 + n])
        i += 2 + n
    return packets
