"""The text query behind Drive search (WP-5.4).

``files.content_tsv`` holds names under the ``simple`` config and file text
under ``english`` (migration 0195), so a query is tried both ways:

* ``websearch_to_tsquery('english', q)`` — whole words, stemmed ("invoices"
  finds "invoice"), with quotes / ``-exclude`` / ``OR``;
* ``websearch_to_tsquery('simple', q)`` — exact words in any language;
* as you type, every word as a prefix (``'budg':*`` finds "budget") — only
  for plain queries, since operators mean the person typed a full search.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, literal_column

_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_OPERATORS = re.compile(r"[\"']|(^|\s)-\S|\bOR\b")


def prefix_query_text(q: str) -> str | None:
    """``'w1':* & 'w2':*`` for a plain query, or ``None`` (an operator
    query, or nothing worth prefixing). Words are letters and digits only,
    so the text is always a valid tsquery."""
    if _OPERATORS.search(q):
        return None
    words = [w.lower() for w in _WORD.findall(q)][:8]
    if not words:
        return None
    parts = [f"'{w}':*" if len(w) >= 2 else f"'{w}'" for w in words]
    return " & ".join(parts)


def drive_tsquery(q: str) -> Any:
    """The combined tsquery expression for ``q``."""
    expr = func.websearch_to_tsquery("english", q).op("||")(func.websearch_to_tsquery("simple", q))
    prefix = prefix_query_text(q)
    if prefix:
        expr = expr.op("||")(func.to_tsquery("simple", prefix))
    return expr


def tsv_match(q: str) -> Any:
    """``content_tsv @@ <query>``."""
    return literal_column("content_tsv").op("@@")(drive_tsquery(q))


__all__ = ["drive_tsquery", "prefix_query_text", "tsv_match"]

