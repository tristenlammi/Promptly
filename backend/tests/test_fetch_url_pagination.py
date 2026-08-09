"""Paginating a long page through ``fetch_url``.

Before this, anything past 6 000 characters was unreachable: the tool took
only a ``url``, its description told the model the rest of the page was
gone, and a repeat call replayed the identical prefix out of the turn-level
dedup cache. "Summarise this long article" silently answered from the first
15% of it, with nothing in the UI to suggest the answer was partial.

The windowing arithmetic is what these tests pin. An off-by-one here doesn't
crash — it silently drops or repeats a chunk of the page, which is the same
class of quiet wrongness the feature exists to fix. So: chunks must tile the
document exactly, with no gap and no overlap, and reassembling them must
reproduce the original text.
"""
from __future__ import annotations

import pytest

from app.chat.tools.fetch_url import _MAX_TEXT_CHARS


def window(text: str, offset: int) -> tuple[str, int, bool]:
    """Mirror of the slicing in ``FetchUrlTool.run``.

    Kept in the test rather than driving the whole tool because the real
    ``run`` needs network, trafilatura and SSRF checks — none of which say
    anything about whether the arithmetic tiles correctly.
    """
    total = len(text)
    chunk = text[offset : offset + _MAX_TEXT_CHARS]
    next_offset = offset + len(chunk)
    return chunk, next_offset, next_offset < total


def test_short_page_is_not_truncated():
    text = "a" * 100
    chunk, nxt, truncated = window(text, 0)
    assert chunk == text
    assert nxt == 100
    assert truncated is False


def test_page_exactly_at_the_cap_is_not_truncated():
    """The boundary case: ``>`` vs ``>=`` here decides whether a page that
    fits exactly claims there's more to read."""
    text = "a" * _MAX_TEXT_CHARS
    chunk, nxt, truncated = window(text, 0)
    assert len(chunk) == _MAX_TEXT_CHARS
    assert nxt == _MAX_TEXT_CHARS
    assert truncated is False


def test_one_char_over_the_cap_is_truncated():
    text = "a" * (_MAX_TEXT_CHARS + 1)
    _chunk, nxt, truncated = window(text, 0)
    assert truncated is True
    assert nxt == _MAX_TEXT_CHARS


def test_chunks_tile_the_document_without_gap_or_overlap():
    """Walk a long page the way the model would — always using the reported
    next offset — and require the pieces to reassemble byte-for-byte."""
    text = "".join(f"{i:06d}" for i in range(4000))  # 24 000 chars
    pieces: list[str] = []
    offset = 0
    guard = 0
    while True:
        guard += 1
        assert guard < 100, "pagination failed to terminate"
        chunk, offset, truncated = window(text, offset)
        pieces.append(chunk)
        if not truncated:
            break

    assert "".join(pieces) == text, "chunks did not reassemble to the original"
    assert offset == len(text)
    # 24 000 / 6 000 — no stray empty final chunk.
    assert len(pieces) == 4


def test_final_chunk_is_short_and_terminates():
    """A page that isn't a clean multiple of the window must still end."""
    text = "a" * (_MAX_TEXT_CHARS + 10)
    _first, offset, truncated = window(text, 0)
    assert truncated is True
    last, offset, truncated = window(text, offset)
    assert last == "a" * 10
    assert truncated is False
    assert offset == len(text)


def test_offset_past_the_end_yields_nothing():
    """The tool turns this into an error naming the last valid offset rather
    than handing back an empty page that reads as 'nothing here'."""
    text = "a" * 100
    chunk, _nxt, truncated = window(text, 500)
    assert chunk == ""
    assert truncated is False


@pytest.mark.parametrize("raw,expected", [("1500", 1500), (1500.0, 1500), (0, 0), (None, 0)])
def test_offset_coercion_accepts_what_models_actually_emit(raw, expected):
    """JSON has one number type and providers round-trip through float, so
    models emit ``"1500"`` and ``1500.0`` constantly. Rejecting those would
    burn a hop on a call that was semantically fine."""
    assert max(0, int(float(raw or 0))) == expected


def test_negative_offset_clamps_to_the_start():
    assert max(0, int(float(-50))) == 0
