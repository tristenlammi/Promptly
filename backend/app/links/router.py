"""Links API, mounted at ``/api/connections`` (``/api/links`` is the URL unfurler).

  GET    /?kind=&id=          "Mentioned in" and "Linked" for a thing you can see
  POST   /                    link two things you can both see   {a: {kind, id}, b: {kind, id}}
  DELETE /{link_id}           take a link off (you must see both sides)
  GET    /search?q=           the picker: things across apps
  GET    /resolve?kind=&id=   one thing as you see it (where ``/link/<kind>/<id>`` goes)

Anything you can't see is a 404, never a 403 — nothing is probeable.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

from . import refs, search as search_mod, service
from .models import EntityLink

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


async def _visible(db: AsyncSession, user: User, kind: str, id_: str) -> dict:
    got = await refs.resolve(db, user, kind, id_)
    if got is None:
        raise _not_found()
    return got


@router.get("")
async def connections(
    kind: str = Query(..., max_length=16),
    id: str = Query(..., min_length=1, max_length=120),  # noqa: A002
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    await _visible(db, user, kind, id)
    return await service.connections(db, user, kind, id)


@router.get("/resolve")
async def resolve(
    kind: str = Query(..., max_length=16),
    id: str = Query(..., min_length=1, max_length=120),  # noqa: A002
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return await _visible(db, user, kind, id)


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(6, ge=1, le=20),
    kinds: str | None = Query(None, max_length=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    want = {k.strip() for k in kinds.split(",")} if kinds else None
    return {"results": await search_mod.search(db, user, q, limit=limit, kinds=want)}


class RefIn(BaseModel):
    kind: str = Field(max_length=16)
    id: str = Field(min_length=1, max_length=120)


class LinkIn(BaseModel):
    a: RefIn
    b: RefIn


@router.post("", status_code=201)
async def add(body: LinkIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    a, b = (body.a.kind, body.a.id), (body.b.kind, body.b.id)
    if not refs.valid(*a) or not refs.valid(*b):
        raise _not_found()
    if (refs.store_kind(a[0]), refs.normalise(*a)) == (refs.store_kind(b[0]), refs.normalise(*b)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A thing can't be linked to itself.")
    row = await service.add_link(db, user, a, b)
    if row is None:
        raise _not_found()
    await db.commit()
    other = await refs.resolve(db, user, *b)
    return {**(other or {}), "link_id": str(row.id), "at": row.created_at.isoformat(), "can_remove": True}


@router.delete("/{link_id}", status_code=204, response_class=Response)
async def remove(link_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    row = await db.get(EntityLink, link_id)
    if row is None or not await service.can_remove(db, user, row):
        raise _not_found()
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
