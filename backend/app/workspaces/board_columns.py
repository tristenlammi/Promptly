"""Resolve a human/model-supplied board column to its stored status id.

Board columns are ``{id, name}`` pairs. Default boards carry no ``columns``
entry in config and use the three built-in ids (``todo``/``doing``/``done``);
custom columns get generated ids like ``c_ab12cd3`` whose *names* are what
anyone actually sees.

That split is the bug this module exists to close. The AI reads a board via
its flattened text, which groups cards under column **names** (``## In
Review`` — see ``knowledge.py::_flatten_board``), then passed that name
straight into a query that compares against the stored **id**. On any board
with custom columns the consequences were bad in both directions:

* Reading — ``status="In Review"`` matched nothing, and the tool reported
  ``0 card(s) match`` as a confident fact rather than an error.
* Writing — "mark the in-progress ones done" filed a proposal with
  ``status="done"``, which matches no column on such a board. Applying it set
  a status nothing recognises, so ``_is_done_status`` returned False (card
  not actually complete) and the UI's unknown-status fallback bucketed the
  card into the *first* column. The user asked to complete work and watched it
  move to the backlog, under a proposal marked "Applied".

Resolution accepts either the id or the display name, case-insensitively, and
also maps the common English aliases onto whichever column carries the
matching built-in id. When nothing matches we return the valid labels so the
caller can tell the model what the real options are — a board's column names
are otherwise undiscoverable through the tool API.
"""
from __future__ import annotations

from typing import Any

# Everyday phrasings for the three built-in columns. Only consulted after a
# direct id/name match fails, so a custom column literally named "Open" wins
# over the alias that would otherwise send it to ``todo``.
STATUS_ALIASES: dict[str, str] = {
    "todo": "todo", "to do": "todo", "to-do": "todo", "backlog": "todo",
    "not started": "todo", "open": "todo",
    "doing": "doing", "in progress": "doing", "in-progress": "doing",
    "wip": "doing", "started": "doing", "active": "doing",
    "done": "done", "complete": "done", "completed": "done", "finished": "done",
}

_DEFAULT_COLUMNS: tuple[tuple[str, str], ...] = (
    ("todo", "To Do"),
    ("doing", "In Progress"),
    ("done", "Done"),
)


def board_columns(config: Any) -> list[tuple[str, str]]:
    """``[(id, name), …]`` for a board, falling back to the built-in three."""
    cols = (config or {}).get("columns") if isinstance(config, dict) else None
    if not isinstance(cols, list) or not cols:
        return list(_DEFAULT_COLUMNS)
    out: list[tuple[str, str]] = []
    for c in cols:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or "").strip()
        if not cid:
            continue
        out.append((cid, str(c.get("name") or cid).strip()))
    return out or list(_DEFAULT_COLUMNS)


def column_labels(config: Any) -> list[str]:
    """Display names, for telling the model what the real options are."""
    return [name for _cid, name in board_columns(config)]


def resolve_status(config: Any, token: str) -> str | None:
    """Map ``token`` to a stored column id, or ``None`` if it matches nothing.

    Accepts the column id, its display name, or a common alias — in that
    order, so an exact match always beats an alias.
    """
    t = (token or "").strip().lower()
    if not t:
        return None
    cols = board_columns(config)

    for cid, name in cols:
        if t == cid.lower() or t == name.lower():
            return cid

    alias = STATUS_ALIASES.get(t)
    if alias:
        for cid, _name in cols:
            if cid.lower() == alias:
                return cid
    return None


def done_status_ids(config: Any) -> list[str]:
    """Column ids that count as "done" for this board.

    Mirrors ``tasks_router._is_done_status``: a board may flag one or more
    columns ``done: true``; otherwise the built-in ``done`` id applies.
    """
    cols = (config or {}).get("columns") if isinstance(config, dict) else None
    if isinstance(cols, list) and cols:
        flagged = [
            str(c.get("id"))
            for c in cols
            if isinstance(c, dict) and c.get("done") and c.get("id")
        ]
        if flagged:
            return flagged
        return [str(c.get("id")) for c in cols if isinstance(c, dict) and str(c.get("id") or "").lower() == "done"]
    return ["done"]


__all__ = [
    "STATUS_ALIASES",
    "board_columns",
    "column_labels",
    "resolve_status",
    "done_status_ids",
]
