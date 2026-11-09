"""Notes — what the API does: create and edit notes, checklist items, each
person's own pin / archive / order / labels, sharing, versions, trash.

Callers load the note through :mod:`app.notes.access` first (404 for
anything the person can't open), then call in here; the router commits and
publishes the live event after.

Two counters on a note:

* ``revision`` — title, body, colour, kind, list options. A save names the
  revision it started from; a stale one is refused (:class:`Stale` → 409
  with the current note), unless it only repeats what's already there (a
  retry whose answer was lost), which succeeds without changing anything.
* ``change_seq`` — moves on every change, checklist items included. Items
  are their own rows with ids made by the client, so ticking, adding and
  reordering never conflict and a retried op never duplicates.
"""
from __future__ import annotations

import base64
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import String, and_, case, cast, delete, exists, func, literal, literal_column, or_, select, tuple_, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import access
from . import body as B
from .models import (
    COLORS,
    KINDS,
    SOURCES,
    Note,
    NoteAttachment,
    NoteItem,
    NoteMember,
    NoteUserState,
    NoteVersion,
)

MAX_ITEMS = 1000
MAX_MEMBERS = 50
MAX_LABELS = 50
VERSION_EVERY = timedelta(minutes=10)
VERSIONS_KEPT = 30
MAX_SEARCH_TEXT = 100_000
PREVIEW_ITEMS = 8
SNIPPET_CHARS = 1000
VIEWS = ("home", "archive", "trash", "reminders")
TYPES = ("list", "image", "voice", "shared", "reminder")
LIST_OPTS = ("hide_checked", "ticked_open")


class Stale(Exception):
    """A save started from an older revision (→ 409 with the current note)."""

    def __init__(self, note: Note) -> None:
        super().__init__("stale")
        self.note = note


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _top_position() -> float:
    """A new note goes first in your order (smaller is earlier)."""
    return -time.time()


def bad(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def display_title(note: Note) -> str:
    if note.title.strip():
        return note.title.strip()
    first = next((ln.strip() for ln in (note.body_text or "").split("\n") if ln.strip()), "")
    return first[:80] or "Untitled note"


# ------------------------------------------------------------------ helpers


async def items_of(db: AsyncSession, note_id: uuid.UUID) -> list[NoteItem]:
    return list(
        (
            await db.execute(
                select(NoteItem).where(NoteItem.note_id == note_id).order_by(NoteItem.position, NoteItem.created_at, NoteItem.id)
            )
        ).scalars()
    )


async def state_for(db: AsyncSession, note_id: uuid.UUID, user_id: uuid.UUID) -> NoteUserState:
    st = await db.get(NoteUserState, (note_id, user_id))
    if st is None:
        st = NoteUserState(note_id=note_id, user_id=user_id, position=_top_position())
        db.add(st)
        await db.flush()
    return st


def _bump(note: Note, user: User, *, revision: bool) -> None:
    if revision:
        note.revision += 1
    note.change_seq += 1
    note.updated_at = _now()
    note.edited_by = user.id


async def touch(db: AsyncSession, note: Note, user: User) -> None:
    """Something on the note changed that isn't its text (a picture or
    recording added or removed): it moves for everyone, edited by you."""
    _bump(note, user, revision=False)
    await _after_change(db, note, user)


async def _after_change(db: AsyncSession, note: Note, user: User) -> None:
    """Keep the derived bits in step: search text, mentions, and your own
    "seen" mark (your change isn't news to you)."""
    from app.links.service import sync_text

    items = await refresh_search_text(db, note)
    mention_text = json.dumps(note.body_doc or {}, ensure_ascii=False) + "\n" + "\n".join(i.text for i in items)
    await sync_text(db, "note", note.id, mention_text, user_id=user.id)
    st = await state_for(db, note.id, user.id)
    st.seen_seq = note.change_seq
    await db.flush()


async def refresh_search_text(db: AsyncSession, note: Note) -> list[NoteItem]:
    """Title, body, items and the transcripts of the recordings still in
    the note — what search reads. Returns the items (callers want them)."""
    from app.files.models import UserFile

    from .attachments import live_join

    items = await items_of(db, note.id)
    transcripts = (
        await db.execute(
            select(NoteAttachment.transcript)
            .join(UserFile, live_join())
            .where(NoteAttachment.note_id == note.id, NoteAttachment.transcript.is_not(None))
            .order_by(NoteAttachment.position)
        )
    ).scalars().all()
    parts = [note.title, note.body_text, *(i.text for i in items), *transcripts]
    note.search_text = "\n".join(p for p in parts if p)[:MAX_SEARCH_TEXT]
    return items


def _clean_list_opts(raw: dict[str, Any] | None) -> dict[str, bool]:
    out: dict[str, bool] = {}
    for k, v in (raw or {}).items():
        if k not in LIST_OPTS:
            raise bad("That list option isn't one Notes knows.")
        out[k] = bool(v)
    return out


async def _my_tag_ids(db: AsyncSession, user: User, tag_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    from app.tags.models import Tag

    ids = list(dict.fromkeys(tag_ids))
    if len(ids) > MAX_LABELS:
        raise bad("That's too many labels for one note.")
    if not ids:
        return []
    mine = set((await db.execute(select(Tag.id).where(Tag.user_id == user.id, Tag.id.in_(ids)))).scalars())
    if len(mine) != len(ids):
        raise bad("One of those labels isn't yours any more. Reload and try again.")
    return ids


# ------------------------------------------------------------------ versions


def _snapshot(note: Note, items: list[NoteItem]) -> dict[str, Any]:
    return {
        "title": note.title,
        "kind": note.kind,
        "body_doc": note.body_doc,
        "color": note.color,
        "list_opts": note.list_opts or {},
        "items": [
            {"id": str(i.id), "parent_id": str(i.parent_id) if i.parent_id else None, "text": i.text, "checked": i.checked, "position": i.position}
            for i in items
        ],
    }


async def save_version(db: AsyncSession, note: Note, user: User, reason: str = "edit") -> NoteVersion | None:
    """Keep how the note looks *now*, before a change. Edits keep at most one
    per 10 minutes (an empty note isn't worth keeping); a restore or an AI
    change always keeps one. Only the last 30 stay."""
    items = await items_of(db, note.id)
    if reason == "edit":
        last = await db.scalar(select(func.max(NoteVersion.created_at)).where(NoteVersion.note_id == note.id))
        if last is not None and _now() - last < VERSION_EVERY:
            return None
        if not note.title.strip() and not note.body_text.strip() and not items:
            return None
    v = NoteVersion(
        note_id=note.id, revision=note.revision, snapshot=_snapshot(note, items), reason=reason, made_by=user.id, created_at=_now()
    )
    db.add(v)
    await db.flush()
    keep = select(NoteVersion.id).where(NoteVersion.note_id == note.id).order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc()).limit(VERSIONS_KEPT)
    await db.execute(delete(NoteVersion).where(NoteVersion.note_id == note.id, NoteVersion.id.not_in(keep)))
    return v


async def list_versions(db: AsyncSession, note: Note) -> list[NoteVersion]:
    return list(
        (
            await db.execute(
                select(NoteVersion).where(NoteVersion.note_id == note.id).order_by(NoteVersion.created_at.desc(), NoteVersion.id.desc())
            )
        ).scalars()
    )


def version_out(v: NoteVersion, *, full: bool = False) -> dict[str, Any]:
    snap = v.snapshot or {}
    items = snap.get("items") or []
    out: dict[str, Any] = {
        "id": str(v.id),
        "revision": v.revision,
        "reason": v.reason,
        "made_by": str(v.made_by) if v.made_by else None,
        "created_at": v.created_at,
        "title": snap.get("title") or "",
        "kind": snap.get("kind") or "text",
        "preview": (B.doc_text(snap.get("body_doc")) or "\n".join(i.get("text", "") for i in items))[:300],
    }
    if full:
        out["snapshot"] = snap
    return out


async def restore_version(db: AsyncSession, user: User, note: Note, version_id: uuid.UUID) -> Note:
    v = await db.get(NoteVersion, version_id)
    if v is None or v.note_id != note.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That version isn't here.")
    snap = v.snapshot or {}
    await save_version(db, note, user, reason="restore")
    note.title = str(snap.get("title") or "")[:300]
    note.kind = snap.get("kind") if snap.get("kind") in KINDS else "text"
    note.body_doc = B.clean_doc(snap.get("body_doc"))
    note.body_text = B.doc_text(note.body_doc)
    note.color = snap.get("color") if snap.get("color") in COLORS else "default"
    note.list_opts = _clean_list_opts(snap.get("list_opts"))
    await db.execute(delete(NoteItem).where(NoteItem.note_id == note.id))
    await db.flush()
    parents: dict[uuid.UUID, uuid.UUID] = {}
    for raw in snap.get("items") or []:
        iid = uuid.UUID(raw["id"])
        db.add(NoteItem(
            id=iid, note_id=note.id, text=str(raw.get("text") or "")[:1000], checked=bool(raw.get("checked")),
            checked_at=_now() if raw.get("checked") else None, position=float(raw.get("position") or 0), created_by=user.id,
        ))
        if raw.get("parent_id"):
            parents[iid] = uuid.UUID(raw["parent_id"])
    await db.flush()
    for child, parent in parents.items():
        await db.execute(update(NoteItem).where(NoteItem.id == child, NoteItem.note_id == note.id).values(parent_id=parent))
    _bump(note, user, revision=True)
    await _after_change(db, note, user)
    return note


# ------------------------------------------------------------------ create


async def create(
    db: AsyncSession,
    user: User,
    *,
    note_id: uuid.UUID | None,
    kind: str = "text",
    title: str = "",
    body_doc: dict | None = None,
    text: str | None = None,
    items: list[dict] | None = None,
    color: str = "default",
    tag_ids: list[uuid.UUID] | None = None,
    pinned: bool = False,
    archived: bool = False,
    source: str = "web",
) -> tuple[Note, bool]:
    """A new note owned by ``user``. Returns (note, created): a retry with
    the same client id gets the note it already made."""
    if note_id is not None:
        existing = await db.get(Note, note_id)
        if existing is not None:
            if await access.can_open(db, user, existing):
                return existing, False
            raise access.not_found()
    if kind not in KINDS:
        raise bad("A note is text or a list.")
    if color not in COLORS:
        raise bad("Pick one of the note colours.")
    if source not in SOURCES:
        source = "web"
    items = list(items or [])
    if kind == "text":
        if items:
            raise bad("Only a list has items.")
        doc = B.clean_doc(body_doc) if body_doc is not None else B.text_doc(text or "")
        body_text = B.checked_text(B.doc_text(doc))
    else:
        if body_doc is not None:
            raise bad("A list has items, not text.")
        if not items and text:
            items = [{"text": ln.strip()} for ln in text.replace("\r", "\n").split("\n") if ln.strip()]
        doc, body_text = None, ""
    if len(items) > MAX_ITEMS:
        raise bad(f"A list can hold {MAX_ITEMS} items.")
    labels = await _my_tag_ids(db, user, tag_ids or [])

    note = Note(
        id=note_id or uuid.uuid4(), owner_id=user.id, kind=kind, title=(title or "")[:300], body_doc=doc, body_text=body_text,
        color=color, list_opts={}, source=source, edited_by=user.id,
    )
    try:
        async with db.begin_nested():
            db.add(note)
            await db.flush()
    except IntegrityError:
        # The same client id, made a moment ago by a parallel retry.
        existing = await db.get(Note, note.id)
        if existing is not None and await access.can_open(db, user, existing):
            return existing, False
        raise access.not_found() from None

    last_top: uuid.UUID | None = None
    for i, raw in enumerate(items):
        iid = raw.get("id") or uuid.uuid4()
        if await db.get(NoteItem, iid) is not None:
            raise bad("An item id was used twice. Make new ids and try again.")
        indent = bool(raw.get("indent")) and last_top is not None
        checked = bool(raw.get("checked"))
        db.add(NoteItem(
            id=iid, note_id=note.id, parent_id=last_top if indent else None, text=str(raw.get("text") or "")[:1000],
            checked=checked, checked_at=_now() if checked else None, checked_by=user.id if checked else None,
            position=float(i + 1), created_by=user.id,
        ))
        if not indent:
            last_top = iid
        await db.flush()

    from app.tags.models import TagAssignment

    for tid in labels:
        db.add(TagAssignment(tag_id=tid, user_id=user.id, entity_kind="note", entity_id=str(note.id)))
    st = await state_for(db, note.id, user.id)
    if archived:
        st.archived_at = _now()
    elif pinned:
        st.pinned, st.pinned_at = True, _now()
    await _after_change(db, note, user)
    return note, True


# ------------------------------------------------------------------ edit


def _differs(note: Note, changes: dict[str, Any]) -> bool:
    return any(getattr(note, k) != v for k, v in changes.items())


async def clean_changes(raw: dict[str, Any]) -> dict[str, Any]:
    """The fields of a note save, checked and normalised (body cleaned)."""
    out: dict[str, Any] = {}
    if "title" in raw and raw["title"] is not None:
        out["title"] = str(raw["title"])[:300]
    if "body_doc" in raw:
        out["body_doc"] = B.clean_doc(raw["body_doc"])
    elif raw.get("text") is not None:
        out["body_doc"] = B.text_doc(raw["text"])
    if "body_doc" in out:
        B.checked_text(B.doc_text(out["body_doc"]))
    if raw.get("color") is not None:
        if raw["color"] not in COLORS:
            raise bad("Pick one of the note colours.")
        out["color"] = raw["color"]
    if raw.get("kind") is not None:
        if raw["kind"] not in KINDS:
            raise bad("A note is text or a list.")
        out["kind"] = raw["kind"]
    if raw.get("list_opts") is not None:
        out["list_opts"] = _clean_list_opts(raw["list_opts"])
    return out


async def patch(
    db: AsyncSession, user: User, note: Note, base_revision: int, changes: dict[str, Any], *, reason: str = "edit"
) -> bool:
    """Save title / body / colour / kind / list options. Returns whether
    anything changed. Raises :class:`Stale` for an out-of-date save.
    ``reason="ai"``: an AI proposal being applied, so the note as it was is
    always kept as a version first (not just once per 10 minutes)."""
    if not _differs(note, changes):
        return False  # nothing new — also a retry whose answer was lost
    if base_revision != note.revision:
        raise Stale(note)
    await save_version(db, note, user, reason="ai" if reason == "ai" else "edit")
    new_kind = changes.pop("kind", note.kind)
    if new_kind != note.kind:
        await _convert(db, user, note, new_kind)
    if "body_doc" in changes:
        if note.kind == "list" and changes["body_doc"] is not None:
            raise bad("A list has items, not text.")
        note.body_doc = changes.pop("body_doc")
        note.body_text = B.doc_text(note.body_doc)
    for k, v in changes.items():
        setattr(note, k, v)
    _bump(note, user, revision=True)
    await _after_change(db, note, user)
    return True


async def _convert(db: AsyncSession, user: User, note: Note, kind: str) -> None:
    """Show checkboxes (text → list: a line each) or hide them (list → text:
    the items become lines; nothing is lost)."""
    if kind == "list":
        lines = [ln.strip() for ln in (note.body_text or "").split("\n") if ln.strip()]
        if len(lines) > MAX_ITEMS:
            raise bad(f"A list can hold {MAX_ITEMS} items.")
        top = await db.scalar(select(func.max(NoteItem.position)).where(NoteItem.note_id == note.id)) or 0.0
        for i, ln in enumerate(lines):
            db.add(NoteItem(note_id=note.id, text=ln[:1000], position=top + i + 1, created_by=user.id))
        note.body_doc, note.body_text = None, ""
    else:
        items = await items_of(db, note.id)
        lines = [("  " if i.parent_id else "") + i.text for i in items]
        text = "\n".join([*(note.body_text.split("\n") if note.body_text else []), *lines])
        note.body_doc = B.text_doc(B.checked_text(text))
        note.body_text = B.doc_text(note.body_doc)
        await db.execute(delete(NoteItem).where(NoteItem.note_id == note.id))
    note.kind = kind
    await db.flush()


# ------------------------------------------------------------------ items


def _need_list(note: Note) -> None:
    if note.kind != "list":
        raise bad("This note isn't a list. Show checkboxes first.")


def item_not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That item isn't on this note any more.")


async def _item_in(db: AsyncSession, note: Note, item_id: uuid.UUID | None) -> NoteItem | None:
    if item_id is None:
        return None
    it = await db.get(NoteItem, item_id)
    if it is None or it.note_id != note.id:
        raise item_not_found()
    return it


async def _renumber(db: AsyncSession, note_id: uuid.UUID) -> None:
    for i, it in enumerate(await items_of(db, note_id)):
        it.position = float(i + 1)
    await db.flush()


async def _position_after(db: AsyncSession, note: Note, after: NoteItem | None) -> float:
    if after is None:
        top = await db.scalar(select(func.max(NoteItem.position)).where(NoteItem.note_id == note.id))
        return (top or 0.0) + 1.0
    nxt = await db.scalar(
        select(func.min(NoteItem.position)).where(NoteItem.note_id == note.id, NoteItem.position > after.position)
    )
    if nxt is None:
        return after.position + 1.0
    if nxt - after.position < 1e-6:
        await _renumber(db, note.id)
        return await _position_after(db, note, after)
    return (after.position + nxt) / 2


async def _check_parent(db: AsyncSession, note: Note, item_id: uuid.UUID, parent_id: uuid.UUID | None) -> None:
    """One level of indent: the parent is a top-level item on this note, and
    an item with its own children can't be indented."""
    if parent_id is None:
        return
    if parent_id == item_id:
        raise bad("An item can't sit under itself.")
    parent = await _item_in(db, note, parent_id)
    if parent is None or parent.parent_id is not None:
        raise bad("Lists go one level deep.")
    has_kids = await db.scalar(select(exists().where(NoteItem.parent_id == item_id)))
    if has_kids:
        raise bad("Lists go one level deep.")


async def add_item(
    db: AsyncSession, user: User, note: Note, *, item_id: uuid.UUID, text: str, after_id: uuid.UUID | None = None,
    parent_id: uuid.UUID | None = None, checked: bool = False,
) -> tuple[NoteItem, bool]:
    """Add an item (below ``after_id``, else at the end). A retry with the
    same id returns the item it already made."""
    _need_list(note)
    existing = await db.get(NoteItem, item_id)
    if existing is not None:
        if existing.note_id != note.id:
            raise item_not_found()
        return existing, False
    count = await db.scalar(select(func.count()).select_from(NoteItem).where(NoteItem.note_id == note.id)) or 0
    if count >= MAX_ITEMS:
        raise bad(f"A list can hold {MAX_ITEMS} items.")
    after = await _item_in(db, note, after_id)
    await _check_parent(db, note, item_id, parent_id)
    await save_version(db, note, user)
    pos = await _position_after(db, note, after)
    it = NoteItem(
        id=item_id, note_id=note.id, parent_id=parent_id, text=text[:1000], checked=checked, position=pos, created_by=user.id,
        checked_at=_now() if checked else None, checked_by=user.id if checked else None,
    )
    db.add(it)
    await db.flush()
    _bump(note, user, revision=False)
    await _after_change(db, note, user)
    return it, True


async def update_item(db: AsyncSession, user: User, note: Note, item_id: uuid.UUID, fields: dict[str, Any]) -> tuple[NoteItem, bool]:
    """Change an item's text, tick, indent or place. Repeating a change
    that's already there changes nothing."""
    _need_list(note)
    it = await _item_in(db, note, item_id)
    assert it is not None
    changed = False
    if "parent_id" in fields and fields["parent_id"] != it.parent_id:
        await _check_parent(db, note, it.id, fields["parent_id"])
    want = {k: v for k, v in fields.items() if getattr(it, k) != v}
    if not want:
        return it, False
    await save_version(db, note, user)
    for k, v in want.items():
        if k == "text":
            it.text = str(v)[:1000]
        elif k == "checked":
            it.checked = bool(v)
            it.checked_at = _now() if v else None
            it.checked_by = user.id if v else None
        elif k == "position":
            it.position = float(v)
        elif k == "parent_id":
            it.parent_id = v
        changed = True
    it.updated_at = _now()
    await db.flush()
    _bump(note, user, revision=False)
    await _after_change(db, note, user)
    return it, changed


async def delete_item(db: AsyncSession, user: User, note: Note, item_id: uuid.UUID) -> bool:
    """Remove an item (its children move up a level). Already gone is fine."""
    _need_list(note)
    it = await db.get(NoteItem, item_id)
    if it is None:
        return False
    if it.note_id != note.id:
        raise item_not_found()
    await save_version(db, note, user)
    await db.execute(update(NoteItem).where(NoteItem.parent_id == it.id).values(parent_id=None))
    await db.delete(it)
    await db.flush()
    _bump(note, user, revision=False)
    await _after_change(db, note, user)
    return True


async def bulk_items(db: AsyncSession, user: User, note: Note, action: str) -> bool:
    """Untick all, delete ticked items, or sort A–Z (children stay with
    their parent)."""
    _need_list(note)
    items = await items_of(db, note.id)
    if action == "untick_all":
        if not any(i.checked for i in items):
            return False
        await save_version(db, note, user)
        await db.execute(
            update(NoteItem).where(NoteItem.note_id == note.id, NoteItem.checked.is_(True)).values(
                checked=False, checked_at=None, checked_by=None, updated_at=_now()
            )
        )
    elif action == "delete_ticked":
        gone = [i.id for i in items if i.checked]
        if not gone:
            return False
        await save_version(db, note, user)
        await db.execute(update(NoteItem).where(NoteItem.parent_id.in_(gone)).values(parent_id=None))
        await db.execute(delete(NoteItem).where(NoteItem.id.in_(gone)))
    elif action == "sort":
        tops = sorted((i for i in items if i.parent_id is None), key=lambda i: (i.text.casefold(), i.position))
        kids: dict[uuid.UUID, list[NoteItem]] = {}
        for i in items:
            if i.parent_id is not None:
                kids.setdefault(i.parent_id, []).append(i)
        order = [x for t in tops for x in (t, *kids.get(t.id, []))]
        if [i.id for i in order] == [i.id for i in items]:
            return False
        await save_version(db, note, user)
        for n, it in enumerate(order):
            it.position = float(n + 1)
    else:
        raise bad("That isn't something Notes can do to a list.")
    await db.flush()
    _bump(note, user, revision=False)
    await _after_change(db, note, user)
    return True


def item_out(it: NoteItem) -> dict[str, Any]:
    return {
        "id": str(it.id),
        "parent_id": str(it.parent_id) if it.parent_id else None,
        "text": it.text,
        "checked": it.checked,
        "checked_at": it.checked_at,
        "checked_by": str(it.checked_by) if it.checked_by else None,
        "position": it.position,
        "created_by": str(it.created_by) if it.created_by else None,
        "updated_at": it.updated_at,
    }


# ------------------------------------------------------------------ yours


async def set_state(
    db: AsyncSession, user: User, note: Note, *, pinned: bool | None = None, archived: bool | None = None,
    position: float | None = None, seen: bool | None = None,
) -> NoteUserState:
    """Your own pin, archive, place in your order, and "seen it"."""
    st = await state_for(db, note.id, user.id)
    if archived is not None:
        if archived and st.archived_at is None:
            st.archived_at = _now()
            st.pinned, st.pinned_at = False, None  # as in Keep: archiving unpins
        elif not archived:
            st.archived_at = None
    if pinned is not None and pinned != st.pinned:
        st.pinned, st.pinned_at = pinned, (_now() if pinned else None)
        if pinned:
            st.archived_at = None  # pinning an archived note brings it back
    if position is not None:
        st.position = float(position)
    if seen:
        st.seen_seq = note.change_seq
    await db.flush()
    return st


def state_out(st: NoteUserState | None) -> dict[str, Any]:
    return {
        "pinned": bool(st and st.pinned),
        "archived": bool(st and st.archived_at),
        "archived_at": st.archived_at if st else None,
        "position": st.position if st else 0.0,
        "seen_seq": st.seen_seq if st else 0,
    }


async def set_labels(db: AsyncSession, user: User, note: Note, tag_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """Make your labels on this note exactly ``tag_ids`` (your own #tags)."""
    from app.tags.models import TagAssignment

    want = set(await _my_tag_ids(db, user, tag_ids))
    rows = (
        await db.execute(
            select(TagAssignment).where(
                TagAssignment.user_id == user.id, TagAssignment.entity_kind == "note", TagAssignment.entity_id == str(note.id)
            )
        )
    ).scalars().all()
    have = set()
    for a in rows:
        if a.tag_id in want:
            have.add(a.tag_id)
        else:
            await db.delete(a)
    for tid in want - have:
        db.add(TagAssignment(tag_id=tid, user_id=user.id, entity_kind="note", entity_id=str(note.id)))
    await db.flush()
    return (await _labels(db, user, [note.id])).get(note.id, [])


async def add_label(db: AsyncSession, user: User, note: Note, tag_id: uuid.UUID, *, on: bool) -> None:
    from app.tags.models import TagAssignment

    await _my_tag_ids(db, user, [tag_id])
    cond = (
        TagAssignment.tag_id == tag_id, TagAssignment.user_id == user.id, TagAssignment.entity_kind == "note",
        TagAssignment.entity_id == str(note.id),
    )
    have = await db.scalar(select(TagAssignment.id).where(*cond))
    if on and have is None:
        db.add(TagAssignment(tag_id=tag_id, user_id=user.id, entity_kind="note", entity_id=str(note.id)))
    elif not on and have is not None:
        await db.execute(delete(TagAssignment).where(*cond))
    await db.flush()


async def _labels(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, Any]]]:
    from app.tags.models import Tag, TagAssignment

    if not ids:
        return {}
    rows = (
        await db.execute(
            select(TagAssignment.entity_id, Tag)
            .join(Tag, Tag.id == TagAssignment.tag_id)
            .where(
                TagAssignment.user_id == user.id,
                TagAssignment.entity_kind == "note",
                TagAssignment.entity_id.in_([str(i) for i in ids]),
            )
            .order_by(func.lower(Tag.name))
        )
    ).all()
    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for eid, t in rows:
        out.setdefault(uuid.UUID(eid), []).append({"id": str(t.id), "name": t.name, "color": t.color})
    return out


async def label_counts(db: AsyncSession, user: User) -> list[dict[str, Any]]:
    """Your #tags that are on notes you can open, each with how many."""
    from app.tags.models import Tag, TagAssignment

    rows = (
        await db.execute(
            select(Tag, func.count(Note.id))
            .join(TagAssignment, TagAssignment.tag_id == Tag.id)
            .join(Note, cast(Note.id, String) == TagAssignment.entity_id)
            .where(Tag.user_id == user.id, TagAssignment.entity_kind == "note", access.visible_predicate(user.id))
            .group_by(Tag.id)
            .order_by(func.lower(Tag.name))
        )
    ).all()
    return [{"id": str(t.id), "name": t.name, "color": t.color, "count": n} for t, n in rows]


# ------------------------------------------------------------------ sharing


async def members_of(db: AsyncSession, note: Note) -> list[NoteMember]:
    return list(
        (await db.execute(select(NoteMember).where(NoteMember.note_id == note.id).order_by(NoteMember.added_at))).scalars()
    )


async def add_members(db: AsyncSession, user: User, note: Note, user_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Share the note with people on this server (owner only). Returns who
    was newly added."""
    if note.owner_id != user.id:
        raise forbidden("Only the note's owner can share it.")
    have = {m.user_id for m in await members_of(db, note)}
    new: list[uuid.UUID] = []
    for uid in dict.fromkeys(user_ids):
        if uid == note.owner_id or uid in have:
            continue
        u = await db.get(User, uid)
        if u is None or u.disabled:
            raise bad("Pick people who use this Promptly.")
        if await access.sharing_refused(db, note.owner_id, uid):
            raise bad(await access.refusal(db, note.owner_id, u))
        new.append(uid)
    if len(have) + len(new) > MAX_MEMBERS:
        raise bad(f"A note can be shared with up to {MAX_MEMBERS} people.")
    for uid in new:
        db.add(NoteMember(note_id=note.id, user_id=uid, added_by=user.id, added_at=_now()))
        st = await db.get(NoteUserState, (note.id, uid))
        if st is None:
            db.add(NoteUserState(note_id=note.id, user_id=uid, position=_top_position(), seen_seq=0))
    await db.flush()
    return new


async def remove_member(db: AsyncSession, user: User, note: Note, member_id: uuid.UUID) -> None:
    """The owner removes someone, or a member leaves (their own id). What
    was theirs on it — pin, order, labels, reminder link — goes with them."""
    from app.tags.models import TagAssignment

    if member_id != user.id and note.owner_id != user.id:
        raise forbidden("Only the note's owner can remove people.")
    if member_id == note.owner_id:
        raise bad("The owner can't leave their own note. Delete it instead.")
    m = await db.get(NoteMember, (note.id, member_id))
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="They don't have this note.")
    await db.delete(m)
    await db.execute(delete(NoteUserState).where(NoteUserState.note_id == note.id, NoteUserState.user_id == member_id))
    from .reminders import clear_for

    await clear_for(db, member_id, note.id)
    await db.execute(
        delete(TagAssignment).where(
            TagAssignment.user_id == member_id, TagAssignment.entity_kind == "note", TagAssignment.entity_id == str(note.id)
        )
    )
    await db.flush()


# ------------------------------------------------------------------ trash


async def trash(db: AsyncSession, user: User, note: Note) -> None:
    """Owner only: into Trash for 30 days. Collaborators lose it at once."""
    if note.owner_id != user.id:
        raise forbidden("Only the note's owner can delete it.")
    note.trashed_at = _now()
    note.trashed_by = user.id
    await db.flush()


async def restore(db: AsyncSession, user: User, note: Note) -> None:
    note.trashed_at = None
    note.trashed_by = None
    st = await state_for(db, note.id, user.id)
    st.position = _top_position()
    await db.flush()


async def purge(db: AsyncSession, notes: list[Note]) -> int:
    """Delete notes for good, with every label and link that pointed at
    them. (Attachments stay as files in their adders' Drive.)"""
    from app.links.service import purge_sources
    from app.tags.models import TagAssignment

    ids = [n.id for n in notes]
    if not ids:
        return 0
    from .reminders import clear_all

    await clear_all(db, ids)
    await db.execute(
        delete(TagAssignment).where(TagAssignment.entity_kind == "note", TagAssignment.entity_id.in_([str(i) for i in ids]))
    )
    await purge_sources(db, "note", ids)
    await db.execute(delete(Note).where(Note.id.in_(ids)))
    await db.flush()
    return len(ids)


async def trashed_notes(db: AsyncSession, user: User) -> list[Note]:
    return list(
        (
            await db.execute(
                select(Note).where(Note.owner_id == user.id, Note.trashed_at.is_not(None)).order_by(Note.trashed_at.desc())
            )
        ).scalars()
    )


async def purge_expired(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Notes 30+ days in Trash (the nightly storage maintenance)."""
    from app.trash.service import RETENTION_DAYS

    cutoff = (now or _now()) - timedelta(days=RETENTION_DAYS)
    rows = list((await db.execute(select(Note).where(Note.trashed_at.is_not(None), Note.trashed_at < cutoff))).scalars())
    return await purge(db, rows)


# ------------------------------------------------------------------ reading


async def _cards(db: AsyncSession, user: User, notes: list[Note]) -> tuple[list[dict[str, Any]], set[uuid.UUID]]:
    """Grid cards for ``notes`` as ``user`` sees them, and the people named."""
    if not notes:
        return [], set()
    ids = [n.id for n in notes]
    states = {
        s.note_id: s
        for s in (await db.execute(select(NoteUserState).where(NoteUserState.user_id == user.id, NoteUserState.note_id.in_(ids)))).scalars()
    }
    counts: dict[uuid.UUID, list[int]] = {}
    for nid, checked, n in (
        await db.execute(
            select(NoteItem.note_id, NoteItem.checked, func.count()).where(NoteItem.note_id.in_(ids)).group_by(NoteItem.note_id, NoteItem.checked)
        )
    ).all():
        counts.setdefault(nid, [0, 0])[1 if checked else 0] += n
    rn = func.row_number().over(partition_by=NoteItem.note_id, order_by=(NoteItem.position, NoteItem.id)).label("rn")
    sub = select(NoteItem.id, rn).where(NoteItem.note_id.in_(ids), NoteItem.checked.is_(False)).subquery()
    preview: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for it in (
        await db.execute(
            select(NoteItem).join(sub, sub.c.id == NoteItem.id).where(sub.c.rn <= PREVIEW_ITEMS).order_by(NoteItem.position, NoteItem.id)
        )
    ).scalars():
        preview.setdefault(it.note_id, []).append(
            {"id": str(it.id), "parent_id": str(it.parent_id) if it.parent_id else None, "text": it.text, "checked": it.checked}
        )
    members: dict[uuid.UUID, list[uuid.UUID]] = {}
    for nid, uid in (
        await db.execute(select(NoteMember.note_id, NoteMember.user_id).where(NoteMember.note_id.in_(ids)).order_by(NoteMember.added_at))
    ).all():
        members.setdefault(nid, []).append(uid)
    from app.files.models import UserFile

    from . import attachments as A

    att: dict[uuid.UUID, dict[str, int]] = {}
    for nid, kind, n, ms in (
        await db.execute(
            select(NoteAttachment.note_id, NoteAttachment.kind, func.count(), func.coalesce(func.sum(NoteAttachment.duration_ms), 0))
            .join(UserFile, A.live_join())
            .where(NoteAttachment.note_id.in_(ids))
            .group_by(NoteAttachment.note_id, NoteAttachment.kind)
        )
    ).all():
        a = att.setdefault(nid, {"images": 0, "audio": 0, "audio_ms": 0})
        if kind == "image":
            a["images"] = n
        else:
            a["audio"], a["audio_ms"] = n, int(ms or 0)
    from .reminders import live_for

    reminders = await live_for(db, user, ids)
    labels = await _labels(db, user, ids)
    covers = await A.covers(db, user, ids) if any(a.get("images") for a in att.values()) else {}

    people: set[uuid.UUID] = set()
    out: list[dict[str, Any]] = []
    for n in notes:
        st = states.get(n.id)
        mem = members.get(n.id, [])
        people.add(n.owner_id)
        people.update(mem)
        if n.edited_by:
            people.add(n.edited_by)
        c = counts.get(n.id, [0, 0])
        out.append({
            "id": str(n.id),
            "kind": n.kind,
            "title": n.title,
            "snippet": n.body_text[:SNIPPET_CHARS],
            "color": n.color,
            "list_opts": n.list_opts or {},
            "items": preview.get(n.id, []),
            "items_total": c[0] + c[1],
            "items_checked": c[1],
            **state_out(st),
            "labels": labels.get(n.id, []),
            "owner_id": str(n.owner_id),
            "is_owner": n.owner_id == user.id,
            "member_ids": [str(u) for u in mem],
            "shared": bool(mem),
            "attachments": att.get(n.id, {"images": 0, "audio": 0, "audio_ms": 0}),
            "covers": covers.get(n.id, []),
            "has_reminder": n.id in reminders,
            "reminder": reminders.get(n.id),
            "changed": bool(st and st.seen_seq < n.change_seq and n.edited_by not in (None, user.id)),
            "revision": n.revision,
            "change_seq": n.change_seq,
            "source": n.source,
            "created_at": n.created_at,
            "updated_at": n.updated_at,
            "edited_by": str(n.edited_by) if n.edited_by else None,
            "trashed_at": n.trashed_at,
            "doc_file_id": str(n.doc_file_id) if n.doc_file_id else None,
        })
    return out, people


async def users_map(db: AsyncSession, ids: set[uuid.UUID]) -> dict[str, dict]:
    from app.rooms.core import users_map as room_users

    return await room_users(db, ids)


async def full_out(db: AsyncSession, user: User, note: Note) -> dict[str, Any]:
    """The whole note as ``user`` sees it."""
    cards, people = await _cards(db, user, [note])
    out = cards[0]
    from . import attachments as A
    from . import transcription

    items = await items_of(db, note.id)
    atts = await A.for_note(db, user, note)
    mems = await members_of(db, note)
    out.update({
        "snippet": None,
        "body_doc": note.body_doc,
        "body_text": note.body_text,
        "items": [item_out(i) for i in items],
        "attachments": atts,
        "transcription": (await transcription.config(db)).on,
        "members": [
            {"user_id": str(m.user_id), "added_by": str(m.added_by) if m.added_by else None, "added_at": m.added_at} for m in mems
        ],
        # Open as document: the card that opens it (None if you can't).
        "document": await _document_card(db, user, note),
        "can": {
            "edit": note.trashed_at is None,
            "share": note.owner_id == user.id and note.trashed_at is None,
            "delete": note.owner_id == user.id,
            "leave": note.owner_id != user.id,
        },
    })
    people.update(uuid.UUID(a["added_by"]) for a in atts if a["added_by"])
    out["users"] = await users_map(db, people)
    return out


async def _document_card(db: AsyncSession, user: User, note: Note) -> dict[str, Any] | None:
    from .convert import document_card

    return await document_card(db, user, note)


async def _reminder_ids(db: AsyncSession, user: User) -> list[uuid.UUID]:
    """Notes with a reminder of yours that's still to come (read from Tasks)."""
    from .reminders import live_note_ids

    return await live_note_ids(db, user) or [uuid.UUID(int=0)]


def _encode_cursor(view: str, key: list[Any]) -> str:
    raw = json.dumps({"v": view, "k": key}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None, view: str) -> list[Any] | None:
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if data["v"] != view or not isinstance(data["k"], list):
            raise ValueError("cursor from another view")
        return data["k"]
    except (ValueError, KeyError, TypeError):
        raise bad("That page link is out of date. Reload your notes.") from None


async def list_cards(
    db: AsyncSession,
    user: User,
    *,
    view: str = "home",
    label: uuid.UUID | None = None,
    color: str | None = None,
    type_: str | None = None,
    q: str | None = None,
    cursor: str | None = None,
    limit: int = 60,
) -> dict[str, Any]:
    """A page of cards: pinned first, then your own order (Trash: newest
    deleted first). Filters narrow it; nothing outside what you can open
    is ever looked at."""
    from app.files.search_query import drive_tsquery
    from app.tags.models import TagAssignment

    if view not in VIEWS:
        raise bad("Pick home, archive, reminders or trash.")
    st = NoteUserState
    stmt = select(Note).outerjoin(st, and_(st.note_id == Note.id, st.user_id == user.id))
    if view == "trash":
        stmt = stmt.where(Note.owner_id == user.id, Note.trashed_at.is_not(None))
    else:
        stmt = stmt.where(access.visible_predicate(user.id))
        if view == "home":
            stmt = stmt.where(st.archived_at.is_(None))
        elif view == "archive":
            stmt = stmt.where(st.archived_at.is_not(None))
        else:
            stmt = stmt.where(Note.id.in_(await _reminder_ids(db, user)))
    if color:
        if color not in COLORS:
            raise bad("Pick one of the note colours.")
        stmt = stmt.where(Note.color == color)
    if label is not None:
        stmt = stmt.where(
            exists().where(
                TagAssignment.tag_id == label, TagAssignment.user_id == user.id, TagAssignment.entity_kind == "note",
                TagAssignment.entity_id == cast(Note.id, String),
            )
        )
    if type_:
        if type_ not in TYPES:
            raise bad("Pick lists, images, voice, shared or reminders.")
        if type_ == "list":
            stmt = stmt.where(Note.kind == "list")
        elif type_ in ("image", "voice"):
            from app.files.models import UserFile

            from .attachments import live_join

            k = "image" if type_ == "image" else "audio"
            stmt = stmt.where(exists(select(NoteAttachment.id).join(UserFile, live_join()).where(NoteAttachment.note_id == Note.id, NoteAttachment.kind == k)))
        elif type_ == "shared":
            stmt = stmt.where(or_(Note.owner_id != user.id, exists().where(NoteMember.note_id == Note.id)))
        else:
            stmt = stmt.where(Note.id.in_(await _reminder_ids(db, user)))
    if q and q.strip():
        term = q.strip()[:200]
        pat = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(or_(literal_column("notes.tsv").op("@@")(drive_tsquery(term)), Note.title.ilike(pat, escape="\\")))

    limit = max(1, min(limit, 200))
    after = _decode_cursor(cursor, view)
    if view == "trash":
        if after is not None:
            t, i = datetime.fromisoformat(after[0]), uuid.UUID(after[1])
            stmt = stmt.where(tuple_(Note.trashed_at, Note.id) < tuple_(literal(t), literal(i)))
        stmt = stmt.order_by(Note.trashed_at.desc(), Note.id.desc())
    else:
        rank = case((func.coalesce(st.pinned, False), 0), else_=1)
        pos = func.coalesce(st.position, 0.0)
        if after is not None:
            stmt = stmt.where(tuple_(rank, pos, Note.id) > tuple_(literal(int(after[0])), literal(float(after[1])), literal(uuid.UUID(after[2]))))
        stmt = stmt.order_by(rank, pos, Note.id)
    rows = list((await db.execute(stmt.limit(limit + 1))).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    cards, people = await _cards(db, user, rows)
    nxt = None
    if more and rows:
        last, card = rows[-1], cards[-1]
        if view == "trash":
            nxt = _encode_cursor(view, [last.trashed_at.isoformat(), str(last.id)])
        else:
            nxt = _encode_cursor(view, [0 if card["pinned"] else 1, card["position"], str(last.id)])
    return {"notes": cards, "next_cursor": nxt, "users": await users_map(db, people)}


__all__ = [
    "MAX_ITEMS", "MAX_MEMBERS", "Stale", "add_item", "add_label", "add_members", "bulk_items", "clean_changes", "create",
    "delete_item", "display_title", "full_out", "item_out", "label_counts", "list_cards", "list_versions", "members_of",
    "patch", "purge", "purge_expired", "refresh_search_text", "touch", "remove_member", "restore", "restore_version", "save_version", "set_labels",
    "set_state", "state_out", "trash", "trashed_notes", "update_item", "version_out",
]
