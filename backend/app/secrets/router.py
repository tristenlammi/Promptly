"""Credentials vault endpoints (A1).

    GET    /api/secrets           list names + timestamps (never values)
    POST   /api/secrets           create (409 on duplicate name)
    PUT    /api/secrets/{id}      replace the value (name is immutable)
    DELETE /api/secrets/{id}      remove

Strictly owner-scoped. The plaintext value crosses the wire exactly
once, on create/update, and is Fernet-encrypted before it touches the
database. Nothing ever reads it back out except the HTTP-request node
executor at run time.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import record_event
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.database import get_db
from app.secrets.models import UserSecret

router = APIRouter()

_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")

# Audit event types (constants live here — the secrets module is the
# single writer; the admin panel picks the strings up as raw keys).
EVENT_SECRET_CREATED = "secret_created"
EVENT_SECRET_UPDATED = "secret_updated"
EVENT_SECRET_DELETED = "secret_deleted"


class SecretResponse(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SecretCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    value: str = Field(min_length=1, max_length=8192)


class SecretUpdate(BaseModel):
    value: str = Field(min_length=1, max_length=8192)


def _validate_name(name: str) -> str:
    name = name.strip().upper().replace("-", "_").replace(" ", "_")
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Names are UPPER_SNAKE_CASE: letters, digits, and "
            "underscores, starting with a letter.",
        )
    return name


@router.get("", response_model=list[SecretResponse])
async def list_secrets(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[UserSecret]:
    rows = (
        (
            await db.execute(
                select(UserSecret)
                .where(UserSecret.user_id == user.id)
                .order_by(UserSecret.name.asc())
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


@router.post(
    "", response_model=SecretResponse, status_code=status.HTTP_201_CREATED
)
async def create_secret(
    payload: SecretCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserSecret:
    name = _validate_name(payload.name)
    existing = (
        await db.execute(
            select(UserSecret).where(
                UserSecret.user_id == user.id, UserSecret.name == name
            )
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A credential named {name} already exists.",
        )
    row = UserSecret(
        user_id=user.id,
        name=name,
        value_encrypted=encrypt_secret(payload.value),
    )
    db.add(row)
    await record_event(
        db,
        event_type=EVENT_SECRET_CREATED,
        request=request,
        user_id=user.id,
        detail=f"credential {name}",
    )
    await db.commit()
    await db.refresh(row)
    return row


@router.put("/{secret_id}", response_model=SecretResponse)
async def update_secret(
    secret_id: uuid.UUID,
    payload: SecretUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UserSecret:
    row = await db.get(UserSecret, secret_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    row.value_encrypted = encrypt_secret(payload.value)
    await record_event(
        db,
        event_type=EVENT_SECRET_UPDATED,
        request=request,
        user_id=user.id,
        detail=f"credential {row.name}",
    )
    await db.commit()
    await db.refresh(row)
    return row


@router.delete(
    "/{secret_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_secret(
    secret_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await db.get(UserSecret, secret_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    name = row.name
    await db.delete(row)
    await record_event(
        db,
        event_type=EVENT_SECRET_DELETED,
        request=request,
        user_id=user.id,
        detail=f"credential {name}",
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
