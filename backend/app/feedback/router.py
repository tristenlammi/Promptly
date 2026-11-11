"""In-app feedback: a short message from a person to this server's admins.

The "Send feedback" button stores the message here (``feedback_messages``),
tells every admin with a notification that links to Admin → Feedback, and,
when this server has email set up, emails the admins too (Reply-To the
sender). Nothing leaves the server for anyone else: there is no outside
address and no ``mailto:`` fallback.

Admin privacy: this is the person deliberately writing to the admin, so the
admin reading it fits the rule. A row is the words and who wrote them. It
never carries what they were looking at (no page address, no chat id), and
the notification and email don't either.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from limits import parse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.background import spawn
from app.database import get_db
from app.feedback.models import FeedbackMessage
from app.rate_limit import rate_limit

logger = logging.getLogger(__name__)

router = APIRouter()
admin_router = APIRouter()

ADMIN_URL = "/admin?tab=feedback"
MAX_CHARS = 5000


class FeedbackRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_CHARS)

    @field_validator("message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Write a message first.")
        return v


class FeedbackResponse(BaseModel):
    sent: bool = True


async def _admins(db: AsyncSession) -> list[tuple[uuid.UUID, str | None]]:
    rows = await db.execute(
        select(User.id, User.email).where(User.role == "admin", User.disabled.is_(False))
    )
    return [(r[0], r[1]) for r in rows.all()]


async def email_admins(to: list[str], *, sender: str, reply_to: str | None, message: str) -> None:
    """Best effort, off the request: a server without email, or a mail
    server that's down, is never the sender's problem."""
    from app.database import SessionLocal
    from app.mfa import smtp

    body = (
        f"{sender} sent feedback from your Promptly server:\n\n"
        f"{message}\n\n"
        "It's also under Admin → Feedback. Reply to this email to answer them."
    )
    try:
        async with SessionLocal() as db:
            for address in to:
                try:
                    await smtp.send_message(
                        db,
                        to=address,
                        subject=f"Promptly feedback from {sender}",
                        text_body=body,
                        reply_to=reply_to,
                    )
                except smtp.SmtpNotConfiguredError:
                    return
                except Exception:  # noqa: BLE001
                    logger.info("feedback email to an admin not sent")
    except Exception:  # noqa: BLE001
        logger.info("feedback emails not sent")


@router.post(
    "",
    response_model=FeedbackResponse,
    dependencies=[Depends(rate_limit(parse("6/hour"), bucket="feedback"))],
)
async def submit_feedback(
    payload: FeedbackRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> FeedbackResponse:
    """Keep the message for this server's admins and tell them."""
    sender, sender_id, reply_to = user.username, user.id, user.email or None
    db.add(FeedbackMessage(user_id=sender_id, message=payload.message))
    await db.commit()

    admins = await _admins(db)
    from app.notifications import dispatch

    for admin_id, _email in admins:
        try:
            await dispatch.notify_user(
                user_id=admin_id,
                category="system_alert",
                title=f"{sender} sent feedback",
                body="Read it under Admin → Feedback.",
                url=ADMIN_URL,
                tag="feedback",
            )
        except Exception:  # noqa: BLE001 — the message is saved; telling is best effort
            logger.warning("couldn't tell an admin about feedback", exc_info=True)

    addresses = [e for _id, e in admins if e]
    if addresses:
        spawn(
            email_admins(addresses, sender=sender, reply_to=reply_to, message=payload.message),
            name="feedback-email",
        )
    return FeedbackResponse()


# ------------------------------------------------------------- Admin → Feedback


class FeedbackRow(BaseModel):
    id: uuid.UUID
    # None once the account is gone.
    user_id: uuid.UUID | None
    username: str | None
    message: str
    created_at: datetime
    read: bool


class FeedbackList(BaseModel):
    items: list[FeedbackRow]
    unread: int


class ReadRequest(BaseModel):
    read: bool = True


def _row(m: FeedbackMessage, username: str | None) -> FeedbackRow:
    return FeedbackRow(
        id=m.id, user_id=m.user_id, username=username, message=m.message,
        created_at=m.created_at, read=m.read_at is not None,
    )


@admin_router.get("", response_model=FeedbackList)
async def list_feedback(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> FeedbackList:
    rows = (
        await db.execute(
            select(FeedbackMessage, User.username)
            .join(User, User.id == FeedbackMessage.user_id, isouter=True)
            .order_by(FeedbackMessage.created_at.desc(), FeedbackMessage.id)
            .limit(500)
        )
    ).all()
    unread = (
        await db.execute(
            select(func.count()).select_from(FeedbackMessage).where(FeedbackMessage.read_at.is_(None))
        )
    ).scalar_one()
    return FeedbackList(items=[_row(m, name) for m, name in rows], unread=int(unread))


@admin_router.post("/{feedback_id}/read", response_model=FeedbackRow)
async def mark_feedback_read(
    feedback_id: uuid.UUID,
    payload: ReadRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> FeedbackRow:
    m = await db.get(FeedbackMessage, feedback_id)
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That message is gone.")
    m.read_at = datetime.now(timezone.utc) if payload.read else None
    await db.commit()
    await db.refresh(m)
    name = None
    if m.user_id:
        name = (await db.execute(select(User.username).where(User.id == m.user_id))).scalar_one_or_none()
    return _row(m, name)


@admin_router.delete("/{feedback_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_feedback(
    feedback_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> Response:
    m = await db.get(FeedbackMessage, feedback_id)
    if m is not None:
        await db.delete(m)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
