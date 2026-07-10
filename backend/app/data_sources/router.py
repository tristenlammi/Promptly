"""Admin CRUD for data sources + a lightweight picker list for editors.

``admin_router`` (``/api/admin/data-sources``, admins only) manages the
connections; ``picker_router`` (``/api/data-sources``, any authenticated user)
exposes just ``{id, name, driver}`` so the Data-view pane can offer a source
dropdown without ever leaking credentials.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.auth.utils import encrypt_secret
from app.data_sources.models import DataSource
from app.data_sources.service import DataSourceError, test_connection
from app.database import get_db

admin_router = APIRouter()
picker_router = APIRouter()


class DataSourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    driver: str
    host: str
    port: int
    database: str
    username: str
    sslmode: str
    enabled: bool
    password_set: bool
    created_at: datetime


class DataSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1, max_length=255)
    username: str = Field(min_length=1, max_length=255)
    password: str | None = Field(default=None, max_length=1024)
    sslmode: str = Field(default="disable", pattern="^(disable|require)$")
    enabled: bool = True


class DataSourceUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    host: str | None = Field(default=None, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=255)
    # tri-state: omitted = unchanged, "" = clear, value = encrypt + store.
    password: str | None = Field(default=None, max_length=1024)
    sslmode: str | None = Field(default=None, pattern="^(disable|require)$")
    enabled: bool | None = None


class DataSourcePicker(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    driver: str


def _to_response(row: DataSource) -> DataSourceResponse:
    return DataSourceResponse(
        id=row.id,
        name=row.name,
        driver=row.driver,
        host=row.host,
        port=row.port,
        database=row.database,
        username=row.username,
        sslmode=row.sslmode,
        enabled=row.enabled,
        password_set=bool(row.password_encrypted),
        created_at=row.created_at,
    )


# ---- Admin CRUD ----
@admin_router.get("", response_model=list[DataSourceResponse])
async def list_data_sources(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[DataSourceResponse]:
    rows = (
        await db.execute(select(DataSource).order_by(DataSource.name))
    ).scalars().all()
    return [_to_response(r) for r in rows]


@admin_router.post("", response_model=DataSourceResponse, status_code=201)
async def create_data_source(
    payload: DataSourceCreate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> DataSourceResponse:
    row = DataSource(
        name=payload.name.strip(),
        driver="postgres",
        host=payload.host.strip(),
        port=payload.port,
        database=payload.database.strip(),
        username=payload.username.strip(),
        password_encrypted=(
            encrypt_secret(payload.password) if payload.password else None
        ),
        sslmode=payload.sslmode,
        enabled=payload.enabled,
        created_by=actor.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_response(row)


async def _load(db: AsyncSession, source_id: uuid.UUID) -> DataSource:
    row = await db.get(DataSource, source_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Data source not found")
    return row


@admin_router.patch("/{source_id}", response_model=DataSourceResponse)
async def update_data_source(
    source_id: uuid.UUID,
    payload: DataSourceUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> DataSourceResponse:
    row = await _load(db, source_id)
    fields = payload.model_fields_set
    for f in ("name", "host", "database", "username"):
        if f in fields and getattr(payload, f) is not None:
            setattr(row, f, getattr(payload, f).strip())
    if "port" in fields and payload.port is not None:
        row.port = payload.port
    if "sslmode" in fields and payload.sslmode is not None:
        row.sslmode = payload.sslmode
    if "enabled" in fields and payload.enabled is not None:
        row.enabled = payload.enabled
    if "password" in fields:
        row.password_encrypted = (
            encrypt_secret(payload.password) if payload.password else None
        )
    await db.commit()
    await db.refresh(row)
    return _to_response(row)


@admin_router.delete("/{source_id}")
async def delete_data_source(
    source_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, bool]:
    row = await _load(db, source_id)
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


@admin_router.post("/{source_id}/test")
async def test_data_source(
    source_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict:
    row = await _load(db, source_id)
    try:
        await test_connection(row)
    except DataSourceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


# ---- Editor-facing picker (no credentials) ----
@picker_router.get("", response_model=list[DataSourcePicker])
async def list_data_sources_for_picker(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> list[DataSourcePicker]:
    rows = (
        await db.execute(
            select(DataSource)
            .where(DataSource.enabled.is_(True))
            .order_by(DataSource.name)
        )
    ).scalars().all()
    return [DataSourcePicker.model_validate(r) for r in rows]
