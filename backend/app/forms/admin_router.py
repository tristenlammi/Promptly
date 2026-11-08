"""Admin → Forms, ``/api/admin/forms`` (WP-F1.3).

What a server admin can do about forms, and nothing more:

* turn answers from people without an account on or off for the whole
  server (``app_settings.forms_link_answers``; off makes every link form
  answer "doesn't exist");
* see the forms anyone with the link can answer — title, owner, number of
  answers, when it was made, and reports — and read the reports;
* close one of them, with a reason the owner is told.

Admins can't read a form's answers from here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.database import get_db
from app.files.models import UserFile
from app.forms.access import is_closed, link_answers_allowed
from app.forms.models import Form, FormReport

router = APIRouter()


async def _listing(db: AsyncSession) -> list[dict[str, Any]]:
    reports = (
        select(
            FormReport.form_id.label("form_id"),
            func.count().label("n"),
            func.max(FormReport.created_at).label("last"),
        )
        .group_by(FormReport.form_id)
        .subquery()
    )
    rows = (
        await db.execute(
            select(Form, UserFile, User.username, reports.c.n, reports.c.last)
            .join(UserFile, UserFile.id == Form.file_id)
            .join(User, User.id == UserFile.user_id, isouter=True)
            .join(reports, reports.c.form_id == Form.id, isouter=True)
            .where(or_(Form.audience == "link", reports.c.n.is_not(None)))
            .order_by(func.coalesce(reports.c.last, Form.created_at).desc())
        )
    ).all()
    out = []
    for form, shell, owner, n, last in rows:
        out.append(
            {
                "form_id": str(form.id),
                "title": (form.definition or {}).get("title") or "Untitled form",
                "owner": owner,
                "audience": form.audience,
                "answers": form.response_count or 0,
                "created_at": form.created_at.isoformat() if form.created_at else None,
                "state": "trashed" if shell.trashed_at is not None else ("closed" if is_closed(form) else "open"),
                "reports": int(n or 0),
                "last_report_at": last.isoformat() if last else None,
            }
        )
    return out


@router.get("")
async def overview(db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)) -> dict:
    return {"link_answers": await link_answers_allowed(db), "forms": await _listing(db)}


class _Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    link_answers: bool


@router.patch("/settings")
async def change_settings(
    payload: _Settings, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)
) -> dict:
    """Answers from people without an account, on or off for everyone."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.forms_link_answers = payload.link_answers
    await db.commit()
    return {"link_answers": payload.link_answers, "forms": await _listing(db)}


@router.get("/{form_id:uuid}/reports")
async def reports(
    form_id: uuid.UUID, db: AsyncSession = Depends(get_db), _admin: User = Depends(require_admin)
) -> dict:
    """The reports on one form, newest first. Their words are a stranger's:
    shown as plain text."""
    rows = (
        await db.execute(
            select(FormReport).where(FormReport.form_id == form_id).order_by(FormReport.created_at.desc()).limit(200)
        )
    ).scalars().all()
    return {
        "reports": [
            {"id": str(r.id), "reason": r.reason, "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ]
    }


class _Close(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)


@router.post("/{form_id:uuid}/close")
async def close_form(
    form_id: uuid.UUID,
    payload: _Close,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """Stop a form taking answers. Its owner is told, with the reason."""
    from app.notifications.dispatch import notify_user

    form = (
        await db.execute(select(Form).where(Form.id == form_id).with_for_update())
    ).scalar_one_or_none()
    if form is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Form not found")
    shell = await db.get(UserFile, form.file_id)
    form.accepting = False
    form.updated_at = datetime.now(timezone.utc)
    await db.commit()
    title = (form.definition or {}).get("title") or "Untitled form"
    if shell is not None and shell.user_id and shell.user_id != admin.id:
        await notify_user(
            user_id=shell.user_id,
            category="form_response",
            title=f"An admin closed “{title}”",
            body=f"It isn't taking answers any more. The reason given: {payload.reason.strip()}",
            url=f"/files/form/{shell.id}",
            tag=f"form-closed:{form.id}",
            extra={"kind": "closed"},
        )
    return {"link_answers": await link_answers_allowed(db), "forms": await _listing(db)}


__all__ = ["router"]
