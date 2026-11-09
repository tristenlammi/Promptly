"""``/api/trash`` — one trash across apps.

    GET    /api/trash           everything you deleted, newest first
    POST   /api/trash/restore   put things back ({items: [{type, id, workspace_id?}]})
    POST   /api/trash/purge     delete things forever (same body)
    DELETE /api/trash           empty the trash

``type`` is ``file`` / ``folder`` / ``workspace`` / ``workspace_item`` /
``entry`` (a snapshot, by its trash id), or ``calendar_event`` / ``album``
/ ``task`` / ``contact`` with the thing's own id — what an app's Undo
toast sends, since it only knows what it deleted. ``note`` is a note in
Notes, trashed in place (by its id).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import service

router = APIRouter()

TrashType = Literal[
    "file", "folder", "workspace", "workspace_item", "entry", "calendar_event", "album", "task", "contact",
    # Notes (app/notes): trashed in place, by the note's id.
    "note",
]


class TrashItem(BaseModel):
    type: str
    id: str
    app: str
    kind: str
    title: str
    deleted_at: datetime
    expires_at: datetime
    location: str = ""
    workspace_id: str | None = None
    count: int = 0
    mime_type: str | None = None
    size_bytes: int | None = None


class TrashListOut(BaseModel):
    items: list[TrashItem]
    retention_days: int


class TrashRef(BaseModel):
    type: TrashType
    id: str = Field(min_length=1, max_length=64)
    workspace_id: uuid.UUID | None = None


class TrashRefs(BaseModel):
    items: list[TrashRef] = Field(min_length=1, max_length=500)


class TrashResult(BaseModel):
    id: str
    ok: bool
    location: str | None = None
    error: str | None = None


class TrashActionOut(BaseModel):
    done: int
    results: list[TrashResult]


@router.get("", response_model=TrashListOut)
async def list_trash(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> TrashListOut:
    items = await service.list_all(db, user)
    return TrashListOut(items=[TrashItem(**i) for i in items], retention_days=service.RETENTION_DAYS)


async def _each(db: AsyncSession, refs: TrashRefs, fn) -> TrashActionOut:  # noqa: ANN001
    results: list[TrashResult] = []
    done = 0
    for ref in refs.items:
        try:
            out = await fn(ref)
        except HTTPException as e:
            await db.rollback()
            results.append(TrashResult(id=ref.id, ok=False, error=str(e.detail)))
            continue
        except ValueError:
            await db.rollback()
            results.append(TrashResult(id=ref.id, ok=False, error="That's no longer in the trash."))
            continue
        done += 1
        results.append(TrashResult(id=ref.id, ok=True, location=out if isinstance(out, str) else None))
    return TrashActionOut(done=done, results=results)


@router.post("/restore", response_model=TrashActionOut)
async def restore(
    refs: TrashRefs, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> TrashActionOut:
    async def one(ref: TrashRef) -> str:
        return await service.restore(
            db, user, request, ref.type, ref.id, str(ref.workspace_id) if ref.workspace_id else None
        )

    return await _each(db, refs, one)


@router.post("/purge", response_model=TrashActionOut)
async def purge(
    refs: TrashRefs, request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> TrashActionOut:
    async def one(ref: TrashRef) -> None:
        await service.purge(db, user, request, ref.type, ref.id, str(ref.workspace_id) if ref.workspace_id else None)

    return await _each(db, refs, one)


@router.delete("")
async def empty_trash(
    request: Request, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, int]:
    return {"deleted": await service.empty(db, user, request)}
