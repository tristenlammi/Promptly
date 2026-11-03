"""Tags API — one shared set per person (#tags).

    GET    /api/tags                      your tags (+ how many things each), ?q= filters
    POST   /api/tags                      create {name, color?}
    PATCH  /api/tags/{id}                 rename / recolour {name?, color?}
    DELETE /api/tags/{id}                 delete (taken off everything, apps included)
    POST   /api/tags/{id}/merge           {into}: everything tagged id is tagged into; id goes
    GET    /api/tags/{id}/items           everything with the tag, across apps — only what you can open
    POST   /api/tags/assign               {tag_id | name, kind, id}
    POST   /api/tags/unassign             {tag_id, kind, id}
    GET    /api/tags/entity?kind=&id=     your tags on one thing
    PUT    /api/tags/entity               {kind, id, names}: set them

``kind`` is ``file`` / ``event`` / ``album``, or a thing inside an app file
(``task``, ``contact``, ``journal_entry``, ``recipe``, ``transaction``) whose
``id`` is ``"<file_id>:<id in the file>"``. App things keep their tags in
their file, so tagging one edits the file (you need edit access).
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.tags import items_sync
from app.tags import service as T

router = APIRouter()


def _err(e: Exception) -> HTTPException:
    if isinstance(e, T.NotFound):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")
    if isinstance(e, T.TagConflict):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": f"You already have a tag called {e.other.name!r}.", "tag": T.tag_out(e.other)},
        )
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


_ERRORS = (T.NotFound, T.TagConflict, T.TagError)


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=9)


class TagPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, max_length=9)


class MergeIn(BaseModel):
    into: uuid.UUID


class AssignIn(BaseModel):
    tag_id: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=80)
    kind: str = Field(max_length=32)
    id: str = Field(min_length=1, max_length=120)


class EntityTagsIn(BaseModel):
    kind: str = Field(max_length=32)
    id: str = Field(min_length=1, max_length=120)
    names: list[str] = Field(default_factory=list, max_length=50)


@router.get("")
async def list_tags(
    q: str | None = Query(None, max_length=80),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    await items_sync.ensure_backfill(db, user)
    return {"tags": await T.list_tags(db, user, q)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_tag(body: TagIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        t = await T.create_tag(db, user, body.name, body.color)
    except _ERRORS as e:
        raise _err(e) from e
    await db.commit()
    return T.tag_out(t, 0)


# Before /{tag_id}: "entity" / "assign" aren't ids.
@router.get("/entity")
async def get_entity_tags(
    kind: str = Query(..., max_length=32),
    id: str = Query(..., min_length=1, max_length=120),  # noqa: A002
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return {"tags": await T.entity_tags(db, user, kind, id)}
    except _ERRORS as e:
        raise _err(e) from e


@router.put("/entity")
async def put_entity_tags(body: EntityTagsIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        tags = await T.set_entity_tags(db, user, body.kind, body.id, body.names)
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return {"tags": tags}


async def _tag_for(db: AsyncSession, user: User, body: AssignIn, *, create: bool) -> Any:
    if body.tag_id is not None:
        return await T.get_tag(db, user, body.tag_id)
    if not body.name or not create:
        raise T.TagError("Say which tag.")
    ids = await items_sync.tag_ids_for(db, user.id, [T.clean_name(body.name)])
    return await T.get_tag(db, user, next(iter(ids.values())))


@router.post("/assign")
async def assign(body: AssignIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        tag = await _tag_for(db, user, body, create=True)
        await T.assign(db, user, tag, body.kind, body.id)
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return {"tag": T.tag_out(tag)}


@router.post("/unassign", status_code=status.HTTP_204_NO_CONTENT)
async def unassign(body: AssignIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    try:
        tag = await _tag_for(db, user, body, create=False)
        await T.unassign(db, user, tag, body.kind, body.id)
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{tag_id}")
async def get_tag(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return T.tag_out(await T.get_tag(db, user, tag_id))
    except _ERRORS as e:
        raise _err(e) from e


@router.get("/{tag_id}/items")
async def tagged(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        await items_sync.ensure_backfill(db, user)
        tag = await T.get_tag(db, user, tag_id)
        return {"tag": T.tag_out(tag), "items": await T.tagged(db, user, tag)}
    except _ERRORS as e:
        raise _err(e) from e


@router.patch("/{tag_id}")
async def update_tag(
    tag_id: uuid.UUID, body: TagPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict[str, Any]:
    try:
        tag = await T.get_tag(db, user, tag_id)
        await T.update_tag(db, user, tag, name=body.name, color=body.color, set_color="color" in body.model_fields_set)
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return T.tag_out(tag)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(tag_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    try:
        await T.delete_tag(db, user, await T.get_tag(db, user, tag_id))
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{tag_id}/merge")
async def merge(tag_id: uuid.UUID, body: MergeIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        source = await T.get_tag(db, user, tag_id)
        target = await T.get_tag(db, user, body.into)
        await T.merge_tags(db, user, source, target)
    except _ERRORS as e:
        err = _err(e)  # before the rollback expires e.other
        await db.rollback()
        raise err from e
    await db.commit()
    return T.tag_out(target)
