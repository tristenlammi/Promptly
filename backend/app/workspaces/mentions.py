"""@-mention detection for workspace comments.

One tiny contract shared by item comments and board-card comments:
scan the posted text for ``@username`` tokens, resolve them against the
workspace's members (owner + accepted collaborators — nobody outside
the room can be summoned into it), and fan out a ``mention``
notification (inbox row + push) to everyone named except the author.

Matching is case-insensitive on the whole username; usernames are the
existing 64-char handles, so the token regex mirrors the registration
charset instead of guessing at word boundaries.
"""
from __future__ import annotations

import logging
import re
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Workspace
from app.workspaces.shares import load_workspace_participants

logger = logging.getLogger("promptly.workspaces.mentions")

# ``@`` followed by a plausible handle. Preceded by start/whitespace so
# emails ("a@b.com") don't read as mentions of "b.com".
_MENTION_RE = re.compile(r"(?:^|(?<=\s))@([A-Za-z0-9][A-Za-z0-9_.\-]{0,63})")

_SNIPPET_LEN = 140


def extract_mention_handles(text: str) -> list[str]:
    """Lower-cased candidate handles, order-preserving, deduped."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _MENTION_RE.finditer(text or ""):
        handle = m.group(1).lower()
        if handle not in seen:
            seen.add(handle)
            out.append(handle)
    return out


async def notify_comment_mentions(
    db: AsyncSession,
    *,
    ws: Workspace,
    author: User,
    text: str,
    url: str,
    where: str,
) -> None:
    """Notify every mentioned workspace member (except the author).

    Best-effort: mention delivery must never fail the comment POST that
    triggered it. ``where`` is the human label for the push/inbox title
    ("a comment on Research", "a card on Board")."""
    try:
        handles = extract_mention_handles(text)
        if not handles:
            return
        participants = await load_workspace_participants(ws, db)
        members = [participants.owner, *participants.collaborators]
        by_handle = {m.username.lower(): m for m in members}
        snippet = text.strip()
        if len(snippet) > _SNIPPET_LEN:
            snippet = snippet[: _SNIPPET_LEN - 1] + "…"

        from app.notifications import notify_user

        for handle in handles:
            member = by_handle.get(handle)
            if member is None or member.user_id == author.id:
                continue
            await notify_user(
                user_id=member.user_id,
                category="mention",
                title=f"{author.username} mentioned you in {where}",
                body=snippet,
                url=url,
                tag=f"promptly-mention-{ws.id}",
                actor_user_id=author.id,
                workspace_id=ws.id,
            )
    except Exception:  # pragma: no cover — never break the comment POST
        logger.warning("mention fan-out failed", exc_info=True)


async def notify_assignment(
    db: AsyncSession,
    *,
    ws: Workspace,
    actor: User,
    assignee_user_id: uuid.UUID,
    card_title: str,
    url: str,
) -> None:
    """Tell someone a card just landed on their plate (not self-assigns)."""
    try:
        if assignee_user_id == actor.id:
            return
        from app.notifications import notify_user

        await notify_user(
            user_id=assignee_user_id,
            category="assignment",
            title=f"{actor.username} assigned you a card",
            body=card_title,
            url=url,
            tag=f"promptly-assign-{ws.id}",
            actor_user_id=actor.id,
            workspace_id=ws.id,
        )
    except Exception:  # pragma: no cover
        logger.warning("assignment notification failed", exc_info=True)
