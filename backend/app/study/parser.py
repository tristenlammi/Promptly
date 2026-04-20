"""Streaming parser that extracts tagged action blocks mid-flight.

The study tutor LLM emits structured side-channel actions embedded in
its chat output — the chat router needs to *strip* them from the
student-visible text, *buffer* tokens that might be the start of a tag
so partial prefixes never leak, and *yield* completed payloads for the
caller to persist as e.g. whiteboard exercises, unit-mastery marks, or
exam grading results.

Today three tag names are supported:

* ``<whiteboard_action>`` — legacy exercise block; JSON describing a
  sandboxed HTML exercise.
* ``<unit_action>`` — unit-tutor side channel (``mark_complete`` with a
  mastery score once the tutor decides the student gets it).
* ``<exam_action>`` — final-exam side channel (``grade`` at the end of
  the attempt with pass/fail + weak/strong unit ids).

The parser is tag-set agnostic — callers pass the tag names they care
about and receive ``(safe_text, captures)`` per ``feed`` call, where each
capture carries the matching tag name so one call site can dispatch
across all three action types.
"""
from __future__ import annotations

from dataclasses import dataclass


# Back-compat — the whiteboard pipeline imports these names directly.
OPEN_TAG = "<whiteboard_action>"
CLOSE_TAG = "</whiteboard_action>"


@dataclass(frozen=True)
class Capture:
    tag: str  # e.g. "whiteboard_action"
    body: str  # raw text between <tag> and </tag>


class TaggedActionParser:
    """Streaming parser for one-or-more ``<name>...</name>`` action blocks.

    Designed for SSE-driven streaming where tokens can be as small as a
    single character and tags may span token boundaries. Multiple tag
    names can be matched at once so the study router can handle
    ``whiteboard_action``, ``unit_action``, and ``exam_action`` in a
    single pass without duplicating the buffering logic.
    """

    def __init__(self, tags: list[str] | None = None) -> None:
        # Default set covers every current consumer — an explicit list
        # is still accepted for callers that want to restrict the
        # surface (e.g. the freeform tutor only accepts whiteboard).
        self._tags: list[str] = list(tags) if tags else [
            "whiteboard_action",
            "unit_action",
            "exam_action",
        ]
        self._opens: list[tuple[str, str]] = [(f"<{t}>", t) for t in self._tags]
        self._closes: dict[str, str] = {t: f"</{t}>" for t in self._tags}
        # Longest possible tag-token so we know how much to retain as
        # "could still become a tag prefix" at buffer tail.
        self._max_tag_len = max(
            max(len(o) for o, _ in self._opens),
            max(len(c) for c in self._closes.values()),
        )

        self._buf: str = ""
        self._in_tag: str | None = None  # Name of the tag currently open, or None.

    def feed(self, token: str) -> tuple[str, list[Capture]]:
        """Feed one streamed token.

        Returns ``(safe_text, completed_captures)`` where ``safe_text``
        can be forwarded verbatim to the client and ``completed_captures``
        is a list of :class:`Capture` — each one carrying the tag name
        plus the raw JSON-ish body that appeared between the tags.
        """
        self._buf += token
        emit_parts: list[str] = []
        captures: list[Capture] = []

        while True:
            if self._in_tag is None:
                # Find the earliest opening tag anywhere in the buffer.
                earliest_idx = -1
                earliest_tag = ""
                earliest_open = ""
                for open_tag, name in self._opens:
                    idx = self._buf.find(open_tag)
                    if idx == -1:
                        continue
                    if earliest_idx == -1 or idx < earliest_idx:
                        earliest_idx = idx
                        earliest_tag = name
                        earliest_open = open_tag
                if earliest_idx != -1:
                    emit_parts.append(self._buf[:earliest_idx])
                    self._buf = self._buf[earliest_idx + len(earliest_open):]
                    self._in_tag = earliest_tag
                    continue
                # No open tag; emit everything up to the largest suffix
                # of the buffer that could still be the start of *any*
                # open tag — otherwise we'd leak partial ``<wh...``.
                safe_len = self._safe_prefix_len(
                    self._buf, [o for o, _ in self._opens]
                )
                emit_parts.append(self._buf[:safe_len])
                self._buf = self._buf[safe_len:]
                break
            else:
                close_tag = self._closes[self._in_tag]
                close_idx = self._buf.find(close_tag)
                if close_idx != -1:
                    captures.append(
                        Capture(tag=self._in_tag, body=self._buf[:close_idx])
                    )
                    self._buf = self._buf[close_idx + len(close_tag):]
                    self._in_tag = None
                    continue
                # Still capturing; hold everything until we see the close.
                break

        return "".join(emit_parts), captures

    def flush(self) -> str:
        """Drain the buffer at end-of-stream.

        If the model stopped mid-capture we discard the partial action
        (it's malformed anyway). Any text buffered because it *could*
        have been a tag prefix is now safe to emit verbatim.
        """
        if self._in_tag is not None:
            leftover = ""
        else:
            leftover = self._buf
        self._buf = ""
        self._in_tag = None
        return leftover

    @staticmethod
    def _safe_prefix_len(buf: str, tags: list[str]) -> int:
        """Length of the leading portion of ``buf`` that is safe to emit.

        I.e. the largest ``n`` such that ``buf[n:]`` is not a non-empty
        prefix of any known ``tag``.
        """
        max_possible = min(len(buf), max(len(t) for t in tags) - 1)
        for k in range(max_possible, 0, -1):
            tail = buf[-k:]
            if any(t.startswith(tail) for t in tags):
                return len(buf) - k
        return len(buf)


class WhiteboardActionParser(TaggedActionParser):
    """Legacy single-tag parser — kept for the pure-freeform tutor path.

    Returns ``(safe_text, list[str])`` for drop-in compatibility with
    callers that were written before the multi-tag parser existed.
    """

    def __init__(self) -> None:
        super().__init__(tags=["whiteboard_action"])

    def feed(self, token: str) -> tuple[str, list[str]]:  # type: ignore[override]
        safe_text, captures = super().feed(token)
        return safe_text, [c.body for c in captures]
