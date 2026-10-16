"""Memories (PH-5) — the stories on the Photos home.

    GET    /api/photos/memories                    yours, made fresh at most hourly
    GET    /api/photos/memories/{id}               one, with its photos
    POST   /api/photos/memories/{id}/dismiss       not again
    POST   /api/photos/memories/{id}/hide-person   no memories of who it's about
    POST   /api/photos/memories/{id}/album         keep it as an album

Only ever the owner's: a memory is never shared by itself.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()

_ORDER = "CASE kind WHEN 'on_this_day' THEN 0 WHEN 'trip' THEN 1 WHEN 'first_year' THEN 2 ELSE 3 END"


async def _items(db: AsyncSession, user: User, ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """Fresh items for these photos, in this order — those still yours."""
    from app.files.models import FileMedia, UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset
    from app.photos.router import _item

    if not ids:
        return []
    rows = {
        a.file_id: (a, r, m)
        for a, r, m in (
            await db.execute(
                select(PhotoAsset, UserFile, FileMedia)
                .join(UserFile, UserFile.id == PhotoAsset.file_id)
                .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
                .where(in_library(user.id), PhotoAsset.file_id.in_(ids))
            )
        ).all()
    }
    return [_item(*rows[i], user) for i in ids if i in rows]


async def _mine(db: AsyncSession, user: User, memory_id: uuid.UUID) -> Any:
    row = (
        await db.execute(text("SELECT * FROM photo_memories WHERE id = :m AND user_id = :u"), {"m": memory_id, "u": user.id})
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That memory isn't there.")
    return row


def _out(row: Any, cover: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "id": str(row["id"]), "kind": row["kind"], "title": row["title"], "subtitle": row["subtitle"],
        "period_start": row["period_start"].isoformat(), "period_end": row["period_end"].isoformat(),
        "count": len(row["file_ids"]), "person_id": str(row["person_id"]) if row["person_id"] else None,
        "cover": cover,
    }


@router.get("")
async def list_memories(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos import memories

    await memories.ensure_fresh(db, user)
    rows = (
        await db.execute(
            text(
                f"SELECT * FROM photo_memories WHERE user_id = :u AND dismissed_at IS NULL "
                f"ORDER BY {_ORDER}, period_end DESC LIMIT 24"
            ),
            {"u": user.id},
        )
    ).mappings().all()
    covers = {c["id"]: c for c in await _items(db, user, [r["cover_file_id"] for r in rows if r["cover_file_id"]])}
    return {"memories": [_out(r, covers.get(str(r["cover_file_id"]))) for r in rows]}


@router.get("/{memory_id}")
async def get_memory(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    row = await _mine(db, user, memory_id)
    items = await _items(db, user, list(row["file_ids"]))
    cover = next((i for i in items if i["id"] == str(row["cover_file_id"])), items[0] if items else None)
    return {**_out(row, cover), "count": len(items), "items": items}


@router.post("/{memory_id}/dismiss", status_code=status.HTTP_204_NO_CONTENT)
async def dismiss(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    await _mine(db, user, memory_id)
    await db.execute(text("UPDATE photo_memories SET dismissed_at = now() WHERE id = :m"), {"m": memory_id})
    await db.commit()


@router.post("/{memory_id}/hide-person", status_code=status.HTTP_204_NO_CONTENT)
async def hide_person(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    """No more memories of who this one is about (their photos stay
    everywhere else). Undone from their page in People."""
    from app.photos import memories

    row = await _mine(db, user, memory_id)
    if not row["person_id"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="This memory isn't about one person.")
    await db.execute(text("UPDATE photo_people SET memories_hidden = true WHERE id = :p AND user_id = :u"), {"p": row["person_id"], "u": user.id})
    await db.execute(text("DELETE FROM photo_memories WHERE person_id = :p AND user_id = :u"), {"p": row["person_id"], "u": user.id})
    await db.commit()
    await memories.forget_fresh(user.id)


@router.post("/{memory_id}/album", status_code=status.HTTP_201_CREATED)
async def save_as_album(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    from app.photos.album_models import Album
    from app.photos.albums_router import _add_items

    row = await _mine(db, user, memory_id)
    title = row["subtitle"].split(" · ")[0] if row["kind"] == "on_this_day" else row["title"]
    album = Album(owner_id=user.id, title=title[:200])
    db.add(album)
    await db.flush()
    added = await _add_items(db, album, user, list(row["file_ids"]))
    await db.commit()
    return {"id": str(album.id), "added": added}


__all__ = ["router"]
