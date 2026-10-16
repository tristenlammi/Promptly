"""Who can read a file — one answer for downloads and AI retrieval (WP-5.1).

Part C's permission rule: the check that lets you download a file and the
SQL that lets AI search find it must be the same, or search quietly shows
you things you can't open (or hides things you can). This module holds it
as a SQL predicate over ``files AS <alias>``:

* you own the file, or
* it was shared with you directly (or you joined through a comment / edit
  link that's still live — WP-6.6), or
* it sits anywhere under a folder that was shared with you, or
* it's in a photo album you own or were added to (WP-9.4), or
* its owner put it in your family library (PH-5),

and (unless asked otherwise) it isn't in the trash. :func:`can_read` runs
the same predicate for one file; ``_load_readable_file`` (downloads,
previews) uses it, then adds the workspace side-door — a workspace's own
files are searched through the workspace's scope, not here.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def readable_predicate(alias: str = "f", *, param: str = "reader_id", include_trashed: bool = False) -> str:
    """SQL boolean: the reader (bound as ``:<param>``) can read ``alias``."""
    from app.files.link_roles import alive_link_sql

    trashed = "" if include_trashed else f" AND {alias}.trashed_at IS NULL"
    return f"""(
        ({alias}.user_id = :{param}
         OR EXISTS (
             SELECT 1 FROM resource_grants AS rg
             WHERE rg.grantee_user_id = :{param}
               AND rg.resource_type = 'file'
               AND rg.resource_id = {alias}.id
               AND {alive_link_sql('rg')}
         )
         OR ({alias}.folder_id IS NOT NULL AND {alias}.folder_id IN (
             WITH RECURSIVE granted(id) AS (
                 SELECT rg.resource_id FROM resource_grants AS rg
                 WHERE rg.grantee_user_id = :{param} AND rg.resource_type = 'folder'
                 UNION
                 SELECT c.id FROM file_folders AS c JOIN granted ON c.parent_id = granted.id
             )
             SELECT id FROM granted
         ))
         OR EXISTS (
             SELECT 1 FROM album_items AS ai JOIN albums AS al ON al.id = ai.album_id
             WHERE ai.file_id = {alias}.id
               AND (al.owner_id = :{param} OR EXISTS (
                   SELECT 1 FROM album_members AS am WHERE am.album_id = al.id AND am.user_id = :{param}
               ))
         )
         OR EXISTS (
             SELECT 1 FROM photo_family_items AS fi
             JOIN photo_family_members AS fm ON fm.family_id = fi.family_id AND fm.user_id = :{param}
             WHERE fi.file_id = {alias}.id
         ))
        {trashed}
    )"""


async def can_read(
    db: AsyncSession, file_id: uuid.UUID, user_id: uuid.UUID, *, include_trashed: bool = False
) -> bool:
    """The same rule as :func:`readable_predicate`, for one file."""
    row = await db.execute(
        text(
            f"SELECT EXISTS (SELECT 1 FROM files AS f WHERE f.id = :fid AND "
            f"{readable_predicate('f', include_trashed=include_trashed)})"
        ),
        {"fid": str(file_id), "reader_id": str(user_id)},
    )
    return bool(row.scalar())


__all__ = ["can_read", "readable_predicate"]
