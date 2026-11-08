"""The Forms home (``/forms``): your forms, and forms shared with you.

Forms are ordinary files, so this is a Files query on ``source_kind='form'``
— a form made in any folder shows here too — plus each form's counts:
answers, answers new since you last looked (``form_notify.seen_at``), and
whether it's taking answers. Access is the same as Files: your own forms,
and forms someone gave you (a grant on the form or on a folder above it).
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms import service
from app.forms.access import form_access, is_closed
from app.forms.models import Form, FormNotify, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User

Scope = Literal["mine", "shared"]
MAX_ROWS = 500


async def _shared_file_ids(db: AsyncSession, user: User) -> list[uuid.UUID]:
    """Form shells someone shared with ``user``: a grant on the form, or on
    a folder above it."""
    from app.files.sharing import expand_folder_subtree, file_ids_caller_is_granted, folder_ids_caller_is_granted

    direct = await file_ids_caller_is_granted(db, user)
    folders = await expand_folder_subtree(db, await folder_ids_caller_is_granted(db, user))
    if not direct and not folders:
        return []
    conds = []
    if direct:
        conds.append(UserFile.id.in_(direct))
    if folders:
        conds.append(UserFile.folder_id.in_(folders))
    rows = await db.execute(
        select(UserFile.id).where(
            or_(*conds),
            UserFile.source_kind == GeneratedKind.FORM.value,
            UserFile.trashed_at.is_(None),
            UserFile.user_id != user.id,
        )
    )
    return list(rows.scalars())


async def list_forms(db: AsyncSession, user: User, *, scope: Scope = "mine") -> list[dict[str, Any]]:
    """The home page's cards, most recently changed first."""
    from app.auth.models import User as UserModel

    stmt = (
        select(UserFile, Form)
        .join(Form, Form.file_id == UserFile.id)
        .where(UserFile.source_kind == GeneratedKind.FORM.value, UserFile.trashed_at.is_(None))
    )
    if scope == "mine":
        stmt = stmt.where(UserFile.user_id == user.id)
    else:
        ids = await _shared_file_ids(db, user)
        if not ids:
            return []
        stmt = stmt.where(UserFile.id.in_(ids))
    rows = (await db.execute(stmt.order_by(UserFile.modified_at.desc()).limit(MAX_ROWS))).all()
    if not rows:
        return []

    if scope == "shared":
        # The grant check, once more per form (a folder grant can be on a
        # folder the owner since moved the form out of).
        rows = [(shell, form) for shell, form in rows if await form_access(db, shell, user) != "none"]

    form_ids = [form.id for _shell, form in rows]
    seen = {
        fid: at
        for fid, at in (
            await db.execute(
                select(FormNotify.form_id, FormNotify.seen_at).where(
                    FormNotify.user_id == user.id, FormNotify.form_id.in_(form_ids)
                )
            )
        ).all()
    }
    # Answers new since you last looked (all of them when you never have).
    new_counts: dict[uuid.UUID, int] = {}
    if form_ids:
        q = (
            select(FormResponse.form_id, func.count())
            .outerjoin(
                FormNotify,
                and_(FormNotify.form_id == FormResponse.form_id, FormNotify.user_id == user.id),
            )
            .where(
                FormResponse.form_id.in_(form_ids),
                FormResponse.deleted_at.is_(None),
                or_(FormNotify.seen_at.is_(None), FormResponse.submitted_at > FormNotify.seen_at),
            )
            .group_by(FormResponse.form_id)
        )
        new_counts = {fid: int(n) for fid, n in (await db.execute(q)).all()}

    owners: dict[uuid.UUID, str] = {}
    if scope == "shared":
        owner_ids = {shell.user_id for shell, _form in rows if shell.user_id}
        if owner_ids:
            owners = {
                uid: name
                for uid, name in (
                    await db.execute(select(UserModel.id, UserModel.username).where(UserModel.id.in_(owner_ids)))
                ).all()
            }

    out: list[dict[str, Any]] = []
    for shell, form in rows:
        defn = form.definition or {}
        theme = defn.get("theme") or {}
        header_asset = theme.get("header_asset_id")
        out.append(
            {
                "file_id": str(shell.id),
                "title": str(defn.get("title") or "Untitled form"),
                "accent": theme.get("accent") or "terracotta",
                "font": theme.get("font") or "default",
                "header_builtin": theme.get("header_builtin"),
                "header_url": service.asset_url(shell.id, header_asset) if header_asset else None,
                "questions": len([i for i in defn.get("items") or [] if not i.get("deleted") and i.get("kind") not in ("section", "text", "image")]),
                "response_count": form.response_count or 0,
                "new_count": new_counts.get(form.id, 0),
                "seen": form.id in seen and seen[form.id] is not None,
                "state": "closed" if is_closed(form) else "open",
                "accepting": bool(form.accepting),
                "close_at": form.close_at.isoformat() if form.close_at else None,
                "audience": form.audience,
                "modified_at": shell.modified_at.isoformat() if shell.modified_at else None,
                "starred": shell.starred_at is not None,
                "folder_id": str(shell.folder_id) if shell.folder_id else None,
                "owner": owners.get(shell.user_id) if scope == "shared" else None,
            }
        )
    return out


__all__ = ["list_forms"]
