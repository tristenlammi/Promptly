"""Settings → Devices: app passwords (WP-8.3).

    GET    /api/auth/app-passwords          your devices (never the passwords)
    POST   /api/auth/app-passwords          a new one — the password is shown once
    DELETE /api/auth/app-passwords/{id}     revoke it (cut off at once)
"""
from __future__ import annotations

import datetime as _dt
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.app_passwords import MAX_PER_USER, SCOPES, AppPassword, hint, new_token, token_hash
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()


class AppPasswordOut(BaseModel):
    id: uuid.UUID
    name: str
    hint: str
    scopes: list[str]
    created_at: _dt.datetime
    last_used_at: _dt.datetime | None
    last_used_ip: str | None


class AppPasswordCreated(AppPasswordOut):
    # Shown once — only its hash is kept.
    password: str
    username: str


class AppPasswordCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Give the device a name.")
        return v

    @field_validator("scopes")
    @classmethod
    def _scopes(cls, v: list[str]) -> list[str]:
        bad = [s for s in v if s not in SCOPES]
        if bad:
            raise ValueError(f"Unknown scope: {', '.join(bad)}")
        return sorted(set(v))


def _out(row: AppPassword) -> AppPasswordOut:
    return AppPasswordOut(
        id=row.id, name=row.name, hint=row.hint, scopes=list(row.scopes or []), created_at=row.created_at,
        last_used_at=row.last_used_at, last_used_ip=row.last_used_ip,
    )


async def _audit(db: AsyncSession, request: Request, user: User, event: str, name: str) -> None:
    from app.auth.audit import record_event, safe_dict

    try:
        await record_event(db, request=request, event_type=event, user_id=user.id, identifier=user.username,
                           detail=safe_dict({"device": name[:80]}))
        await db.commit()
    except Exception:  # noqa: BLE001 — the audit row must never break this
        pass


@router.get("/app-passwords", response_model=list[AppPasswordOut])
async def list_app_passwords(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[AppPasswordOut]:
    rows = (
        await db.execute(
            select(AppPassword)
            .where(AppPassword.user_id == user.id, AppPassword.revoked_at.is_(None))
            .order_by(AppPassword.created_at.desc())
        )
    ).scalars().all()
    return [_out(r) for r in rows]


@router.post("/app-passwords", response_model=AppPasswordCreated, status_code=status.HTTP_201_CREATED)
async def create_app_password(
    payload: AppPasswordCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AppPasswordCreated:
    from app.auth.events import EVENT_APP_PASSWORD_CREATED

    live = await db.scalar(
        select(func.count(AppPassword.id)).where(AppPassword.user_id == user.id, AppPassword.revoked_at.is_(None))
    )
    if (live or 0) >= MAX_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You have {MAX_PER_USER} devices already — revoke one you don't use first.",
        )
    token = new_token()
    row = AppPassword(user_id=user.id, name=payload.name, token_hash=token_hash(token), hint=hint(token), scopes=payload.scopes)
    db.add(row)
    # Where a phone's backup goes (WP-8.5) — there before the app looks.
    from app.files.system_folders import ensure_camera_uploads

    await ensure_camera_uploads(db, user)
    await db.commit()
    await db.refresh(row)
    await _audit(db, request, user, EVENT_APP_PASSWORD_CREATED, row.name)
    return AppPasswordCreated(**_out(row).model_dump(), password=token, username=user.username)


@router.delete("/app-passwords/{password_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_app_password(
    password_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    from app.auth.events import EVENT_APP_PASSWORD_REVOKED

    row = await db.get(AppPassword, password_id)
    if row is None or row.user_id != user.id or row.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such device.")
    row.revoked_at = _dt.datetime.now(_dt.timezone.utc)
    await db.commit()
    await _audit(db, request, user, EVENT_APP_PASSWORD_REVOKED, row.name)


__all__ = ["router"]
