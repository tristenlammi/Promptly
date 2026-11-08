"""Who may do what with a form — the one definition every read goes through.

* :func:`form_access` — ``"none" | "read" | "edit"`` for a signed-in person,
  which is ``get_office_access`` on the form's shell: the owner and a Drive
  grant with ``can_edit`` edit (build, settings, link, answers); any other
  grant reads (the questions and the answers, read-only). A form in the
  trash is ``"none"`` to everyone.
* :func:`load_form` — the shell and form for a route, or a **404**. Never a
  403: someone who can't open a form can't tell it exists.
* :func:`answer_state` — whether an answer link can take answers now
  (WP-F1.3 builds the answer side on it).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms.models import Form

if TYPE_CHECKING:
    from app.auth.models import User
    from app.files.models import FileShareLink

FormAccess = Literal["none", "read", "edit"]
AnswerState = Literal["open", "closed", "sign_in", "gone"]

NOT_FOUND = "Form not found"


def not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


async def form_for_shell(db: AsyncSession, shell: UserFile, *, lock: bool = False) -> Form | None:
    stmt = select(Form).where(Form.file_id == shell.id)
    if lock:
        # Locked and re-read: the access check may have loaded it already.
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def form_access(db: AsyncSession, shell: UserFile, user: User) -> FormAccess:
    if shell.source_kind != GeneratedKind.FORM.value or user is None or getattr(user, "disabled", False):
        return "none"
    from app.files.office import get_office_access

    level = await get_office_access(db, shell, user)
    if level == "edit":
        return "edit"
    if level in ("read", "comment"):
        return "read"
    return "none"


async def load_form(
    db: AsyncSession,
    file_id: uuid.UUID,
    user: User,
    *,
    need: Literal["read", "edit"] = "read",
    lock: bool = False,
) -> tuple[UserFile, Form, FormAccess]:
    """(shell, form, access) — 404 unless ``user`` has at least ``need``."""
    shell = await db.get(UserFile, file_id)
    if shell is None or shell.source_kind != GeneratedKind.FORM.value:
        raise not_found()
    access = await form_access(db, shell, user)
    if access == "none" or (need == "edit" and access != "edit"):
        raise not_found()
    form = await form_for_shell(db, shell, lock=lock)
    if form is None:
        raise not_found()
    return shell, form, access


def is_closed(form: Form, *, now: datetime | None = None) -> bool:
    """Not taking answers: switched off, past its closing time, or full."""
    now = now or datetime.now(timezone.utc)
    if not form.accepting:
        return True
    if form.close_at is not None and form.close_at <= now:
        return True
    if form.max_responses is not None and (form.response_count or 0) >= form.max_responses:
        return True
    return False


def answer_state(
    *,
    form: Form | None,
    shell: UserFile | None,
    link: FileShareLink | None,
    user: User | None,
    link_answers_allowed: bool,
    now: datetime | None = None,
) -> AnswerState:
    """Whether a form link can take an answer from ``user`` (None: signed
    out). ``"gone"`` covers every way a link can be dead — unknown, revoked,
    expired, a form in the trash, link answers switched off by the admin —
    and the answer page shows the same words for all of them."""
    if form is None or shell is None or link is None:
        return "gone"
    if link.resource_type != "form" or link.resource_id != shell.id:
        return "gone"
    if link.revoked_at is not None:
        return "gone"
    now = now or datetime.now(timezone.utc)
    if link.expires_at is not None and link.expires_at <= now:
        return "gone"
    if shell.trashed_at is not None or shell.source_kind != GeneratedKind.FORM.value:
        return "gone"
    if form.audience == "link":
        if not link_answers_allowed:
            return "gone"
    elif user is None or getattr(user, "disabled", False):
        return "sign_in"
    if is_closed(form, now=now):
        return "closed"
    return "open"


async def link_answers_allowed(db: AsyncSession) -> bool:
    """The admin switch for "Anyone with the link" (on unless turned off)."""
    from app.app_settings.models import AppSettings

    row = (await db.execute(select(AppSettings.forms_link_answers).limit(1))).first()
    return True if row is None or row[0] is None else bool(row[0])


__all__ = [
    "AnswerState",
    "FormAccess",
    "answer_state",
    "form_access",
    "form_for_shell",
    "is_closed",
    "link_answers_allowed",
    "load_form",
    "not_found",
]
