"""Notes on Today and in the search box (``docs/notes-plan.md`` §6).

* :func:`section` — the Today card: up to three of your pinned notes (a
  list shows how many items are left) and voice notes whose words are
  still being worked out. Reminders already show on Today through Tasks.
* :func:`search` — Ctrl+K: notes whose title, text, items or recordings'
  words match.

Both read only notes you can open (``access.visible_predicate``): your own
and ones shared with you, never trashed ones, never anyone else's.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from sqlalchemy import and_, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import access
from .models import Note, NoteAttachment, NoteItem, NoteUserState

PINNED = 3
TRANSCRIBING = 2


def _snippet(text: str, n: int = 120) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:n]


async def _left(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, tuple[int, int]]:
    """(unticked, all) items per list."""
    out: dict[uuid.UUID, list[int]] = {}
    if not ids:
        return {}
    for nid, checked, n in (
        await db.execute(
            select(NoteItem.note_id, NoteItem.checked, func.count()).where(NoteItem.note_id.in_(ids)).group_by(NoteItem.note_id, NoteItem.checked)
        )
    ).all():
        c = out.setdefault(nid, [0, 0])
        if not checked:
            c[0] += n
        c[1] += n
    return {k: (v[0], v[1]) for k, v in out.items()}


def _card(n: Note, user: User, left: dict[uuid.UUID, tuple[int, int]]) -> dict[str, Any]:
    from .service import display_title

    lt = left.get(n.id, (0, 0))
    return {
        "id": str(n.id),
        "title": display_title(n),
        "kind": n.kind,
        "color": n.color,
        "snippet": "" if n.kind == "list" else _snippet(n.body_text if n.title.strip() else "\n".join(n.body_text.split("\n")[1:])),
        "left": lt[0] if n.kind == "list" else None,
        "total": lt[1] if n.kind == "list" else None,
        "shared": n.owner_id != user.id,
        "url": f"/notes/n/{n.id}",
    }


async def section(db: AsyncSession, user: User) -> dict[str, Any] | None:
    """Today's Notes card, or None when there's nothing to show."""
    from app.files.models import UserFile

    from .attachments import live_join

    st = NoteUserState
    pinned = list(
        (
            await db.execute(
                select(Note)
                .join(st, and_(st.note_id == Note.id, st.user_id == user.id))
                .where(access.visible_predicate(user.id), st.pinned.is_(True), st.archived_at.is_(None))
                .order_by(st.position, Note.id)
                .limit(PINNED + 1)
            )
        ).scalars()
    )
    busy = list(
        (
            await db.execute(
                select(Note)
                .outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
                .where(
                    access.visible_predicate(user.id),
                    st.archived_at.is_(None),
                    Note.id.in_(
                        select(NoteAttachment.note_id)
                        .join(UserFile, live_join())
                        .where(
                            NoteAttachment.kind == "audio",
                            NoteAttachment.transcript_state.in_(("pending", "working")),
                            NoteAttachment.added_by == user.id,
                        )
                    ),
                )
                .order_by(Note.updated_at.desc())
                .limit(TRANSCRIBING)
            )
        ).scalars()
    )
    if not pinned and not busy:
        return None
    more = len(pinned) > PINNED
    pinned = pinned[:PINNED]
    left = await _left(db, [n.id for n in pinned if n.kind == "list"])
    return {
        "url": "/notes",
        "pinned": [_card(n, user, left) for n in pinned],
        "more_pinned": more,
        "transcribing": [{"id": str(n.id), "title": _card(n, user, {})["title"], "url": f"/notes/n/{n.id}"} for n in busy],
    }


async def search(db: AsyncSession, user: User, q: str, limit: int = 5) -> list[dict[str, Any]]:
    """Notes matching ``q`` (title, text, items, transcripts), best first."""
    from app.files.search_query import drive_tsquery

    term = (q or "").strip()[:200]
    if len(term) < 2:
        return []
    pat = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    tsq = drive_tsquery(term)
    rank = func.ts_rank(literal_column("notes.tsv"), tsq)
    rows = list(
        (
            await db.execute(
                select(Note)
                .where(
                    access.visible_predicate(user.id),
                    or_(literal_column("notes.tsv").op("@@")(tsq), Note.title.ilike(pat, escape="\\"), Note.search_text.ilike(pat, escape="\\")),
                )
                .order_by(Note.title.ilike(pat, escape="\\").desc(), rank.desc(), Note.updated_at.desc())
                .limit(limit)
            )
        ).scalars()
    )
    left = await _left(db, [n.id for n in rows if n.kind == "list"])
    out = []
    low = term.lower()
    for n in rows:
        c = _card(n, user, left)
        # Where it matched, when it wasn't the title.
        hay = n.search_text or ""
        i = hay.lower().find(low)
        if i >= 0 and low not in c["title"].lower():
            c["snippet"] = ("…" if i > 30 else "") + _snippet(hay[max(0, i - 30): i + 90])
        out.append(c)
    return out


__all__ = ["PINNED", "search", "section"]
