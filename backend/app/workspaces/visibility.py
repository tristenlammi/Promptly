"""Who can see what inside a workspace — one rule each, used everywhere.

Private drafts (items) and private chats are visible only to their
creator. That rule used to be re-typed inline wherever someone remembered
it, so the overview's task rollup and recents, the trash and archive
lists, the activity feed, memory regeneration and export all forgot it
and leaked titles and content (roadmap R-039, R-040). New queries that
list workspace items or chats should filter through these helpers.
"""
from __future__ import annotations

import uuid

from sqlalchemy import or_

from app.chat.models import Conversation, WorkspaceItem


def item_visible_to(user_id: uuid.UUID):
    """Items shared with the workspace, plus the caller's own private drafts."""
    return or_(
        WorkspaceItem.visibility != "private",
        WorkspaceItem.created_by == user_id,
    )


def conversation_visible_to(user_id: uuid.UUID):
    """Chats shared with the workspace, plus the caller's own chats."""
    return or_(
        Conversation.visibility == "workspace",
        Conversation.user_id == user_id,
    )


def conversation_shared():
    """Chats shared with the workspace — for jobs that act for nobody in
    particular (memory regeneration, indexing), where "the caller's own"
    has no meaning and only shared content may be used."""
    return Conversation.visibility == "workspace"
