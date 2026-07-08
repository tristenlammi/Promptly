"""In-app feedback → the maintainer's inbox, via the instance's own SMTP.

Why this shape
--------------
Promptly is self-hosted on isolated networks (often behind tunnels), so there
is no central service to POST to and no way for the maintainer to reach into
an instance. Instead, feedback is emailed out through the *instance's own*
configured SMTP account (the same one set up for MFA / notifications), with
``Reply-To`` set to the submitting user so replies land with them, not the
relay account. The recipient defaults to the maintainer (``FEEDBACK_EMAIL``)
so feedback reaches upstream; a self-hoster can repoint it at their own inbox.

When SMTP isn't configured (or the send fails) we don't error — we return a
``delivered: false`` with the destination address so the frontend can fall
back to a ``mailto:`` compose in the user's own mail client.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from limits import parse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.config import get_settings
from app.database import get_db
from app.mfa.smtp import SmtpNotConfiguredError, SmtpSendError, send_message
from app.rate_limit import rate_limit

logger = logging.getLogger(__name__)
_settings = get_settings()

router = APIRouter()


class FeedbackRequest(BaseModel):
    message: str = Field(min_length=1, max_length=5000)
    # When true, the submitter's email rides along as Reply-To so the
    # maintainer can reply directly. Off = anonymous-ish (username only).
    include_email: bool = True


class FeedbackResponse(BaseModel):
    delivered: bool
    # ``smtp_not_configured`` | ``send_failed`` — lets the frontend decide
    # whether to offer the mailto: fallback.
    reason: str | None = None
    # Destination for the mailto: fallback when we couldn't send server-side.
    fallback_to: str | None = None


def _compose_body(message: str, user: User, request: Request) -> str:
    origin = (
        request.headers.get("origin")
        or request.headers.get("referer")
        or request.headers.get("host")
        or "unknown"
    )
    sent = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"{message.strip()}\n\n"
        "----------------------------------------\n"
        f"From: {user.username} <{user.email}>\n"
        f"Instance: {origin}\n"
        f"User ID: {user.id}\n"
        f"Sent: {sent}\n"
    )


@router.post(
    "",
    response_model=FeedbackResponse,
    dependencies=[Depends(rate_limit(parse("6/hour"), bucket="feedback"))],
)
async def submit_feedback(
    payload: FeedbackRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FeedbackResponse:
    """Email a user's feedback to ``FEEDBACK_EMAIL`` via the instance SMTP."""
    to = _settings.FEEDBACK_EMAIL
    reply_to = user.email if (payload.include_email and user.email) else None
    try:
        await send_message(
            db,
            to=to,
            subject=f"Promptly feedback from {user.username}",
            text_body=_compose_body(payload.message, user, request),
            reply_to=reply_to,
        )
        return FeedbackResponse(delivered=True)
    except SmtpNotConfiguredError:
        # Not an error the user caused — the instance just has no SMTP. Let
        # the frontend offer a mailto: compose instead.
        return FeedbackResponse(
            delivered=False, reason="smtp_not_configured", fallback_to=to
        )
    except SmtpSendError:
        logger.exception("Feedback email send failed")
        return FeedbackResponse(
            delivered=False, reason="send_failed", fallback_to=to
        )
