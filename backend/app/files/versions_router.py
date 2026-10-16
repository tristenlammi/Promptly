"""Version history for office files (WP-6.2, Part C §3.9) and uploaded
PDFs saved from the viewer (WP-6.5).

    GET   /api/files/{id}/versions                  the versions, newest first
    GET   /api/files/{id}/versions/{vid}/diff       what changed between it and now
    PATCH /api/files/{id}/versions/{vid}            name it / keep it forever
    POST  /api/files/{id}/versions/{vid}/restore    make it the current state

(``POST /api/files/{id}/versions`` — "save a version now" — is in
``office_router``.) Anyone who can open the file sees its history; restoring,
naming and keeping need edit access.

A restore is a server-side room reset (:func:`restore_version`): the live
room is frozen and emptied, its latest state kept as a "Before restoring"
version, the chosen state written, and the file's edit generation bumped —
every open editor reloads onto it instead of merging the newer state back.
"""
from __future__ import annotations

import asyncio
import difflib
import html
import json
import logging
import re
import uuid
import zlib
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileVersion, UserFile

logger = logging.getLogger("promptly.files.versions_router")

router = APIRouter()

MAX_DIFF_LINES = 400
MAX_CELL_CHANGES = 500


class VersionAuthor(BaseModel):
    id: uuid.UUID
    username: str


class VersionOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    source: str
    label: str | None
    keep_forever: bool
    size_bytes: int
    authors: list[VersionAuthor]
    # An uploaded file's version is its old bytes: a signed link to them
    # (WP-8.1). None for office files' editor states.
    download_url: str | None = None


class VersionList(BaseModel):
    versions: list[VersionOut]
    can_edit: bool
    kind: str


class VersionPatch(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    keep_forever: bool | None = None


def _kind(row: UserFile) -> str | None:
    """document / sheet / whiteboard, "pdf" for an uploaded PDF (WP-6.5), or
    "blob" for any other uploaded file (WP-8.1)."""
    from app.files.blob_versions import blob_kind
    from app.files.versions import kind_of

    return kind_of(row) or blob_kind(row)


def _bytes_kind(kind: str | None) -> bool:
    return kind in ("pdf", "blob")


async def _file(db: AsyncSession, file_id: uuid.UUID, user: User) -> tuple[UserFile, str]:
    from app.files.office import get_office_access
    from app.files.pdf_edit import pdf_access

    row = await db.get(UserFile, file_id)
    if row is None or row.trashed_at is not None or _kind(row) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    # An uploaded file: its owner and editors change its history; anyone
    # who can open it sees it.
    access = await (pdf_access(db, row, user) if _bytes_kind(_kind(row)) else get_office_access(db, row, user))
    if access == "none":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    return row, access


async def _version(db: AsyncSession, row: UserFile, version_id: uuid.UUID) -> FileVersion:
    v = await db.get(FileVersion, version_id)
    if v is None or v.file_id != row.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That version no longer exists.")
    return v


def _edit_only(access: str) -> None:
    if access != "edit":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can view this file but not change its history.")


async def _authors(db: AsyncSession, versions: list[FileVersion]) -> dict[uuid.UUID, User]:
    ids = {a for v in versions for a in (v.author_ids or [])}
    if not ids:
        return {}
    return {u.id: u for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars().all()}


def _out(v: FileVersion, users: dict[uuid.UUID, User], viewer: User | None = None) -> VersionOut:
    url = None
    if viewer is not None and v.storage_path:
        from app.files import media_urls

        url = media_urls.sign(v.id, viewer.id, viewer.token_version, "version", media_urls.version_tag(v.storage_path))
    return VersionOut(
        id=v.id, created_at=v.created_at, source=v.source, label=v.label, keep_forever=bool(v.keep_forever),
        size_bytes=v.size_bytes or 0,
        authors=[VersionAuthor(id=u.id, username=u.username) for a in (v.author_ids or []) if (u := users.get(a))],
        download_url=url,
    )


@router.get("/{file_id:uuid}/versions", response_model=VersionList)
async def list_versions(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VersionList:
    row, access = await _file(db, file_id, user)
    versions = (
        await db.execute(
            select(FileVersion).where(FileVersion.file_id == row.id).order_by(FileVersion.created_at.desc()).limit(300)
        )
    ).scalars().all()
    users = await _authors(db, list(versions))
    return VersionList(versions=[_out(v, users, user) for v in versions], can_edit=access == "edit", kind=_kind(row) or "")


@router.patch("/{file_id:uuid}/versions/{version_id:uuid}", response_model=VersionOut)
async def update_version(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    body: VersionPatch,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> VersionOut:
    """Name a version (named versions are never pruned) or keep it forever."""
    row, access = await _file(db, file_id, user)
    _edit_only(access)
    v = await _version(db, row, version_id)
    fields = body.model_fields_set
    if "label" in fields:
        v.label = (body.label or "").strip() or None
    if "keep_forever" in fields and body.keep_forever is not None:
        v.keep_forever = body.keep_forever
    await db.commit()
    await db.refresh(v)
    return _out(v, await _authors(db, [v]))


# ------------------------------------------------------------------ diffs


def _state(v: FileVersion) -> bytes:
    return zlib.decompress(v.yjs_state) if v.yjs_state else b""


_BLOCK_END = re.compile(r"</(p|h[1-6]|li|blockquote|pre|tr|div|figcaption)>|<br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>")


def _doc_text(state: bytes) -> str:
    """A document's text, one block (paragraph, heading, list item, table
    row) per line — so a diff shows which paragraph changed."""
    from app.files.document_render import render_html_from_update

    if not state:
        return ""
    html_ = _BLOCK_END.sub("\n", render_html_from_update(state))
    text_ = html.unescape(_TAG.sub("", html_))
    return "\n".join(ln.strip() for ln in text_.splitlines() if ln.strip())


def _text_diff(before: str, after: str) -> dict[str, Any]:
    """Line diff with unchanged runs folded: ``[{op, text}]`` where op is
    ``same`` / ``add`` / ``del`` / ``skip`` (text = how many folded)."""
    a = [ln for ln in before.splitlines() if ln.strip()]
    b = [ln for ln in after.splitlines() if ln.strip()]
    out: list[dict[str, Any]] = []
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            run = a[i1:i2]
            if len(run) > 4:
                out += [{"op": "same", "text": t} for t in run[:2]]
                out.append({"op": "skip", "text": str(len(run) - 4)})
                out += [{"op": "same", "text": t} for t in run[-2:]]
            else:
                out += [{"op": "same", "text": t} for t in run]
            continue
        out += [{"op": "del", "text": t} for t in a[i1:i2]]
        out += [{"op": "add", "text": t} for t in b[j1:j2]]
        removed += i2 - i1
        added += j2 - j1
    truncated = len(out) > MAX_DIFF_LINES
    return {"lines": out[:MAX_DIFF_LINES], "added": added, "removed": removed, "truncated": truncated}


def _sheet_cells(data: Any) -> tuple[dict[tuple[str, int, int], str], list[str]]:
    from app.workspaces.sheet_io import _grid, _shown, _tabs

    cells: dict[tuple[str, int, int], str] = {}
    names: list[str] = []
    for i, tab in enumerate(_tabs(data)):
        name = str(tab.get("name") or f"Sheet{i + 1}")
        names.append(name)
        for (r, c), cell in _grid(tab).items():
            v = cell.get("v")
            text_ = _shown(v).strip()
            f = v.get("f") if isinstance(v, dict) else None
            if f:
                text_ = f"{text_} [{f}]".strip()
            if text_:
                cells[(name, r, c)] = text_
    return cells, names


def _col(c: int) -> str:
    s, n = "", c + 1
    while n:
        n, m = divmod(n - 1, 26)
        s = chr(65 + m) + s
    return s


def _sheet_diff(before: Any, after: Any) -> dict[str, Any]:
    a, tabs_a = _sheet_cells(before)
    b, tabs_b = _sheet_cells(after)
    changes = []
    for key in sorted(set(a) | set(b), key=lambda k: (k[0], k[1], k[2])):
        if a.get(key) != b.get(key):
            tab, r, c = key
            changes.append({"tab": tab, "ref": f"{_col(c)}{r + 1}", "before": a.get(key), "after": b.get(key)})
    return {
        "cells": changes[:MAX_CELL_CHANGES],
        "changed": len(changes),
        "truncated": len(changes) > MAX_CELL_CHANGES,
        "tabs_added": [t for t in tabs_b if t not in tabs_a],
        "tabs_removed": [t for t in tabs_a if t not in tabs_b],
    }


def _board_elements(state: bytes) -> dict[str, dict]:
    from app.workspaces.export_router import canvas_scene_json

    if not state:
        return {}
    try:
        scene = json.loads(canvas_scene_json(state) or "{}")
    except (ValueError, TypeError):
        return {}
    return {e["id"]: e for e in scene.get("elements") or [] if isinstance(e, dict) and e.get("id") and not e.get("isDeleted")}


def _board_diff(before: bytes, after: bytes) -> dict[str, Any]:
    a, b = _board_elements(before), _board_elements(after)

    def sig(e: dict) -> tuple:
        return (e.get("type"), round(e.get("x") or 0), round(e.get("y") or 0), round(e.get("width") or 0),
                round(e.get("height") or 0), e.get("text"), e.get("strokeColor"), e.get("backgroundColor"))

    def describe(e: dict) -> str:
        kind = e.get("type") or "shape"
        return f"{kind}: {e['text']}" if e.get("text") else kind

    added = [describe(b[i]) for i in b if i not in a]
    removed = [describe(a[i]) for i in a if i not in b]
    changed = [describe(b[i]) for i in b if i in a and sig(a[i]) != sig(b[i])]
    return {"added": added[:100], "removed": removed[:100], "changed": changed[:100],
            "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)}}


@router.get("/{file_id:uuid}/versions/{version_id:uuid}/diff")
async def version_diff(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """What restoring this version would change: the version is "before",
    the file now is "after" (so a restore undoes the additions and brings
    back the removals)."""
    from app.files.versions import current_state

    from app import collab_internal
    from app.files.versions import RestoreError, room_for

    row, _access = await _file(db, file_id, user)
    v = await _version(db, row, version_id)
    kind = _kind(row)
    if kind == "blob":
        return await asyncio.to_thread(_blob_diff, row, v)
    if kind == "pdf":
        # A PDF: its text, page by page, and how many pages (WP-6.5).
        from app.files.pdf_edit import version_pages, version_text

        before, after, pages_before, pages_after = await asyncio.gather(
            asyncio.to_thread(version_text, v.storage_path),
            asyncio.to_thread(version_text, row.storage_path),
            asyncio.to_thread(version_pages, v.storage_path),
            asyncio.to_thread(version_pages, row.storage_path),
        )
        return {
            "kind": kind,
            "pages_before": pages_before,
            "pages_after": pages_after,
            "same_bytes": v.storage_path == row.storage_path,
            **_text_diff(before, after),
        }
    now_state, now_data = await current_state(db, row)
    # "Now" is the live room when it's open — the store runs on a delay.
    try:
        live = await collab_internal.live_state(await room_for(db, row))
    except RestoreError:
        live = None
    if live:
        now_state = live
    if kind == "document":
        before, after = await asyncio.gather(
            asyncio.to_thread(_doc_text, _state(v)), asyncio.to_thread(_doc_text, now_state)
        )
        return {"kind": kind, **_text_diff(before, after)}
    if kind == "sheet":
        return {"kind": kind, **await asyncio.to_thread(_sheet_diff, v.data, now_data)}
    return {"kind": kind, **await asyncio.to_thread(_board_diff, _state(v), now_state)}


_TEXT_MIMES = ("application/json", "application/xml", "application/x-yaml", "application/javascript")
_TEXT_CAP = 400_000


def _read_text(storage_path: str | None) -> str | None:
    from app.files.storage import absolute_path

    if not storage_path:
        return None
    try:
        with open(absolute_path(storage_path), "rb") as fh:
            raw = fh.read(_TEXT_CAP)
        return raw.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _blob_diff(row: UserFile, v: FileVersion) -> dict[str, Any]:
    """An uploaded file's version against now: lines for text, otherwise
    whether the bytes and size differ."""
    base = {
        "kind": "blob",
        "same_bytes": v.storage_path == row.storage_path or (v.content_hash and v.content_hash == row.content_sha256),
        "size_before": v.size_bytes or 0,
        "size_after": row.size_bytes or 0,
    }
    mime = (row.mime_type or "").lower()
    if mime.startswith("text/") or mime in _TEXT_MIMES:
        before, after = _read_text(v.storage_path), _read_text(row.storage_path)
        if before is not None and after is not None:
            return {**base, **_text_diff(before, after)}
    return base


# ------------------------------------------------------------------ restore


@router.post("/{file_id:uuid}/versions/{version_id:uuid}/restore")
async def restore(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Make this version the file's current state, for everyone. The state
    it replaces is kept as a "Before restoring …" version first."""
    from app.files.versions import RestoreError, restore_version

    row, access = await _file(db, file_id, user)
    _edit_only(access)
    v = await _version(db, row, version_id)
    if _bytes_kind(_kind(row)):
        from app.files.blob_versions import VersionError, restore_bytes

        try:
            await restore_bytes(db, row, v, user.id)
        except VersionError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        return {"ok": True, "epoch": row.collab_epoch}
    try:
        epoch = await restore_version(db, row, v, user)
    except RestoreError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return {"ok": True, "epoch": epoch}


__all__ = ["router"]
