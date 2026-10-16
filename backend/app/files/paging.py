"""Keyset pagination for Drive listings (WP-7.6, Part C §5.9).

A folder of 20,000 photos used to come back in one response — every row,
every sharing summary — and the browser rendered all of it. Listings now
come a page at a time, ordered by the sort column *and the id* (so equal
names or dates can't repeat or skip a row between pages), and the next page
starts strictly after the last row of this one. Unlike OFFSET, that stays
fast deep into a folder and doesn't shift when someone adds a file while
you scroll.

The cursor is opaque to clients: base64url JSON of the sort it belongs to
and the last row's (value, id). A cursor from a different sort is refused.
"""
from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Sequence

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.sql import Select

MAX_LIMIT = 1000


@dataclass(frozen=True)
class After:
    value: Any
    id: uuid.UUID


def encode(sort: str, direction: str, value: Any, row_id: uuid.UUID) -> str:
    if isinstance(value, datetime):
        value = {"t": value.isoformat()}
    raw = json.dumps({"s": sort, "d": direction, "v": value, "i": str(row_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode(cursor: str | None, sort: str, direction: str) -> After | None:
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if data["s"] != sort or data["d"] != direction:
            raise ValueError("cursor from another sort")
        value = data["v"]
        if isinstance(value, dict) and "t" in value:
            value = datetime.fromisoformat(value["t"])
        return After(value, uuid.UUID(data["i"]))
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That page link is out of date — reload the folder.",
        ) from None


def apply(stmt: Select, col: Any, id_col: Any, direction: str, after: After | None, limit: int | None) -> Select:
    """``stmt`` ordered by (col, id) in ``direction``, starting after
    ``after``, fetching one extra row to know whether there's more."""
    desc = direction == "desc"
    if after is not None:
        if desc:
            stmt = stmt.where(or_(col < after.value, and_(col == after.value, id_col < after.id)))
        else:
            stmt = stmt.where(or_(col > after.value, and_(col == after.value, id_col > after.id)))
    stmt = stmt.order_by(col.desc() if desc else col.asc(), id_col.desc() if desc else id_col.asc())
    if limit is not None:
        stmt = stmt.limit(limit + 1)
    return stmt


def split(rows: Sequence[Any], limit: int | None, sort: str, direction: str, value_of: Callable[[Any], Any]) -> tuple[list[Any], str | None]:
    """This page's rows and the cursor for the next (None at the end)."""
    rows = list(rows)
    if limit is None or len(rows) <= limit:
        return rows, None
    rows = rows[:limit]
    last = rows[-1]
    return rows, encode(sort, direction, value_of(last), last.id)


def in_memory(items: Sequence[Any], key: Callable[[Any], Any], direction: str, after: After | None, limit: int | None, sort: str) -> tuple[list[Any], str | None]:
    """The same paging over a list built in Python (the Shared root, which
    is a union of several queries)."""
    desc = direction == "desc"
    ordered = sorted(items, key=lambda x: (key(x), str(x.id)), reverse=desc)
    if after is not None:
        mark = (after.value, str(after.id))
        ordered = [x for x in ordered if ((key(x), str(x.id)) < mark if desc else (key(x), str(x.id)) > mark)]
    return split(ordered, limit, sort, direction, key)


__all__ = ["MAX_LIMIT", "After", "apply", "decode", "encode", "in_memory", "split"]
