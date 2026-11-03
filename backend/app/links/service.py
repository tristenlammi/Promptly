"""The ``entity_links`` table: mentions, hand-made links, and the lists.

**Mentions** are read out of a source's text whenever it's saved or sent —
a doc's HTML snapshot, a room message, a chat message, a journal entry —
and the source's mention rows are rewritten to match (a mention taken out
of the text goes; a deleted source loses them all). A mention is written as
an in-app link to ``/link/<kind>/<id>`` (in a doc, a Link mark's href; in
Markdown, ``@[Title](/link/<kind>/<id>)``). A doc's older ``[[`` wiki links
to workspace items (``…?item=<id>``) and chat's ``@[name](file:<id>)``
count too.

Recording a mention needs nothing from the target: the rows only say what
the text says. Everything shown is checked at read time — the viewer must
see the thing whose list it is, and every entry is resolved as the viewer
sees it (:func:`app.links.refs.resolve`), so a title never shows to someone
who can't open that thing.

**Links** are two-way and stored once (pair in canonical order).
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Iterable

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import refs
from .models import EntityLink

logger = logging.getLogger("promptly.links")

MAX_MENTIONS = 200
MAX_LIST = 300

Ref = tuple[str, str]

_KIND_ALT = "|".join(sorted(refs.KINDS, key=len, reverse=True))
_LINK_RE = re.compile(rf"/link/({_KIND_ALT})/([A-Za-z0-9:_\-]{{1,120}})")
_WIKI_RE = re.compile(r"[?&;]item=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
_CHAT_FILE_RE = re.compile(r"@\[[^\]\n]+?\]\(file:([0-9a-fA-F-]{36})\)")


def link_path(kind: str, id_: str) -> str:
    return f"/link/{kind}/{id_}"


def extract_refs(text: str | None, *, wiki: bool = False) -> list[Ref]:
    """Things ``text`` mentions, in order, deduped (well-formed ones only).
    ``wiki`` also reads ``…?item=<id>`` links to workspace items (doc HTML)."""
    if not text:
        return []
    found: list[Ref] = []
    for m in _LINK_RE.finditer(text):
        found.append((m.group(1), m.group(2)))
    for m in _CHAT_FILE_RE.finditer(text):
        found.append(("file", m.group(1)))
    if wiki:
        for m in _WIKI_RE.finditer(text):
            found.append(("witem", m.group(1)))
    out: list[Ref] = []
    seen: set[Ref] = set()
    for kind, id_ in found:
        if not refs.valid(kind, id_):
            continue
        r = (refs.store_kind(kind), refs.normalise(kind, id_))
        if r not in seen:
            seen.add(r)
            out.append(r)
        if len(out) >= MAX_MENTIONS:
            break
    return out


# ------------------------------------------------------------------ mentions


async def sync_mentions(
    db: AsyncSession,
    source_kind: str,
    source_id: str | uuid.UUID,
    mentioned: Iterable[Ref],
    *,
    user_id: uuid.UUID | None = None,
) -> None:
    """Make the source's mention rows exactly ``mentioned`` (flushed)."""
    await sync_many(db, source_kind, {str(source_id): list(mentioned)}, user_id=user_id)


async def sync_text(
    db: AsyncSession,
    source_kind: str,
    source_id: str | uuid.UUID,
    text: str | None,
    *,
    user_id: uuid.UUID | None = None,
    wiki: bool = False,
) -> None:
    """:func:`sync_mentions` with the refs read out of ``text``. Best effort:
    keeping mentions must never fail the save or send that triggered it."""
    try:
        async with db.begin_nested():
            await sync_mentions(db, source_kind, source_id, extract_refs(text, wiki=wiki), user_id=user_id)
    except Exception:  # noqa: BLE001
        logger.warning("recording mentions for %s %s failed", source_kind, source_id, exc_info=True)


async def sync_many(
    db: AsyncSession,
    source_kind: str,
    by_source: dict[str, list[Ref]],
    *,
    user_id: uuid.UUID | None = None,
    prefix: str | None = None,
) -> None:
    """Rewrite the mention rows of several sources at once. With ``prefix``,
    sources of ``source_kind`` starting with it that aren't in ``by_source``
    lose theirs too (e.g. a journal's deleted entries)."""
    ids = list(by_source)
    conds = [EntityLink.source_id.in_(ids)] if ids else []
    if prefix is not None:
        esc = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conds.append(EntityLink.source_id.like(f"{esc}%", escape="\\"))
    if not conds:
        return
    existing = list(
        (
            await db.execute(
                select(EntityLink).where(
                    EntityLink.link_type == "mention", EntityLink.source_kind == source_kind, or_(*conds)
                )
            )
        ).scalars()
    )
    have: dict[tuple[str, str, str], EntityLink] = {(r.source_id, r.target_kind, r.target_id): r for r in existing}
    want: set[tuple[str, str, str]] = set()
    for sid, mentioned in by_source.items():
        for kind, tid in mentioned[:MAX_MENTIONS]:
            if (kind, tid) == (source_kind, sid):
                continue  # mentioning yourself
            want.add((sid, kind, tid))
    gone = [r.id for key, r in have.items() if key not in want]
    if gone:
        await db.execute(delete(EntityLink).where(EntityLink.id.in_(gone)))
    new = [k for k in want if k not in have]
    if new:
        await db.execute(
            pg_insert(EntityLink)
            .values(
                [
                    {
                        "id": uuid.uuid4(),
                        "source_kind": source_kind,
                        "source_id": sid,
                        "target_kind": kind,
                        "target_id": tid,
                        "link_type": "mention",
                        "created_by": user_id,
                    }
                    for sid, kind, tid in new
                ]
            )
            .on_conflict_do_nothing(constraint="uq_entity_links")
        )
    await db.flush()


async def sync_journal(db: AsyncSession, file_id: uuid.UUID, data: dict, *, user_id: uuid.UUID | None = None) -> None:
    """A journal file was saved: each entry's mentions, and none for entries
    that are gone. Best effort."""
    try:
        by_source = {
            f"{file_id}:{e['id']}": extract_refs(e.get("body"))
            for e in (data or {}).get("entries", [])
            if isinstance(e, dict) and e.get("id")
        }
        async with db.begin_nested():
            await sync_many(db, "journal", by_source, user_id=user_id, prefix=f"{file_id}:")
    except Exception:  # noqa: BLE001
        logger.warning("recording journal mentions for %s failed", file_id, exc_info=True)


async def purge_sources(db: AsyncSession, source_kind: str, source_ids: Iterable[str | uuid.UUID]) -> None:
    """The sources are gone: drop every row they're part of (flushed)."""
    ids = [str(i) for i in source_ids]
    if not ids:
        return
    await db.execute(
        delete(EntityLink).where(
            or_(
                and_(EntityLink.source_kind == source_kind, EntityLink.source_id.in_(ids)),
                and_(EntityLink.target_kind == source_kind, EntityLink.target_id.in_(ids)),
            )
        )
    )
    await db.flush()


# ------------------------------------------------------------------ links


def canonical(a: Ref, b: Ref) -> tuple[Ref, Ref]:
    return (a, b) if a <= b else (b, a)


async def add_link(db: AsyncSession, user: User, a: Ref, b: Ref) -> EntityLink | None:
    """Link two things ``user`` can both see. None when either isn't visible
    (the caller answers 404 either way). Flushed; an existing link is reused."""
    a = (refs.store_kind(a[0]), refs.normalise(*a))
    b = (refs.store_kind(b[0]), refs.normalise(*b))
    if a == b:
        return None
    if await refs.resolve(db, user, *a) is None or await refs.resolve(db, user, *b) is None:
        return None
    (sk, sid), (tk, tid) = canonical(a, b)
    q = select(EntityLink).where(
        EntityLink.link_type == "link",
        EntityLink.source_kind == sk,
        EntityLink.source_id == sid,
        EntityLink.target_kind == tk,
        EntityLink.target_id == tid,
    )
    row = (await db.execute(q)).scalar_one_or_none()
    if row is None:
        await db.execute(
            pg_insert(EntityLink)
            .values(id=uuid.uuid4(), source_kind=sk, source_id=sid, target_kind=tk, target_id=tid, link_type="link", created_by=user.id)
            .on_conflict_do_nothing(constraint="uq_entity_links")
        )
        await db.flush()
        row = (await db.execute(q)).scalar_one()
    return row


async def can_remove(db: AsyncSession, user: User, row: EntityLink) -> bool:
    """Whoever can see both sides may take a link off (mentions follow their text)."""
    if row.link_type != "link":
        return False
    return (
        await refs.resolve(db, user, row.source_kind, row.source_id) is not None
        and await refs.resolve(db, user, row.target_kind, row.target_id) is not None
    )


# ------------------------------------------------------------------ lists


async def connections(db: AsyncSession, user: User, kind: str, id_: str) -> dict:
    """The "Mentioned in" and "Linked" lists for a thing ``user`` can see —
    only entries whose other side they can see too."""
    id_ = refs.normalise(kind, id_)
    kind = refs.store_kind(kind)
    rows = list(
        (
            await db.execute(
                select(EntityLink)
                .where(
                    or_(
                        and_(EntityLink.target_kind == kind, EntityLink.target_id == id_),
                        and_(EntityLink.source_kind == kind, EntityLink.source_id == id_, EntityLink.link_type == "link"),
                    )
                )
                .order_by(EntityLink.created_at.desc())
                .limit(MAX_LIST)
            )
        ).scalars()
    )
    cache: dict[Ref, dict | None] = {}

    async def look(r: Ref) -> dict | None:
        if r not in cache:
            cache[r] = await refs.resolve(db, user, *r)
        return cache[r]

    mentioned_in: list[dict] = []
    linked: list[dict] = []
    seen_href: set[str] = set()
    seen_linked: set[Ref] = set()
    for row in rows:
        here_is_target = row.target_kind == kind and row.target_id == id_
        other: Ref = (row.source_kind, row.source_id) if here_is_target else (row.target_kind, row.target_id)
        got = await look(other)
        if got is None:
            continue
        if row.link_type == "mention":
            key = got.get("href") or f"{other[0]}:{other[1]}"
            if key in seen_href:
                continue  # several messages of one chat read as one entry
            seen_href.add(key)
            mentioned_in.append({**got, "at": row.created_at.isoformat()})
        else:
            if other in seen_linked:
                continue
            seen_linked.add(other)
            # Seeing both sides is the rule for taking it off — and this
            # side is visible (the caller checked), the other just resolved.
            linked.append({**got, "link_id": str(row.id), "at": row.created_at.isoformat(), "can_remove": True})
    return {"mentioned_in": mentioned_in, "linked": linked}
