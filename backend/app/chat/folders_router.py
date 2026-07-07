"""Personal chat folders — CRUD API (0148).

User-facing management of the folders that group personal chats in the
sidebar. Every endpoint is owner-scoped via ``get_current_user``; a folder
belonging to someone else 404s (never 403s) so its existence isn't probeable
— same contract as the memory router.

The folder's ``system_prompt`` is applied LIVE to contained chats (merged in
the chat stream), and its ``default_model_id`` / ``default_provider_id`` are
used as the pre-selected model when a chat is created in the folder — see
``app.chat.router.create_conversation``.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import ChatFolder, Conversation
from app.chat.schemas import (
    ChatFolderCreate,
    ChatFolderResponse,
    ChatFolderUpdate,
)
from app.database import get_db

router = APIRouter()

# A generous ceiling so the sidebar list stays sane and a script can't
# create folders unbounded. Well above any realistic personal use.
_MAX_FOLDERS = 100


async def _chat_counts(db: AsyncSession, user_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """``{folder_id: active_chat_count}`` for the user's folders in one query.

    Counts only active (non-archived) top-level chats, matching what the
    sidebar actually renders inside each folder.
    """
    rows = (
        await db.execute(
            select(Conversation.folder_id, func.count())
            .where(
                Conversation.user_id == user_id,
                Conversation.folder_id.is_not(None),
                Conversation.archived_at.is_(None),
            )
            .group_by(Conversation.folder_id)
        )
    ).all()
    return {fid: int(n) for fid, n in rows if fid is not None}


def _to_response(folder: ChatFolder, chat_count: int) -> ChatFolderResponse:
    return ChatFolderResponse(
        id=folder.id,
        name=folder.name,
        system_prompt=folder.system_prompt,
        default_model_id=folder.default_model_id,
        default_provider_id=folder.default_provider_id,
        chat_count=chat_count,
        created_at=folder.created_at,
        updated_at=folder.updated_at,
    )


async def _get_owned(
    folder_id: uuid.UUID, user: User, db: AsyncSession
) -> ChatFolder:
    folder = await db.get(ChatFolder, folder_id)
    if folder is None or folder.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found"
        )
    return folder


@router.get("", response_model=list[ChatFolderResponse])
async def list_folders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ChatFolderResponse]:
    folders = (
        (
            await db.execute(
                select(ChatFolder)
                .where(ChatFolder.user_id == user.id)
                .order_by(ChatFolder.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    counts = await _chat_counts(db, user.id)
    return [_to_response(f, counts.get(f.id, 0)) for f in folders]


@router.post("", response_model=ChatFolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(
    payload: ChatFolderCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChatFolderResponse:
    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Folder name is required.",
        )
    existing = int(
        await db.scalar(
            select(func.count())
            .select_from(ChatFolder)
            .where(ChatFolder.user_id == user.id)
        )
        or 0
    )
    if existing >= _MAX_FOLDERS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You've reached the maximum of {_MAX_FOLDERS} folders.",
        )
    folder = ChatFolder(
        user_id=user.id,
        name=name,
        system_prompt=(payload.system_prompt or "").strip() or None,
        default_model_id=payload.default_model_id,
        default_provider_id=payload.default_provider_id,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return _to_response(folder, 0)


@router.patch("/{folder_id}", response_model=ChatFolderResponse)
async def update_folder(
    folder_id: uuid.UUID,
    payload: ChatFolderUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChatFolderResponse:
    folder = await _get_owned(folder_id, user, db)

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Folder name is required.",
            )
        folder.name = name
    # Prompt + model defaults use ``model_fields_set`` so an explicit null
    # clears them while an omitted field leaves them untouched.
    if "system_prompt" in payload.model_fields_set:
        folder.system_prompt = (payload.system_prompt or "").strip() or None
    if "default_model_id" in payload.model_fields_set:
        folder.default_model_id = payload.default_model_id or None
    if "default_provider_id" in payload.model_fields_set:
        folder.default_provider_id = payload.default_provider_id

    await db.commit()
    await db.refresh(folder)
    counts = await _chat_counts(db, user.id)
    return _to_response(folder, counts.get(folder.id, 0))


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Delete a folder. Its chats are lifted back to top-level automatically
    via the ``conversations.folder_id`` ON DELETE SET NULL — history is never
    touched."""
    folder = await _get_owned(folder_id, user, db)
    await db.execute(delete(ChatFolder).where(ChatFolder.id == folder.id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
