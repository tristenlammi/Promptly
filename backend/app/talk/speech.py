"""A reply, as it streams in, cut into pieces to speak (WP-T2).

Kokoro only starts sounding once a whole piece is made (WP-T0: ~300 ms for a
4-6 word clause, ~1 s for a long sentence), so audio starts early only if the
first piece is short: the first clause, cut down to a few words when it runs
long, then whole sentences. The same rules as the tts sidecar's
``split_pieces`` (``tts/streaming.py``), done here on text that is still
arriving, because the backend can't wait for the whole reply.

Each piece remembers where it came from in the raw reply (``raw_start`` /
``raw_end``), so when someone talks over the reply the saved message can be
cut back to exactly what they heard.

``to_speech`` is the Python port of the web's ``stripInlineCitations`` +
``markdownToSpeech`` (``frontend/src/utils/speechText.ts``): no spoken
backticks, asterisks, citation markers, link syntax or table pipes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Pieces stay well inside one Kokoro batch (510 phonemes ~ 300+ characters).
MAX_PIECE_CHARS = 220
FIRST_PIECE_WORDS = 6
# A long first sentence with no clause mark is cut once this many words are in.
FIRST_CUT_AFTER_WORDS = FIRST_PIECE_WORDS + 2
GAP_AFTER_SENTENCE_MS = 220
GAP_AFTER_CLAUSE_MS = 90

_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "st", "mt", "vs", "etc", "eg", "ie", "jr", "sr", "no", "approx", "prof",
}
# A sentence end needs the space after it: "3." might be "3.5" still arriving.
_SENTENCE_END = re.compile(r"([.!?…]+[\"'”’)\]]*)(\s+)|\n+")
_CLAUSE_END = re.compile(r"([,;:—–][\"'”’)\]]*)(\s+)")
_CLAUSE_MARK = re.compile(r"[,;:—–][\"'”’)\]]*$")
_BREAK_BEFORE = {
    "and", "but", "or", "so", "because", "to", "for", "with", "at", "on", "in", "from", "that",
    "which", "who", "when", "while", "if", "then", "after", "before", "about", "of",
}


def strip_inline_citations(markdown: str) -> str:
    if not markdown:
        return markdown
    text = re.sub(r"(?:\s*\[\d{1,2}\])+", "", markdown)
    return re.sub(r"\s+([.,;:!?])", r"\1", text)


def markdown_to_speech(markdown: str) -> str:
    if not markdown:
        return ""
    text = re.sub(r"```[\s\S]*?```", " (code block) ", markdown)
    text = re.sub(r"```[\s\S]*$", " (code block) ", text)  # one that never closed
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*_~>#]", "", text)
    text = text.replace("|", " ")
    return re.sub(r"\s+", " ", text).strip()


def to_speech(markdown: str) -> str:
    return markdown_to_speech(strip_inline_citations(markdown))


@dataclass
class Piece:
    text: str  # what to say, cleaned
    raw_start: int  # where it came from in the raw reply
    raw_end: int
    gap_ms: int  # silence to play after it
    index: int = 0


def _gap(raw: str) -> int:
    tail = raw.rstrip()
    if not tail or re.search(r"[.!?…][\"'”’)\]]*$", tail) or raw.endswith("\n"):
        return GAP_AFTER_SENTENCE_MS
    if _CLAUSE_MARK.search(tail):
        return GAP_AFTER_CLAUSE_MS
    return 0


def _word_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]


def _bare(word: str) -> str:
    return re.sub(r"[^\w]", "", word).lower()


class SpeechSplitter:
    """Feed it the reply as it streams; it hands back pieces ready to speak."""

    def __init__(self) -> None:
        self.raw = ""
        self._pos = 0  # first raw character not yet in a piece
        self._count = 0

    @property
    def spoken_upto(self) -> int:
        return self._pos

    def feed(self, delta: str) -> list[Piece]:
        self.raw += delta
        out: list[Piece] = []
        while True:
            cut = self._next_cut()
            if cut is None:
                break
            piece = self._take(cut)
            if piece is not None:
                out.append(piece)
        return out

    def finish(self) -> list[Piece]:
        out = self.feed("")
        if self._pos < len(self.raw):
            piece = self._take(len(self.raw))
            if piece is not None:
                out.append(piece)
        return out

    # ------------------------------------------------------------ cutting
    def _open_fence(self, start: int) -> int | None:
        """Where an unclosed code fence starts (nothing after it is cut yet)."""
        fences = [m.start() for m in re.finditer(r"```", self.raw[start:])]
        if len(fences) % 2:
            return start + fences[-1]
        return None

    def _sentence_cut(self, start: int, limit: int) -> int | None:
        text = self.raw[start:limit]
        for m in _SENTENCE_END.finditer(text):
            if m.group(1) is None:  # a line break
                if text[: m.start()].strip():
                    return start + m.end()
                continue
            before = text[: m.start(1)].split()
            word = _bare(before[-1]) if before else ""
            if m.group(1) == "." and (word in _ABBREVIATIONS or (len(word) == 1 and word.isalpha())):
                continue  # "Dr. Smith", "J. Smith"
            return start + m.end()
        return None

    def _next_cut(self) -> int | None:
        start = self._pos
        fence = self._open_fence(start)
        limit = fence if fence is not None else len(self.raw)
        if limit <= start:
            return None
        # A finished code block is one piece of its own ("code block"), so no
        # cut lands inside it; the text before it ends where it starts.
        f = self.raw.find("```", start, limit)
        if f != -1:
            if self.raw[start:f].strip():
                cut = self._cut_in(start, f)
                return cut if cut is not None else f
            close = self.raw.find("```", f + 3, limit)
            return close + 3 if close != -1 else None
        return self._cut_in(start, limit)

    def _cut_in(self, start: int, limit: int) -> int | None:
        text = self.raw[start:limit]
        if not text.strip():
            return None
        sentence = self._sentence_cut(start, limit)
        if self._count == 0:
            # The first piece: the first clause mark after two words or more,
            # or the first sentence when that comes sooner.
            for m in _CLAUSE_END.finditer(text):
                if len(text[: m.start()].split()) >= 2:
                    clause = start + m.end()
                    if sentence is None or clause < sentence:
                        return clause
                    break
            if sentence is not None:
                words = self.raw[start:sentence].split()
                if len(words) <= FIRST_CUT_AFTER_WORDS:
                    return sentence
                return start + self._first_cut_offset(self.raw[start:sentence])
            spans = _word_spans(text)
            # Only cut with a word to spare: the last one may still be arriving.
            if len(spans) > FIRST_CUT_AFTER_WORDS:
                return start + self._first_cut_offset(text)
            return None
        if sentence is not None:
            if sentence - start > MAX_PIECE_CHARS:
                return start + self._cap_offset(self.raw[start:sentence])
            return sentence
        if len(text) > MAX_PIECE_CHARS:
            return start + self._cap_offset(text)
        return None

    @staticmethod
    def _first_cut_offset(text: str) -> int:
        spans = _word_spans(text)
        words = [text[a:b] for a, b in spans]
        n = FIRST_PIECE_WORDS
        for k in range(FIRST_PIECE_WORDS, 3, -1):  # 6, 5, 4: before a joining word
            if k < len(words) and _bare(words[k]) in _BREAK_BEFORE:
                n = k
                break
        n = min(n, len(spans))
        return spans[n - 1][1] if n < len(spans) else len(text)

    @staticmethod
    def _cap_offset(text: str) -> int:
        """A cut inside a too-long stretch: the last clause mark that fits, else
        the last whole word that fits."""
        best = None
        for m in _CLAUSE_END.finditer(text):
            if m.end() > MAX_PIECE_CHARS:
                break
            best = m.end()
        if best:
            return best
        spans = [b for _, b in _word_spans(text) if b <= MAX_PIECE_CHARS]
        return spans[-1] if spans else min(len(text), MAX_PIECE_CHARS)

    def _take(self, end: int) -> Piece | None:
        start = self._pos
        self._pos = end
        raw = self.raw[start:end]
        text = to_speech(raw)
        if not re.search(r"\w", text):
            return None
        piece = Piece(text=text, raw_start=start, raw_end=end, gap_ms=_gap(raw), index=self._count)
        self._count += 1
        return piece


def heard_raw(raw: str, piece: Piece, fraction: float) -> int:
    """How far into ``raw`` someone got, ``fraction`` of the way through
    hearing ``piece``: a whole number of its words."""
    fraction = max(0.0, min(1.0, fraction))
    if fraction >= 1.0:
        return piece.raw_end
    segment = raw[piece.raw_start : piece.raw_end]
    spans = _word_spans(segment)
    if not spans:
        return piece.raw_start
    n = int(len(spans) * fraction)
    if n <= 0:
        return piece.raw_start
    return piece.raw_start + spans[n - 1][1]
