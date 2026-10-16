"""Export my library (WP-10.4) — the owner's endpoints.

    GET    /api/files/exports/current   your export (if you've made one this week)
    POST   /api/files/exports           make one ({"part_gb": 2 | 10 | 50}); replaces the last
    DELETE /api/files/exports/{id}      forget it

Each part downloads from a signed ``/api/m/…`` link (``media_serve_router``
streams it); see ``library_export``.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files import library_export, media_urls

router = APIRouter()


class ExportBody(BaseModel):
    part_gb: int = 10


def _out(export_id: str, state: dict[str, Any], user: User) -> dict[str, Any]:
    parts = []
    for p in state["parts"]:
        url = media_urls.sign(uuid.UUID(export_id), user.id, user.token_version, "export", p["n"])
        parts.append({**p, "name": library_export.part_name(state, p["n"]), "url": url})
    return {
        "id": export_id, "created": state["created"], "part_gb": state["part_gb"],
        "counts": state["counts"], "bytes": state["bytes"], "parts": parts,
        "expires": state["created"] + library_export.TTL_SECONDS,
    }


@router.get("/current")
async def current_export(user: User = Depends(get_current_user)) -> dict[str, Any] | None:
    export_id = await library_export.current_for(user.id)
    state = await library_export.load(export_id) if export_id else None
    if not export_id or state is None or not library_export.plan_path(export_id).exists():
        return None
    return _out(export_id, state, user)


@router.post("", status_code=status.HTTP_201_CREATED)
async def make_export(
    body: ExportBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    if body.part_gb not in library_export.PART_SIZES_GB:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Choose 2, 10 or 50 GB parts.")
    planned = await library_export.plan(db, user, body.part_gb)
    if not planned["counts"]["files"] and not planned["counts"]["folders"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "There's nothing in your files to export yet.")
    export_id = await library_export.create(user, planned)
    state = await library_export.load(export_id)
    assert state is not None
    return _out(export_id, state, user)


@router.delete("/{export_id}", status_code=status.HTTP_204_NO_CONTENT)
async def forget_export(export_id: uuid.UUID, user: User = Depends(get_current_user)) -> Response:
    state = await library_export.load(str(export_id))
    if state is None or state["user_id"] != str(user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Export not found")
    await library_export.discard(str(export_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
