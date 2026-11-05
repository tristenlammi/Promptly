"""Crashes from the Android app, in the same place as the server's own errors:
Admin → Console → Errors.

The phone sends what it has next time it runs, because a crashed app can't send
anything. Sending the same crash again changes nothing, and a broken phone can't
fill the table. Admins get a notification when a fault is new, or back after being
resolved, not every time it happens again.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.basic import client_ip, user_from_basic
from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.observability.capture import fingerprint
from app.observability.models import ErrorEvent

logger = logging.getLogger("promptly.observability.phone")

router = APIRouter()
_bearer = HTTPBearer(auto_error=False)

LOGGER = "android"
CONSOLE = "/admin?tab=console&view=errors&source=android"
_DAILY_LIMIT = 100
_MOST_ALERTS = 3  # at once: a phone's first report can hold old crashes
_OLDEST = timedelta(days=60)
_KINDS = {
    "crash": "Crash",
    "native": "Native crash",
    "anr": "App not responding",
    "memory": "Out of memory",
    "startup": "Failed to start",
}
# An exception's message can quote a URL or a request. Nothing secret stays in it.
_SECRET = re.compile(
    r"(?i)\b(password|passwd|token|secret|api[_-]?key|key|code|authorization)\b(\s*[=:]\s*)(?:basic\s+|bearer\s+)?[^\s&\"',;)]+"
)
_VOLATILE = re.compile(r"0x[0-9a-fA-F]+|@[0-9a-fA-F]{5,}")


def scrub(text: str) -> str:
    return _SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}[removed]", text)


class Report(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    at: datetime
    kind: Literal["crash", "native", "anr", "memory", "startup"]
    thread: str = Field(default="", max_length=120)
    message: str = Field(default="", max_length=2000)
    stack: str = Field(default="", max_length=40_000)


class Reports(BaseModel):
    app_version: str = Field(default="", max_length=40)
    device: str = Field(default="", max_length=120)
    android: str = Field(default="", max_length=20)
    reports: list[Report] = Field(max_length=20)


async def phone_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Every paired phone has ``upload``, however long ago it was paired."""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        return await user_from_basic(db, header, scope="upload", ip=client_ip(request))
    return await get_current_user(request, credentials, db)


@router.post("/crashes")
async def report_crashes(body: Reports, db: AsyncSession = Depends(get_db), user: User = Depends(phone_user)) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    keys = [r.key for r in body.reports]
    seen = set(
        (
            await db.execute(
                select(ErrorEvent.request_id).where(
                    ErrorEvent.logger == LOGGER, ErrorEvent.user_id == user.id, ErrorEvent.request_id.in_(keys)
                )
            )
        ).scalars()
    )
    recent = (
        await db.scalar(
            select(func.count(ErrorEvent.id)).where(
                ErrorEvent.logger == LOGGER, ErrorEvent.user_id == user.id, ErrorEvent.created_at >= now - timedelta(days=1)
            )
        )
        or 0
    )
    # The version sending it: a crash from before an update is reported by the new one.
    version = f"Reported by Android app {body.app_version}".strip()
    where = " · ".join(p for p in (version, body.device, f"Android {body.android}" if body.android else "") if p)
    added = 0
    fresh: dict[str, str] = {}
    for r in body.reports:
        if r.key in seen or recent + added >= _DAILY_LIMIT:
            continue
        seen.add(r.key)
        title = _KINDS[r.kind]
        message = scrub(r.message.strip()) or title
        first = message.splitlines()[0]
        # "java.lang.IllegalStateException: why": the class names it.
        named = re.match(r"^([\w.$]+(?:Exception|Error))\b", first)
        klass = named.group(1) if named else title
        when = r.at if r.at.tzinfo else r.at.replace(tzinfo=timezone.utc)
        mark = fingerprint(level="CRITICAL", logger_name=LOGGER, exception_class=klass, message=_VOLATILE.sub("<addr>", first))
        fresh.setdefault(mark, first)
        extra: dict[str, Any] = {
            "kind": r.kind,
            "thread": r.thread,
            "happened_at": when.isoformat(),
            "app_version": body.app_version,
            "device": body.device,
            "android": body.android,
        }
        db.add(
            ErrorEvent(
                id=uuid.uuid4(),
                # When it happened, not when the phone next got to say so.
                created_at=when if now - _OLDEST <= when <= now + timedelta(minutes=5) else now,
                fingerprint=mark,
                level="CRITICAL",
                logger=LOGGER,
                exception_class=klass[:128],
                message=message[:8000],
                stack=scrub(r.stack) or None,
                route=where[:255] or None,
                request_id=r.key,
                user_id=user.id,
                extra=extra,
            )
        )
        added += 1
    # Still open from before: you've already been told about this one.
    known = set(
        (
            await db.execute(
                select(ErrorEvent.fingerprint).where(
                    ErrorEvent.fingerprint.in_(list(fresh)),
                    ErrorEvent.resolved_at.is_(None),
                    ErrorEvent.request_id.not_in(keys),
                )
            )
        ).scalars()
    )
    await db.commit()
    alerts = [message for mark, message in fresh.items() if mark not in known]
    if alerts:
        await tell_admins(alerts, user.username, body.device)
    return {"added": added}


async def tell_admins(faults: list[str], who: str, device: str) -> None:
    """Never in the way of the phone's report: the row is already saved."""
    from app.database import SessionLocal
    from app.notifications.dispatch import notify_user

    try:
        async with SessionLocal() as db:
            admins = (await db.execute(select(User.id).where(User.role == "admin", User.disabled.is_(False)))).scalars().all()
        place = f"{who} on {device}" if device else who
        for fault in faults[:_MOST_ALERTS]:
            for admin in admins:
                await notify_user(
                    user_id=admin,
                    category="system_alert",
                    title="The Android app crashed",
                    body=f"{fault[:160]} ({place})",
                    url=CONSOLE,
                )
        if len(faults) > _MOST_ALERTS:
            for admin in admins:
                await notify_user(
                    user_id=admin,
                    category="system_alert",
                    title="More Android app crashes",
                    body=f"{len(faults) - _MOST_ALERTS} more from {place}.",
                    url=CONSOLE,
                )
    except Exception:  # noqa: BLE001 - an alert must never break a report
        logger.warning("couldn't tell admins about a phone crash", exc_info=True)
