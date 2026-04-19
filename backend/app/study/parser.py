"""Streaming parser that extracts ``<whiteboard_action>`` blocks mid-flight.

The tutor LLM is instructed to emit whiteboard exercises as a structured
XML-ish block embedded anywhere in its response, e.g.::

    Here's your next exercise. <whiteboard_action>
    {"type": "exercise", "title": "Subnet Basics", "html": "<!DOCTYPE html>..."}
    </whiteboard_action> Give it a shot!

We need to:

1. Strip these blocks from the token stream that's displayed in chat.
2. Buffer tokens that might be the start of a block, so we never leak a
   partial ``<whiteb...`` to the UI.
3. Yield completed block payloads so the caller can parse the JSON, persist
   a ``WhiteboardExercise`` row, and emit an ``exercise_ready`` SSE event.
"""
from __future__ import annotations


OPEN_TAG = "<whiteboard_action>"
CLOSE_TAG = "</whiteboard_action>"


class WhiteboardActionParser:
    """Feed tokens in, get safe-to-display chat text and completed captures out.

    Designed for SSE-driven streaming where tokens can be as small as a
    single character and tags may span token boundaries.
    """

    def __init__(self) -> None:
        self._buf: str = ""
        self._in_tag: bool = False

    def feed(self, token: str) -> tuple[str, list[str]]:
        """Feed one streamed token.

        Returns ``(safe_text, completed_captures)`` where ``safe_text`` can be
        forwarded verbatim to the client and ``completed_captures`` is a list
        of the raw JSON-ish payload strings that appeared between
        ``<whiteboard_action>`` and ``</whiteboard_action>``.
        """
        self._buf += token
        emit_parts: list[str] = []
        captures: list[str] = []

        while True:
            if not self._in_tag:
                open_idx = self._buf.find(OPEN_TAG)
                if open_idx != -1:
                    emit_parts.append(self._buf[:open_idx])
                    self._buf = self._buf[open_idx + len(OPEN_TAG) :]
                    self._in_tag = True
                    continue
                # No open tag; emit everything up to the largest suffix of the
                # buffer that could still be the start of `OPEN_TAG`.
                safe_len = self._safe_prefix_len(self._buf, OPEN_TAG)
                emit_parts.append(self._buf[:safe_len])
                self._buf = self._buf[safe_len:]
                break
            else:
                close_idx = self._buf.find(CLOSE_TAG)
                if close_idx != -1:
                    captures.append(self._buf[:close_idx])
                    self._buf = self._buf[close_idx + len(CLOSE_TAG) :]
                    self._in_tag = False
                    continue
                # Still capturing; hold everything until we see the close.
                break

        return "".join(emit_parts), captures

    def flush(self) -> str:
        """Drain the buffer at end-of-stream.

        If the model stopped mid-capture we discard the partial action (it's
        malformed anyway). Any text buffered because it *could* have been a
        tag prefix is now safe to emit verbatim.
        """
        if self._in_tag:
            leftover = ""
        else:
            leftover = self._buf
        self._buf = ""
        self._in_tag = False
        return leftover

    @staticmethod
    def _safe_prefix_len(buf: str, tag: str) -> int:
        """Length of the leading portion of ``buf`` that is *safe* to emit.

        I.e. the largest ``n`` such that ``buf[n:]`` is not a non-empty prefix
        of ``tag``.
        """
        max_possible = min(len(buf), len(tag) - 1)
        for k in range(max_possible, 0, -1):
            if tag.startswith(buf[-k:]):
                return len(buf) - k
        return len(buf)
