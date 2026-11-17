"""Promptly Home: each person's own layout of a home's page.

A layout is a list of widgets (a device, a room, some scenes, a group of
devices, music, "everything else"), in order, each with a size. It belongs
to one person in one home: two people in a home each arrange their own page.

It holds ids and the person's own titles, nothing a device reported, and the
server never looks the ids up: the page draws a widget from the home's
devices as it already has them (which are only ever that home's), so a
widget naming something that isn't in the home shows as "no longer in this
home" and nothing else. No row means the page as it comes.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from .models import HomeLayout
from .router import _membership, _on

router = APIRouter()

MAX_WIDGETS = 60
MAX_ITEMS = 40
MAX_ITEMS_IN_ALL = 400

class Widget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=24, pattern=r"^[A-Za-z0-9_-]+$")
    type: Literal["device", "room", "scenes", "group", "music", "rest"]
    size: Literal["s", "m", "l"]
    # The person's own words for it ("Favourites"), or the device's name when it was added.
    title: str | None = Field(default=None, max_length=60)
    # "box/entity" for a device or the speaker music starts on.
    key: str | None = Field(default=None, max_length=200)
    # A room's id ("" is "not in a room yet").
    area: str | None = Field(default=None, max_length=120)
    items: list[str] | None = Field(default=None, max_length=MAX_ITEMS)


class LayoutBody(BaseModel):
    widgets: list[Widget] = Field(max_length=MAX_WIDGETS)


def _clean(widgets: list[Widget]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    items = 0
    for w in widgets:
        if w.id in seen:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Two widgets have the same id.")
        seen.add(w.id)
        for it in w.items or []:
            if len(it) > 200:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That's too long.")
        items += len(w.items or [])
        out.append(w.model_dump(exclude_none=True))
    if items > MAX_ITEMS_IN_ALL:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That's too many devices on one page.")
    return out


@router.get("/{home_id}/layout", dependencies=[Depends(_on)])
async def get_layout(home_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """``widgets`` is ``null`` until this person has customised this home's page."""
    await _membership(db, user, home_id)
    row = await db.get(HomeLayout, (home_id, user.id))
    return {"widgets": row.widgets if row is not None else None}


@router.put("/{home_id}/layout", dependencies=[Depends(_on)])
async def put_layout(home_id: uuid.UUID, body: LayoutBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    await _membership(db, user, home_id)
    widgets = _clean(body.widgets)
    row = await db.get(HomeLayout, (home_id, user.id))
    if row is None:
        db.add(HomeLayout(home_id=home_id, user_id=user.id, widgets=widgets))
    else:
        row.widgets = widgets
    await db.commit()
    return {"widgets": widgets}


@router.delete("/{home_id}/layout", dependencies=[Depends(_on)])
async def reset_layout(home_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    """Back to the page as it comes."""
    await _membership(db, user, home_id)
    row = await db.get(HomeLayout, (home_id, user.id))
    if row is not None:
        await db.delete(row)
        await db.commit()
    return {"widgets": None}
