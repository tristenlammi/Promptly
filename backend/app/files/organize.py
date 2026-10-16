"""Organise my files (WP-5.3): moves, renames and new folders the assistant
proposes and the person applies from a preview card.

Two steps, both with Drive's own rules (owner-only, system and workspace
folders protected, no folder moved into itself, folder names unique among
live siblings):

* :func:`check` — at propose time: every item exists and is yours, every
  name is valid; the payload it returns says what each step will do in
  words (paths, not ids) so the card shows exactly what changes.
* :func:`apply` — at apply time, again from scratch (things move on), all
  steps in one transaction: any step that no longer works fails the lot
  with a readable reason, and nothing is half-done.

Destinations are paths from My files ("Taxes/2025"); missing folders on a
path are made, so "put these in a new Taxes/2025 folder" is one proposal.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.finder import folder_by_path, folder_path

MAX_OPS = 50
OPS = ("create_folder", "move", "rename")


class OrganizeError(ValueError):
    """A step that can't be done — the message is shown to the person (and
    the model)."""


def _segments(path: str) -> list[str]:
    segs = [s.strip() for s in (path or "").strip().strip("/").split("/")]
    segs = [s for s in segs if s]
    for s in segs:
        _check_name(s, "folder")
    return segs


def _check_name(name: str, what: str) -> str:
    name = (name or "").strip()
    if not name:
        raise OrganizeError(f"A {what} name can't be empty.")
    if "/" in name or "\\" in name or name in (".", ".."):
        raise OrganizeError(f"{name!r} isn't a valid {what} name.")
    if len(name) > 255:
        raise OrganizeError(f"A {what} name can be at most 255 characters.")
    return name


def _norm(path: str) -> str:
    return "/".join(s.lower() for s in _segments(path))


async def _item(db: AsyncSession, user: Any, item_type: str, item_id: str) -> Any:
    from app.files.models import FileFolder, UserFile

    try:
        iid = uuid.UUID(str(item_id))
    except ValueError as exc:
        raise OrganizeError(f"{item_id!r} isn't a file or folder id.") from exc
    model = UserFile if item_type == "file" else FileFolder
    row = await db.get(model, iid)
    if row is None or row.trashed_at is not None:
        raise OrganizeError(f"That {item_type} no longer exists (or is in the trash).")
    if row.user_id != user.id:
        raise OrganizeError(
            f"{_name_of(row)!r} belongs to someone else — only its owner can move or rename it."
        )
    return row


def _final_name(row: Any, name: str) -> str:
    """The name a rename will really give: a Promptly Doc keeps its
    ``.html`` / ``.md`` (the editor hides it), as Drive's rename does."""
    import os

    if getattr(row, "source_kind", None) == "document":
        ext = os.path.splitext(row.filename or "")[1]
        if ext.lower() in (".html", ".htm", ".md") and not name.lower().endswith(ext.lower()):
            return name + ext
    return name


def _name_of(row: Any) -> str:
    return getattr(row, "filename", None) or getattr(row, "name", "") or ""


async def _guard(db: AsyncSession, row: Any, item_type: str, action: str) -> None:
    from app.files.router import _assert_not_system_folder, _guard_workspace_file, _guard_workspace_folder

    try:
        if item_type == "file":
            await _guard_workspace_file(db, row)
        else:
            _assert_not_system_folder(row, action)
            await _guard_workspace_folder(db, row)
    except HTTPException as exc:
        raise OrganizeError(str(exc.detail)) from exc


async def _where(db: AsyncSession, row: Any, item_type: str) -> str:
    from app.files.models import FileFolder

    parent_id = row.folder_id if item_type == "file" else row.parent_id
    parent = await db.get(FileFolder, parent_id) if parent_id else None
    return await folder_path(db, parent)


async def _sibling_folder(db: AsyncSession, owner_id, parent_id, name: str, not_id=None) -> bool:
    from app.files.models import FileFolder

    q = select(func.count()).select_from(FileFolder).where(
        FileFolder.user_id == owner_id,
        FileFolder.trashed_at.is_(None),
        func.lower(FileFolder.name) == name.lower(),
        FileFolder.parent_id == parent_id if parent_id is not None else FileFolder.parent_id.is_(None),
    )
    if not_id is not None:
        q = q.where(FileFolder.id != not_id)
    return bool(await db.scalar(q))


def _shown(path: str) -> str:
    return path or "My files"


async def check(db: AsyncSession, user: Any, operations: list[dict[str, Any]]) -> dict[str, Any]:
    """Validate a proposal; returns the payload stored with it."""
    if not isinstance(operations, list) or not operations:
        raise OrganizeError("Give at least one step.")
    if len(operations) > MAX_OPS:
        raise OrganizeError(f"At most {MAX_OPS} steps in one proposal — split it up.")
    planned: set[str] = set()  # folder paths this proposal makes (normalised)
    # Where an item will be after this proposal's earlier moves — a rename
    # after a move says "in Taxes/2025", where it'll be by then.
    moved_to: dict[str, str] = {}
    steps: list[dict[str, Any]] = []
    for i, raw in enumerate(operations, start=1):
        if not isinstance(raw, dict):
            raise OrganizeError(f"Step {i} isn't an object.")
        op = raw.get("op")
        try:
            if op == "create_folder":
                segs = _segments(str(raw.get("path") or ""))
                if not segs:
                    raise OrganizeError("`path` is required for a new folder.")
                path = "/".join(segs)
                exists = await folder_by_path(db, user.id, path) is not None
                for n in range(1, len(segs) + 1):
                    planned.add("/".join(s.lower() for s in segs[:n]))
                steps.append({"op": op, "path": path, "exists": exists})
            elif op in ("move", "rename"):
                item_type = raw.get("item_type")
                if item_type not in ("file", "folder"):
                    raise OrganizeError("`item_type` must be 'file' or 'folder'.")
                row = await _item(db, user, item_type, raw.get("item_id") or "")
                await _guard(db, row, item_type, op)
                here = moved_to.get(str(row.id), await _where(db, row, item_type))
                step: dict[str, Any] = {
                    "op": op, "item_type": item_type, "item_id": str(row.id),
                    "name": _name_of(row), "from": here,
                }
                if op == "move":
                    to = "/".join(_segments(str(raw.get("to") or "")))
                    dest = await folder_by_path(db, user.id, to) if to else None
                    if to and dest is None and _norm(to) not in planned:
                        step["to_new"] = True
                        for n in range(1, len(to.split("/")) + 1):
                            planned.add("/".join(s.lower() for s in to.split("/")[:n]))
                    if item_type == "folder":
                        mine = (f"{here}/{row.name}" if here else row.name).lower()
                        if to.lower() == mine or to.lower().startswith(mine + "/"):
                            raise OrganizeError(f"Can't move {row.name!r} into itself.")
                        if await _sibling_folder(db, user.id, dest.id if dest else None, row.name, row.id):
                            raise OrganizeError(f"{_shown(to)} already has a folder called {row.name!r}.")
                    if to.lower() == here.lower():
                        raise OrganizeError(f"{_name_of(row)!r} is already in {_shown(to)}.")
                    step["to"] = to
                    moved_to[str(row.id)] = to
                else:
                    new = _check_name(str(raw.get("name") or ""), item_type)
                    if item_type == "file":
                        new = _final_name(row, new)
                    if new == _name_of(row):
                        raise OrganizeError(f"{new!r} already has that name.")
                    if item_type == "folder" and await _sibling_folder(db, user.id, row.parent_id, new, row.id):
                        raise OrganizeError(f"{_shown(here)} already has a folder called {new!r}.")
                    step["new_name"] = new
                steps.append(step)
            else:
                raise OrganizeError(f"`op` must be one of: {', '.join(OPS)}.")
        except OrganizeError as exc:
            raise OrganizeError(f"Step {i}: {exc}") from exc
    return {"operations": steps, "summary": summarise(steps)}


def summarise(steps: list[dict[str, Any]]) -> str:
    moves = sum(1 for s in steps if s["op"] == "move")
    renames = sum(1 for s in steps if s["op"] == "rename")
    news = {s["path"].lower() for s in steps if s["op"] == "create_folder" and not s.get("exists")}
    news |= {s["to"].lower() for s in steps if s.get("to_new")}
    bits = []
    if moves:
        bits.append(f"move {moves} item{'s' if moves != 1 else ''}")
    if renames:
        bits.append(f"rename {renames} item{'s' if renames != 1 else ''}")
    if news:
        bits.append(f"{len(news)} new folder{'s' if len(news) != 1 else ''}")
    return ", ".join(bits) or "no changes"


async def _ensure_path(db: AsyncSession, user: Any, path: str) -> Any | None:
    """The folder at ``path``, making any missing ones on the way."""
    from app.files.models import FileFolder

    parent = None
    for seg in _segments(path):
        q = select(FileFolder).where(
            FileFolder.user_id == user.id,
            FileFolder.trashed_at.is_(None),
            func.lower(FileFolder.name) == seg.lower(),
            FileFolder.parent_id == parent.id if parent is not None else FileFolder.parent_id.is_(None),
        )
        found = (await db.execute(q.limit(1))).scalars().first()
        if found is None:
            found = FileFolder(user_id=user.id, parent_id=parent.id if parent else None, name=seg)
            db.add(found)
            await db.flush()
        parent = found
    return parent


async def _rename_file(db: AsyncSession, row: Any, name: str) -> None:
    """As Drive's rename: a Promptly Doc / Sheet / Whiteboard keeps its
    suffix and its editor title follows the name."""
    from app.files.office import content_for_shell, is_shell, shell_filename
    from app.files.office_templates import office_title

    row.filename = name
    if is_shell(row):
        title = office_title(row).strip() or "Untitled"
        row.filename = row.original_filename = shell_filename(row.source_kind, title)
        entity = await content_for_shell(db, row)
        if entity is not None:
            entity.title = title[:200]


async def apply(db: AsyncSession, user: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Do every step (re-checked) or none. Commits; raises
    :class:`OrganizeError` with nothing changed when a step fails."""
    from app.files.router import _would_create_cycle

    steps = (payload or {}).get("operations") or []
    raw = [
        {k: v for k, v in s.items() if k in ("op", "path", "item_type", "item_id", "to")}
        | ({"name": s["new_name"]} if s.get("new_name") else {})
        for s in steps
    ]
    await check(db, user, raw)  # same rules as when it was proposed, against now
    first_dest: Any = None
    try:
        for s in raw:
            if s["op"] == "create_folder":
                folder = await _ensure_path(db, user, s["path"])
                first_dest = first_dest or folder
            elif s["op"] == "move":
                dest = await _ensure_path(db, user, s.get("to") or "")
                row = await _item(db, user, s["item_type"], s["item_id"])
                if s["item_type"] == "file":
                    row.folder_id = dest.id if dest else None
                else:
                    if dest is not None and await _would_create_cycle(db, moving=row, new_parent=dest):
                        raise OrganizeError(f"Can't move {row.name!r} into itself.")
                    row.parent_id = dest.id if dest else None
                first_dest = first_dest or dest
            else:
                row = await _item(db, user, s["item_type"], s["item_id"])
                if s["item_type"] == "file":
                    await _rename_file(db, row, s["name"])
                else:
                    row.name = s["name"]
            await db.flush()
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise OrganizeError("Two folders would end up with the same name in one place — nothing was changed.") from exc
    except OrganizeError:
        await db.rollback()
        raise
    return {"folder_id": str(first_dest.id) if first_dest is not None else None}


__all__ = ["MAX_OPS", "OrganizeError", "apply", "check", "summarise"]
