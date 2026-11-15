"""Admin → Home (``/api/admin/home``): turn Promptly Home on, and prepare
boxes to hand out.

An admin makes a box's two secrets (the setup string that goes into the box,
and the code for its card), sees whether a box has been claimed and whether
it's online, and can cut one off. Which home a box went to, who is in that
home and what devices it has are not shown here or anywhere else to an admin.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event
from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db

from . import codes, relay
from .models import HomeBox
from .router import enabled

router = APIRouter()

MAX_BOXES = 500


def _box_out(box: HomeBox) -> dict[str, Any]:
    return {
        "id": str(box.id),
        "label": box.label,
        "claimed": box.home_id is not None,
        "has_code": box.claim_hash is not None,
        "online": relay.online(box.id),
        "revoked": box.revoked_at is not None,
        "last_seen_at": box.last_seen_at.isoformat() if box.last_seen_at else None,
        "version": box.version,
        "created_at": box.created_at.isoformat() if box.created_at else None,
    }


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, bool]:
    return {"enabled": await enabled(db)}


class SettingsPatch(BaseModel):
    enabled: bool


@router.patch("/settings")
async def patch_settings(body: SettingsPatch, request: Request, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict[str, bool]:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.home_enabled = body.enabled
    await record_event(db, event_type=EVENT_APP_SETTINGS_CHANGED, request=request, user_id=admin.id, identifier=admin.username, detail=f"home_enabled={body.enabled}")
    await db.commit()
    return {"enabled": body.enabled}


@router.get("/boxes")
async def list_boxes(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, Any]:
    rows = (await db.execute(select(HomeBox).order_by(HomeBox.created_at.desc()))).scalars().all()
    return {"boxes": [_box_out(b) for b in rows]}


class NewBox(BaseModel):
    label: str = Field(default="", max_length=80)
    # Where the box should dial. Defaults to how this request reached us.
    server_url: str | None = Field(default=None, max_length=300)


async def _server(db: AsyncSession, request: Request, given: str | None) -> str:
    if given and given.strip():
        url = given.strip().rstrip("/")
        if not (url.startswith("https://") or url.startswith("http://")):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "The server address starts with https://")
        return url
    from app.public_origin import link_origin

    origin = await link_origin(db, request)
    if not origin:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Give this server's address (https://…).")
    return origin


@router.post("/boxes")
async def prepare_box(body: NewBox, request: Request, db: AsyncSession = Depends(get_db), admin: User = Depends(require_admin)) -> dict[str, Any]:
    """A new box: its setup string (into the box) and its claim code (onto
    the card). Both are shown this once; only their hashes are kept."""
    total = len((await db.execute(select(HomeBox.id))).all())
    if total >= MAX_BOXES:
        raise HTTPException(status.HTTP_409_CONFLICT, "That's the most boxes one server can have.")
    server = await _server(db, request, body.server_url)
    key = codes.new_key()
    code = codes.new_claim_code()
    box = HomeBox(label=body.label.strip(), key_hash=codes.digest(key), claim_hash=codes.claim_digest(code), created_by=admin.id)
    db.add(box)
    await db.commit()
    await db.refresh(box)
    return {
        "box": _box_out(box),
        "setup": codes.setup_string(server, box.id, key),
        "claim_code": code,
        # In the fragment, so the code isn't sent to (or logged by) a server.
        "claim_url": f"{server}/home#claim={code}",
    }


async def _box(db: AsyncSession, box_id: uuid.UUID) -> HomeBox:
    box = await db.get(HomeBox, box_id)
    if box is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Box not found")
    return box


@router.post("/boxes/{box_id}/claim-code")
async def new_claim_code(box_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, str]:
    """A fresh card for a box nobody has claimed (the old code stops working)."""
    box = await _box(db, box_id)
    if box.home_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That box is in someone's home. They can release it from their Home page.")
    code = codes.new_claim_code()
    box.claim_hash = codes.claim_digest(code)
    await db.commit()
    server = await _server(db, request, None)
    return {"claim_code": code, "claim_url": f"{server}/home#claim={code}"}


class SetupBody(BaseModel):
    server_url: str | None = Field(default=None, max_length=300)


@router.post("/boxes/{box_id}/setup")
async def new_setup(box_id: uuid.UUID, body: SetupBody, request: Request, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, str]:
    """A new setup string, for a box that was wiped or whose string leaked.
    The old one stops working at once; the box stays in its home."""
    box = await _box(db, box_id)
    server = await _server(db, request, body.server_url)
    key = codes.new_key()
    box.key_hash = codes.digest(key)
    await db.commit()
    await relay.drop(box.id, relay.CLOSE_BAD)
    return {"setup": codes.setup_string(server, box.id, key)}


class RevokeBody(BaseModel):
    revoked: bool = True


@router.post("/boxes/{box_id}/revoke")
async def revoke(box_id: uuid.UUID, body: RevokeBody, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, Any]:
    """Cut a box off (lost, stolen), or let it back."""
    box = await _box(db, box_id)
    box.revoked_at = datetime.now(timezone.utc) if body.revoked else None
    await db.commit()
    if body.revoked:
        await relay.drop(box.id)
    return {"box": _box_out(box)}


@router.delete("/boxes/{box_id}")
async def delete_box(box_id: uuid.UUID, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict[str, bool]:
    box = await _box(db, box_id)
    if box.home_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That box is in someone's home. Revoke it to cut it off.")
    await db.delete(box)
    await db.commit()
    await relay.drop(box_id, relay.CLOSE_BAD)
    return {"ok": True}
