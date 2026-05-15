"""Non-admin read of the workspace-wide model defaults.

Most of ``app_settings`` is admin-only (SMTP creds, MFA, quota
caps, …). A small subset, though, drives client-side UI for *every*
user — specifically the global "default chat model" that a new
user's picker should fall back to before any personal preference
exists. Exposing the entire ``app_settings`` row to non-admins would
leak SMTP / origin / quota config; instead this module ships a
focused read-only view of just the safe-to-publish defaults.

Endpoint
--------
``GET /api/workspace-defaults`` (authenticated, any role)
    Returns the resolved workspace defaults so the frontend's model
    picker can prefer the admin's default chat model over the
    historical "first available" fallback when the user hasn't set a
    personal default.

Security
--------
Authentication is still required — public unauthenticated access
isn't useful and would invite enumeration of which models are
configured. The data itself is non-sensitive (just provider id +
model id), so any authenticated user can read it.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db

router = APIRouter()


class WorkspaceDefaults(BaseModel):
    """Subset of ``app_settings`` safe to expose to non-admin users.

    Two pairs of fields, both following the same convention as the
    admin response:

    * ``default_chat_*`` — workspace-wide fallback chat model used by
      ``modelStore`` when a user has no personal default on their
      Account page.
    * ``vision_relay_*`` — pair identifying the relay model. The
      *model id* is included (not just a boolean) so the chat composer
      can show the user something more specific than "yep, it'll be
      relayed" when an image is queued against a non-vision model.
      The model id is already visible to the user on the relay chips
      that render during a streamed turn, so exposing it here doesn't
      leak anything new.

    Both halves are exposed nullable individually so the frontend can
    do its own ``configured = id1 && id2`` check without a second
    round-trip.
    """

    default_chat_provider_id: uuid.UUID | None
    default_chat_model_id: str | None
    vision_relay_provider_id: uuid.UUID | None
    vision_relay_model_id: str | None


@router.get("", response_model=WorkspaceDefaults)
async def get_workspace_defaults(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
) -> WorkspaceDefaults:
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        # Singleton row is seeded by bootstrap.py on every container
        # start; falling open to "no defaults" here keeps the API
        # alive on a brand-new install where the bootstrap hasn't
        # quite finished yet.
        return WorkspaceDefaults(
            default_chat_provider_id=None,
            default_chat_model_id=None,
            vision_relay_provider_id=None,
            vision_relay_model_id=None,
        )
    return WorkspaceDefaults(
        default_chat_provider_id=row.default_chat_provider_id,
        default_chat_model_id=row.default_chat_model_id,
        vision_relay_provider_id=row.vision_relay_provider_id,
        vision_relay_model_id=row.vision_relay_model_id,
    )
