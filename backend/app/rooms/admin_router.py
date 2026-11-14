"""Admin → Rooms (``/api/admin/rooms``): the server-wide Rooms settings.

Every key in ``settings.SETTINGS`` is read and saved here, so a new setting
needs no change in this file. The GIF library's key is write-only: it's
stored encrypted and this API only says whether one is set.

An admin changes how Rooms works for everyone; nothing here lets an admin
read anyone's messages.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
from app.auth.deps import require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import get_db

from . import media, service
from . import settings as rooms_settings

router = APIRouter()


async def _out(db: AsyncSession) -> dict[str, Any]:
    row = await rooms_settings._row(db)
    return {
        "settings": await rooms_settings.load(db),
        "kinds": rooms_settings.describe(),
        "gif_key_set": bool(getattr(row, "rooms_gif_key_encrypted", None)),
        # Fixed limits, shown so the admin doesn't have to hunt for them.
        "facts": {
            "attachment_max_mb": service.MAX_ATTACHMENT_BYTES // (1024 * 1024),
            "attachments_per_message": service.MAX_ATTACHMENTS,
            "saved_gifs_per_person": media.MAX_SAVED,
            "emoji_max_edge": media.EMOJI_MAX_EDGE,
        },
    }


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict:
    return await _out(db)


class RoomsSettingsPatch(BaseModel):
    # Any keys from ``settings.SETTINGS``.
    settings: dict[str, Any] = Field(default_factory=dict)
    # Omitted: unchanged. "": clear. Anything else: encrypt and store.
    gif_key: str | None = Field(default=None, max_length=256)


@router.patch("/settings")
async def patch_settings(
    body: RoomsSettingsPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    diff: dict[str, Any] = {}
    if body.settings:
        before = await rooms_settings.load(db)
        try:
            after = await rooms_settings.save(db, body.settings)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
        diff.update({f"rooms.{k}": v for k, v in after.items() if before.get(k) != v})
    if "gif_key" in body.model_fields_set:
        row = await rooms_settings._row(db, create=True)
        key = (body.gif_key or "").strip()
        if key:
            row.rooms_gif_key_encrypted = encrypt_secret(key)
            diff["rooms.gif_key"] = "<set>"
        else:
            if row.rooms_gif_key_encrypted is not None:
                diff["rooms.gif_key"] = "<cleared>"
            row.rooms_gif_key_encrypted = None
    if diff:
        try:
            await record_event(
                db,
                request=request,
                event_type=EVENT_APP_SETTINGS_CHANGED,
                user_id=admin.id,
                identifier=admin.username,
                detail=safe_dict(diff),
            )
        except Exception:  # noqa: BLE001 - the audit row must not undo the change
            pass
    await db.commit()
    return await _out(db)
