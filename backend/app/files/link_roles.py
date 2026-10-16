"""Comment and edit links (WP-6.6, Part C §3.9).

"Signed-in users with the link can comment / edit": a share link with role
``comment`` or ``edit`` is always an ``invite`` link — editing is never
anonymous. Opening it signed in (:func:`claim_link`) gives that person a
``ResourceGrant`` marked ``via_link_id``, so everything that already asks
"who can read / comment / edit this file" answers for them too.

Such a grant lasts while its link does: revoking the link deletes them
(:func:`drop_link_grants`), and an expired link stops counting at once —
:func:`alive_link_filter` / :func:`alive_link_sql` are applied by the access
checks — and the nightly pass deletes them (:func:`purge_dead_link_grants`).
A person the file was shared with directly keeps that grant; a link never
changes it.

Which roles a file can have: comment and edit on Docs, Sheets and
Whiteboards; edit on an uploaded PDF (fill in, mark up — WP-6.5); view only
on anything else and on folders.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import FileShareLink, ResourceGrant, UserFile

LINK_ROLES = ("view", "comment", "edit")


class LinkRoleError(ValueError):
    """The role doesn't fit this link (a 400)."""


def roles_for_file(row: UserFile | None) -> tuple[str, ...]:
    from app.files.office import OFFICE_SOURCE_KINDS
    from app.files.pdf_edit import is_editable_pdf

    if row is None:
        return ("view",)
    if row.source_kind in OFFICE_SOURCE_KINDS:
        return LINK_ROLES
    if is_editable_pdf(row):
        return ("view", "edit")
    return ("view",)


async def check_link_role(
    db: AsyncSession, *, resource_type: str, resource_id: uuid.UUID, role: str, access_mode: str
) -> None:
    if role == "view":
        return
    if access_mode != "invite":
        raise LinkRoleError("Commenting and editing need people to sign in — choose “Specific people”.")
    if resource_type != "file":
        raise LinkRoleError("A folder link can only let people view.")
    row = await db.get(UserFile, resource_id)
    if role not in roles_for_file(row):
        raise LinkRoleError(
            "People can comment on and edit Docs, Sheets and Whiteboards, and edit PDFs. "
            "This file can only be viewed through a link."
        )


def alive_link_filter():
    """SQLAlchemy condition on ``ResourceGrant``: not from a link, or from
    a link that's still live."""
    now = datetime.now(timezone.utc)
    live = select(FileShareLink.id).where(
        FileShareLink.revoked_at.is_(None),
        or_(FileShareLink.expires_at.is_(None), FileShareLink.expires_at > now),
    )
    return or_(ResourceGrant.via_link_id.is_(None), ResourceGrant.via_link_id.in_(live))


def alive_link_sql(alias: str) -> str:
    """The same, as SQL over ``resource_grants AS <alias>``."""
    return (
        f"({alias}.via_link_id IS NULL OR EXISTS (SELECT 1 FROM file_share_links AS sl "
        f"WHERE sl.id = {alias}.via_link_id AND sl.revoked_at IS NULL "
        f"AND (sl.expires_at IS NULL OR sl.expires_at > now())))"
    )


async def claim_link(db: AsyncSession, link: FileShareLink, user) -> str | None:  # noqa: ANN001 — User
    """``user`` opened a comment / edit link: give them its role (unless
    they own the file or were given access directly). Returns where to open
    the file, or None for a view link. Commits when it changes something."""
    if link.role == "view" or link.resource_type != "file" or not link.is_alive():
        return None
    row = await db.get(UserFile, link.resource_id)
    if row is None or row.trashed_at is not None:
        return None
    path = open_path(row)
    if row.user_id == user.id or link.created_by == user.id:
        return path
    can_edit = link.role == "edit"
    existing = (
        await db.execute(
            select(ResourceGrant).where(
                ResourceGrant.resource_type == "file",
                ResourceGrant.resource_id == row.id,
                ResourceGrant.grantee_user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            ResourceGrant(
                resource_type="file",
                resource_id=row.id,
                grantee_user_id=user.id,
                granted_by_user_id=link.created_by,
                can_edit=can_edit,
                can_comment=True,
                via_link_id=link.id,
            )
        )
    elif existing.via_link_id is not None and (
        existing.via_link_id != link.id or existing.can_edit != can_edit
    ):
        # Joined through another link before: this one decides now (its
        # role, and it's the one whose revocation ends it).
        rank = {False: 0, True: 1}
        if rank[can_edit] >= rank[existing.can_edit] or not await _link_alive(db, existing.via_link_id):
            existing.via_link_id = link.id
            existing.can_edit = can_edit
            existing.can_comment = True
    else:
        return path
    try:
        await db.commit()
    except Exception:  # noqa: BLE001 — a parallel first visit made the row
        await db.rollback()
    return path


async def _link_alive(db: AsyncSession, link_id: uuid.UUID) -> bool:
    link = await db.get(FileShareLink, link_id)
    return link is not None and link.is_alive()


def open_path(row: UserFile) -> str:
    from app.files.office_router import editor_path

    return editor_path(row) or f"/files/f/{row.id}"


async def drop_link_grants(db: AsyncSession, link: FileShareLink) -> list[uuid.UUID]:
    """Delete the grants ``link`` gave; returns who had them. Flushed, not
    committed."""
    ids = list(
        (
            await db.execute(
                select(ResourceGrant.grantee_user_id).where(ResourceGrant.via_link_id == link.id)
            )
        ).scalars()
    )
    await db.execute(delete(ResourceGrant).where(ResourceGrant.via_link_id == link.id))
    return ids


async def purge_dead_link_grants(db: AsyncSession) -> int:
    """Nightly: grants from links that have expired or been revoked."""
    now = datetime.now(timezone.utc)
    dead = select(FileShareLink.id).where(
        or_(FileShareLink.revoked_at.is_not(None), and_(FileShareLink.expires_at.is_not(None), FileShareLink.expires_at <= now))
    )
    result = await db.execute(delete(ResourceGrant).where(ResourceGrant.via_link_id.in_(dead)))
    return int(result.rowcount or 0)


__all__ = [
    "LINK_ROLES",
    "LinkRoleError",
    "alive_link_filter",
    "alive_link_sql",
    "check_link_role",
    "claim_link",
    "drop_link_grants",
    "open_path",
    "purge_dead_link_grants",
    "roles_for_file",
]
