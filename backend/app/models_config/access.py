"""Shared model-access logic.

A user's effective allow-set (their own ``allowed_models`` UNIONed with the
models granted by every group they belong to) and the per-model
authorization check used by every chat/study send path. Kept in ONE place so
the picker (``list_available_models_for``) and the send-time guards can never
diverge — otherwise a group-granted model shows in the dropdown but 403s on
use.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User


async def group_granted_models(
    user_id: uuid.UUID, db: AsyncSession
) -> set[str]:
    """Union of ``allowed_models`` across every group the user belongs to."""
    from app.groups.models import UserGroup, UserGroupMember

    rows = (
        (
            await db.execute(
                select(UserGroup.allowed_models)
                .join(
                    UserGroupMember,
                    UserGroupMember.group_id == UserGroup.id,
                )
                .where(UserGroupMember.user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    out: set[str] = set()
    for lst in rows:
        if lst:
            out.update(lst)
    return out


async def effective_allow_set(
    user: User, db: AsyncSession
) -> set[str] | None:
    """Model ids the user may use, or ``None`` = unrestricted.

    ``None`` for admins and for any user whose ``allowed_models`` is NULL
    (full access). Groups can only WIDEN a custom list, never narrow full
    access.
    """
    if user.role == "admin" or user.allowed_models is None:
        return None
    return set(user.allowed_models) | await group_granted_models(user.id, db)


async def is_model_allowed(
    user: User,
    db: AsyncSession,
    *,
    model_id: str,
    base_model_id: str,
) -> bool:
    """Whether ``user`` may use the chosen model.

    ``model_id`` is what the user picked (possibly a synthetic
    ``custom:<uuid>``); ``base_model_id`` is the resolved underlying model.
    Allowed when the user is unrestricted, or the allow-set names the custom
    id directly OR its base model (the legacy piggyback).
    """
    allow = await effective_allow_set(user, db)
    if allow is None:
        return True
    return model_id in allow or base_model_id in allow
