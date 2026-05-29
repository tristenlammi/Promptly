"""Helpers for in-thread regeneration versioning (Phase 2.6).

The message tree is encoded with a single ``Message.parent_id`` self-FK.
Messages sharing a ``parent_id`` are *sibling versions*. A conversation
remembers its currently-visible leaf in ``Conversation.active_leaf_message_id``;
the visible thread is the lineage from that leaf back to the root.

Everything here is pure (operates on already-loaded message lists) so
the router can load a conversation's rows once and reuse them for the
active path, per-message version metadata, and leaf descent.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass

from app.chat.models import Message


@dataclass(frozen=True)
class VersionMeta:
    """Sibling-group info for a single message on the active path."""

    index: int  # 1-based position within its sibling group
    count: int  # number of sibling versions
    sibling_ids: list[uuid.UUID]  # ordered by created_at


def _by_id(rows: list[Message]) -> dict[uuid.UUID, Message]:
    return {m.id: m for m in rows}


def lineage_to(
    rows: list[Message], target_id: uuid.UUID | None
) -> list[Message]:
    """Return root → ``target`` following ``parent_id`` upward.

    ``rows`` must be every message in the conversation. Returns an empty
    list if ``target_id`` is unknown. Guards against cycles defensively.
    """
    if target_id is None:
        return []
    index = _by_id(rows)
    chain: list[Message] = []
    seen: set[uuid.UUID] = set()
    cur = index.get(target_id)
    while cur is not None and cur.id not in seen:
        seen.add(cur.id)
        chain.append(cur)
        cur = index.get(cur.parent_id) if cur.parent_id else None
    chain.reverse()
    return chain


def active_path(rows: list[Message], active_leaf_id: uuid.UUID | None) -> list[Message]:
    """The currently-visible thread.

    Walks from ``active_leaf_id`` to the root. Falls back to plain
    ``created_at`` order (i.e. all rows) when there's no usable leaf —
    covers legacy conversations before the 0054 backfill and any state
    where the stored leaf went missing.
    """
    if active_leaf_id is not None and active_leaf_id in _by_id(rows):
        path = lineage_to(rows, active_leaf_id)
        if path:
            return path
    # Legacy / fallback: rows are expected to be created_at-ordered.
    return list(rows)


def _children_map(rows: list[Message]) -> dict[uuid.UUID | None, list[Message]]:
    """parent_id -> children, each child list ordered by created_at then id.

    ``rows`` is assumed created_at-ordered already; we keep a stable
    secondary sort on id for deterministic tie-breaking.
    """
    children: dict[uuid.UUID | None, list[Message]] = defaultdict(list)
    for m in rows:
        children[m.parent_id].append(m)
    for kids in children.values():
        kids.sort(key=lambda x: (x.created_at, str(x.id)))
    return children


def descend_to_leaf(rows: list[Message], start_id: uuid.UUID) -> uuid.UUID:
    """From ``start_id``, follow the most-recently-created child at each
    step until a leaf. Used when switching versions: activating a sibling
    re-enters whichever continuation was most recent under it."""
    children = _children_map(rows)
    cur = start_id
    seen: set[uuid.UUID] = set()
    while cur not in seen:
        seen.add(cur)
        kids = children.get(cur, [])
        if not kids:
            return cur
        cur = kids[-1].id
    return cur


def version_meta(rows: list[Message], path: list[Message]) -> dict[uuid.UUID, VersionMeta]:
    """Per-message sibling metadata for every message on ``path`` that
    has more than one version. Messages with a single version are omitted
    (callers treat "absent" as "no pager")."""
    children = _children_map(rows)
    out: dict[uuid.UUID, VersionMeta] = {}
    for m in path:
        sibs = children.get(m.parent_id, [m])
        if len(sibs) <= 1:
            continue
        ids = [s.id for s in sibs]
        try:
            idx = ids.index(m.id) + 1
        except ValueError:  # pragma: no cover — m always in its own group
            continue
        out[m.id] = VersionMeta(index=idx, count=len(ids), sibling_ids=ids)
    return out
