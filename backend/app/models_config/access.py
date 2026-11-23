"""Shared model-access logic.

A user's effective allow-set (their own ``allowed_models`` UNIONed with the
models granted by every group they belong to) and the per-model
authorization check used by every chat send path. Kept in ONE place so
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

    The built-in Promptly model is in everyone's set, whatever their list
    says: it is the family's assistant, and the apps' own assistants run on
    it. Every other model, custom ones included, keeps the rule above.
    """
    if user.role == "admin" or user.allowed_models is None:
        return None
    everyone = await _builtin_model_ids(db)
    if user.model_locked:
        # Locked to what the admin picked — groups can't widen it.
        return set(user.allowed_models) | everyone
    return set(user.allowed_models) | await group_granted_models(user.id, db) | everyone


async def _builtin_model_ids(db: AsyncSession) -> set[str]:
    """The built-in Promptly model's synthetic id (``custom:<uuid>``), as a
    set; empty when this install has none."""
    from app.custom_models import builtin
    from app.custom_models.resolver import CUSTOM_MODEL_PREFIX

    cm_id = await builtin.builtin_id(db)
    return {f"{CUSTOM_MODEL_PREFIX}{cm_id}"} if cm_id else set()


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
