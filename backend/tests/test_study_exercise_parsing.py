"""Regression tests for whiteboard-exercise capture + parsing.

These pin down the failure that made the Study board "stop working":
the tutor emits an exercise as ``<whiteboard_action>...HTML...</...>``
and any fragility in capturing or parsing that block silently drops the
exercise, leaving the student with a blank board and no explanation.

Two surfaces are covered, both pure-Python (no DB / HTTP):

* :meth:`TaggedActionParser.pending_capture` — lets the SSE generator
  detect a stream that ended mid-exercise (token-budget truncation)
  instead of discarding it silently.
* :func:`service.parse_whiteboard_payload` — must be liberal about the
  raw HTML the model actually produces, not just the three exact
  prefixes the old implementation required.
"""

from __future__ import annotations

from app.study import service
from app.study.parser import TaggedActionParser


# ---------------------------------------------------------------------------
# pending_capture — truncation detection
# ---------------------------------------------------------------------------
def _feed_all(parser: TaggedActionParser, text: str, *, chunk: int = 7) -> str:
    """Feed ``text`` through the parser in small chunks (mimicking SSE
    tokens that split tags across boundaries) and return the safe text."""
    out: list[str] = []
    for i in range(0, len(text), chunk):
        safe, _ = parser.feed(text[i : i + chunk])
        out.append(safe)
    return "".join(out)


def test_pending_capture_none_when_block_closed():
    parser = TaggedActionParser(tags=["whiteboard_action"])
    _feed_all(
        parser,
        "Here you go. <whiteboard_action><!DOCTYPE html><title>Q</title>"
        "</whiteboard_action> Good luck!",
    )
    assert parser.pending_capture() is None


def test_pending_capture_flags_truncated_exercise():
    parser = TaggedActionParser(tags=["whiteboard_action"])
    # Stream cuts off mid-exercise: the closing tag never arrives.
    _feed_all(
        parser,
        "Try this one. <whiteboard_action><!DOCTYPE html><title>Big</title>"
        "<body>... model hit the token budget here",
    )
    assert parser.pending_capture() == "whiteboard_action"
    # flush() still discards the partial (unchanged contract), but the
    # caller now had a chance to react first.
    assert parser.flush() == ""


def test_pending_capture_normalises_board_op_attr_alias():
    parser = TaggedActionParser(tags=["board_op"])
    _feed_all(parser, 'pin this <board_op op="add" kind="term" payload={')
    # Internal name is board_op_attr; public/yielded name is board_op.
    assert parser.pending_capture() == "board_op"


# ---------------------------------------------------------------------------
# parse_whiteboard_payload — liberal HTML acceptance
# ---------------------------------------------------------------------------
def test_parses_canonical_doctype_html():
    body = "<!DOCTYPE html><html><head><title>Quick check</title></head>" \
        "<body><div class='q'></div></body></html>"
    payload = service.parse_whiteboard_payload(body)
    assert payload is not None
    assert payload["type"] == "exercise"
    assert payload["title"] == "Quick check"
    assert payload["html"].startswith("<!DOCTYPE html>")


def test_parses_html_with_leading_prose_drift():
    # The model sometimes writes a sentence before the markup. The old
    # parser required the body to START with <!doctype/<html/<!-- and
    # silently dropped this — the exact "board stopped working" bug.
    body = "Here's your exercise:\n<!DOCTYPE html><html><title>T</title>" \
        "<body>hi</body></html>"
    payload = service.parse_whiteboard_payload(body)
    assert payload is not None
    assert payload["html"].startswith("<!DOCTYPE html>")
    assert payload["title"] == "T"


def test_parses_html_fragment_starting_with_div():
    body = "<div class='q'><h2>1. Pick one</h2>" \
        "<label><input type='radio' name='q1'> A</label></div>"
    payload = service.parse_whiteboard_payload(body)
    assert payload is not None
    assert payload["type"] == "exercise"
    assert payload["html"].startswith("<div")


def test_parses_legacy_json_envelope():
    body = '{"type": "exercise", "title": "JSON one", "html": "<div>x</div>"}'
    payload = service.parse_whiteboard_payload(body)
    assert payload is not None
    assert payload["title"] == "JSON one"
    assert payload["html"] == "<div>x</div>"


def test_parses_code_fenced_html():
    body = "```html\n<!DOCTYPE html><html><title>Fenced</title></html>\n```"
    payload = service.parse_whiteboard_payload(body)
    assert payload is not None
    assert payload["title"] == "Fenced"


def test_rejects_pure_prose():
    assert service.parse_whiteboard_payload("just some words, no markup") is None
    assert service.parse_whiteboard_payload("   ") is None
    assert service.parse_whiteboard_payload("") is None
