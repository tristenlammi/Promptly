"""Item Store apps' own tags ↔ the shared set.

Tasks, Contacts, Journal, Recipes (Meal plan) and Budget already keep tags
as strings on their things, inside their JSON file. That stays the source
of truth — nothing about their storage changes. Instead:

* every save of one of those files (:func:`sync_file`, called from
  :func:`app.items.service.save_data` / ``create_item``) makes sure the
  owner has a shared tag for each name and that ``tag_assignments`` lists
  exactly the things in the file that carry it;
* a person's files made before shared tags existed are mirrored once, the
  first time they open Tags or search (:func:`ensure_backfill`);
* renaming, merging or deleting a shared tag rewrites the name inside the
  person's own files (:func:`rewrite_names`) through the normal save path,
  so the app sees the same tags the Tags page does.

Left out on purpose: Flashcards (Anki imports bring thousands of machine
tags like ``leech`` / ``bio::cells`` that would swamp the list), Health
symptom factors (sensitive, and context rather than an organising tag) and
Board game categories (catalogue data, not the person's tags).
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.tags.items")

# Bump to mirror everyone's files again (e.g. after adding a source).
BACKFILL_VERSION = 1


@dataclass(frozen=True)
class Source:
    item_kind: str  # the Item Store kind
    entity_kind: str  # what tag_assignments calls one of its things
    label: str  # shown on the tag page
    collection: str  # the list in the file's JSON
    title: Callable[[dict], str]
    url: Callable[[uuid.UUID, dict], str]

    def things(self, data: dict) -> Iterator[dict]:
        for thing in (data or {}).get(self.collection) or []:
            if isinstance(thing, dict) and thing.get("id"):
                yield thing


def _contact_name(c: dict) -> str:
    try:
        from app.items.kinds.contacts.logic import display_name

        return display_name(c)
    except Exception:  # noqa: BLE001
        return " ".join(x for x in (c.get("first", ""), c.get("last", "")) if x) or "Contact"


SOURCES: dict[str, Source] = {
    s.item_kind: s
    for s in (
        Source("tasks", "task", "Task", "tasks", lambda t: t.get("title") or "Task", lambda f, t: f"/apps/tasks/{f}"),
        Source("contacts", "contact", "Contact", "contacts", _contact_name, lambda f, c: f"/apps/contacts/{f}?c={c['id']}"),
        Source(
            "journal", "journal_entry", "Journal entry", "entries",
            lambda e: e.get("title") or f"Entry {e.get('date', '')}".strip(), lambda f, e: f"/apps/journal/{f}",
        ),
        Source("mealplan", "recipe", "Recipe", "recipes", lambda r: r.get("title") or "Recipe", lambda f, r: f"/apps/mealplan/{f}"),
        Source(
            "budget", "transaction", "Transaction", "transactions",
            lambda t: " · ".join(x for x in (t.get("payee") or t.get("description") or "Transaction", t.get("date", "")) if x),
            lambda f, t: f"/apps/budget/{f}",
        ),
    )
}
BY_ENTITY: dict[str, Source] = {s.entity_kind: s for s in SOURCES.values()}


def item_entity_id(file_id: uuid.UUID | str, sub_id: str) -> str:
    return f"{file_id}:{sub_id}"


def split_entity_id(entity_id: str) -> tuple[uuid.UUID, str]:
    """``"<file_id>:<id>"`` → (file id, id inside the file). ValueError if not."""
    head, _, sub = (entity_id or "").partition(":")
    if not sub:
        raise ValueError("not an item thing id")
    return uuid.UUID(head), sub


def norm(name: str) -> str:
    """The shared spelling rule: trimmed, no leading #/@, single spaces, ≤40."""
    return " ".join(str(name or "").strip().lstrip("#@").split())[:40].strip()


def key(name: str) -> str:
    return norm(name).casefold()


# ------------------------------------------------------------------ tags


async def tag_ids_for(db: AsyncSession, user_id: uuid.UUID, names: list[str]) -> dict[str, uuid.UUID]:
    """casefolded name → tag id for ``names``, creating the ones the person
    doesn't have yet (first spelling wins)."""
    wanted: dict[str, str] = {}
    for n in names:
        clean = norm(n)
        if clean and clean.casefold() not in wanted:
            wanted[clean.casefold()] = clean
    if not wanted:
        return {}
    from app.tags.models import Tag

    have = {
        t.name.casefold(): t.id
        for t in (await db.execute(select(Tag).where(Tag.user_id == user_id))).scalars()
    }
    missing = [v for k, v in wanted.items() if k not in have]
    if missing:
        for name in missing:
            # ON CONFLICT on the lower(name) unique index: two saves at once
            # agree on one tag.
            await db.execute(
                text(
                    "INSERT INTO tags (id, user_id, name) VALUES (:id, :uid, :name) "
                    "ON CONFLICT (user_id, lower(name)) DO NOTHING"
                ),
                {"id": uuid.uuid4(), "uid": user_id, "name": name},
            )
        rows = (
            await db.execute(
                select(Tag.id, Tag.name).where(Tag.user_id == user_id)
            )
        ).all()
        have = {n.casefold(): i for i, n in rows}
    return {k: have[k] for k in wanted if k in have}


# ------------------------------------------------------------------ sync


async def sync_file(db: AsyncSession, file_id: uuid.UUID, owner_id: uuid.UUID | None, kind: str, data: dict) -> None:
    """Make ``tag_assignments`` for this item file match its JSON (flushed).
    Never raises — a tagging hiccup mustn't block the app's save."""
    src = SOURCES.get(kind)
    if src is None or owner_id is None:
        return
    try:
        async with db.begin_nested():
            await _sync(db, src, file_id, owner_id, data)
    except Exception:  # noqa: BLE001
        logger.exception("tag sync failed for %s %s", kind, file_id)


async def _sync(db: AsyncSession, src: Source, file_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> None:
    from app.tags.models import TagAssignment

    names: list[str] = []
    per_thing: dict[str, set[str]] = {}
    for thing in src.things(data):
        keys = set()
        for t in thing.get("tags") or []:
            if isinstance(t, str) and norm(t):
                names.append(t)
                keys.add(key(t))
        if keys:
            per_thing[item_entity_id(file_id, str(thing["id"]))] = keys
    ids = await tag_ids_for(db, owner_id, names)
    want = {(ids[k], eid) for eid, ks in per_thing.items() for k in ks if k in ids}
    rows = (
        await db.execute(
            select(TagAssignment.id, TagAssignment.tag_id, TagAssignment.entity_id).where(
                TagAssignment.file_id == file_id, TagAssignment.entity_kind == src.entity_kind
            )
        )
    ).all()
    have = {(tid, eid): aid for aid, tid, eid in rows}
    gone = [aid for pair, aid in have.items() if pair not in want]
    if gone:
        await db.execute(delete(TagAssignment).where(TagAssignment.id.in_(gone)))
    for tid, eid in want - set(have):
        db.add(
            TagAssignment(
                tag_id=tid, user_id=owner_id, entity_kind=src.entity_kind, entity_id=eid, file_id=file_id
            )
        )
    await db.flush()


async def ensure_backfill(db: AsyncSession, user) -> None:  # noqa: ANN001
    """Mirror this person's existing app files once (per BACKFILL_VERSION)."""
    from app.auth.models import User

    current = await db.scalar(select(User.settings["tags_backfill"].as_integer()).where(User.id == user.id))
    if current is not None and current >= BACKFILL_VERSION:
        return
    from app.files.models import UserFile
    from app.items.models import ItemDocument

    rows = (
        await db.execute(
            select(UserFile.id, ItemDocument.kind, ItemDocument.data)
            .join(ItemDocument, ItemDocument.file_id == UserFile.id)
            .where(UserFile.user_id == user.id, ItemDocument.kind.in_(list(SOURCES)))
        )
    ).all()
    for fid, kind, data in rows:
        await sync_file(db, fid, user.id, kind, data or {})
    # One atomic jsonb merge: never rewrites the rest of settings.
    await db.execute(
        text(
            "UPDATE users SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tags_backfill', CAST(:v AS integer)) "
            "WHERE id = :uid"
        ),
        {"v": BACKFILL_VERSION, "uid": user.id},
    )
    await db.commit()


# ------------------------------------------------------------- write back


def _replace(tags: list, old_keys: set[str], new: str | None) -> list | None:
    """``tags`` with any of ``old_keys`` replaced by ``new`` (None removes),
    deduplicated; None when nothing changed."""
    if not any(isinstance(t, str) and key(t) in old_keys for t in tags):
        return None
    out: list = []
    seen: set[str] = set()
    for t in tags:
        if not isinstance(t, str):
            continue
        v = new if key(t) in old_keys else t
        if v is None or key(v) in seen:
            continue
        seen.add(key(v))
        out.append(v)
    return out


async def rewrite_names(db: AsyncSession, user, old_names: list[str], new: str | None) -> int:  # noqa: ANN001
    """Rename (``new``) or remove (None) tags inside this person's own app
    files, through the normal save path. Returns the files changed."""
    from app.files.models import UserFile
    from app.items import service as items
    from app.items.models import ItemDocument

    old_keys = {key(n) for n in old_names if key(n)}
    if not old_keys:
        return 0
    rows = (
        await db.execute(
            select(UserFile.id)
            .join(ItemDocument, ItemDocument.file_id == UserFile.id)
            .where(UserFile.user_id == user.id, ItemDocument.kind.in_(list(SOURCES)))
        )
    ).scalars().all()
    changed = 0
    for fid in rows:
        row = await db.get(UserFile, fid)
        doc = (
            await db.execute(
                select(ItemDocument)
                .where(ItemDocument.file_id == fid)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if row is None or doc is None:
            continue
        src = SOURCES.get(doc.kind)
        if src is None:
            continue
        data = _copy(doc.data or {})
        touched = False
        for thing in src.things(data):
            new_tags = _replace(list(thing.get("tags") or []), old_keys, new)
            if new_tags is not None:
                thing["tags"] = new_tags
                touched = True
        if not touched:
            continue
        try:
            await items.save_data(db, user, row, doc, data, base_revision=None, source="edit")
        except items.ItemError:
            # e.g. the new name now exceeds what that app allows; the rest
            # still follows, and this file keeps its old spelling.
            logger.info("tag rewrite skipped for %s", fid)
            continue
        changed += 1
    return changed


def _copy(data: dict) -> dict:
    import copy

    return copy.deepcopy(data)


async def edit_thing_tags(
    db: AsyncSession, user, entity_kind: str, entity_id: str, change: Callable[[list[str]], list[str]]  # noqa: ANN001
) -> list[str]:
    """Change one app thing's tags in its file (through the save path):
    ``change`` gets the current list and returns the new one. The caller
    must be able to edit the file — LookupError otherwise (→ 404), and
    :class:`app.items.service.ItemError` when the app refuses the result
    (e.g. more tags than it allows). Returns the tags stored."""
    from app.items import service as items

    src = BY_ENTITY.get(entity_kind)
    if src is None:
        raise LookupError("unknown kind")
    try:
        fid, sub = split_entity_id(entity_id)
    except ValueError as e:
        raise LookupError("bad id") from e
    try:
        row, doc, _ = await items.load(db, user, fid, need="edit", lock=True)
    except items.ItemNotFound as e:
        raise LookupError("not found") from e
    if doc.kind != src.item_kind:
        raise LookupError("not found")
    data = _copy(doc.data or {})
    target = next((t for t in src.things(data) if str(t["id"]) == sub), None)
    if target is None:
        raise LookupError("not found")
    clean: list[str] = []
    for n in change([t for t in target.get("tags") or [] if isinstance(t, str)]):
        v = norm(n)
        if v and v.casefold() not in {c.casefold() for c in clean}:
            clean.append(v)
    target["tags"] = clean
    await items.save_data(db, user, row, doc, data, base_revision=None, source="edit")
    stored = next((t for t in src.things(doc.data or {}) if str(t["id"]) == sub), {})
    return list(stored.get("tags") or [])
