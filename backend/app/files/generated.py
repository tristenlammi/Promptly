"""Persist a file produced by the AI inside a chat tool call.

The user-facing upload pipeline in ``app/files/router.py`` is built for
*untrusted* bytes coming over the network: it sanitises the filename,
sniffs the magic bytes, runs an EXIF strip, and audits every rejection.
We don't need any of that for bytes the AI just generated server-side
inside a tool we wrote — the data is by definition ours.

What we *do* still need:

* The same on-disk layout (so the existing ``GET /api/files/{id}``
  download endpoint serves the file with no special-casing).
* The same per-user storage cap (so an AI loop can't blow past quotas).
* The same routing into the system folders (``Generated Files / Files``
  vs ``Generated Files / Media``) so the user sees their generated
  artefacts in a predictable place.

This module is the small adapter that gives a tool implementation a
one-line "here are some bytes, persist them as a UserFile and return the
row" call.
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import UserFile
from app.files.quota import get_quota
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
    delete_blob,
    ensure_bucket,
    storage_path_for,
)
from app.files.system_folders import folder_for_generated

logger = logging.getLogger("promptly.generated")


class GeneratedFileError(Exception):
    """Raised when an AI-generated file can't be persisted.

    The chat router catches this and turns it into a tool failure event
    so the model can see the error and react (apologise, retry with a
    smaller payload, etc.) instead of the whole stream tearing down.
    """


# Soft cap on a single AI-generated artefact. Smaller than the
# user-upload ceiling because nothing we generate today (a text echo,
# an image, a PDF) realistically needs the full 40 MB. Keeps a runaway
# tool from gobbling a user's whole storage quota in one shot.
MAX_GENERATED_BYTES = 16 * 1024 * 1024


def _ext_for_filename(filename: str) -> str:
    """Return the lowercased extension including the dot, or empty string."""
    dot = filename.rfind(".")
    if dot < 0 or dot == len(filename) - 1:
        return ""
    return filename[dot:].lower()


async def persist_generated_file(
    db: AsyncSession,
    *,
    user: User,
    filename: str,
    mime_type: str,
    content: bytes,
    source_kind: str | None = None,
    source_file_id: uuid.UUID | None = None,
) -> UserFile:
    """Write ``content`` to disk and create the matching ``UserFile`` row.

    The new row is committed in its own transaction (callers don't have
    to remember to commit) so the file is visible to the rest of the
    system the moment this function returns. On any failure between
    "wrote bytes" and "committed row" we delete the on-disk blob so
    nothing dangles.

    Routing: bytes always land in ``Generated Files / Media`` for image
    / audio / video MIME types, ``Generated Files / Files`` otherwise
    (matching :func:`app.files.system_folders.folder_for_generated`).
    The system folder is created on demand if it doesn't already exist
    — though for any account created post-Phase-A1 it will already.

    ``source_kind`` / ``source_file_id`` are optional Phase-A2 hooks
    used by document tools that author a Markdown source + a rendered
    artefact (PDF) as a pair. The renderer persists the source first
    with ``source_kind="markdown_source"``, then the rendered child
    with ``source_kind="rendered_pdf"`` and ``source_file_id`` set to
    the source row. See :class:`app.files.generated_kinds.GeneratedKind`
    for the canonical values; passing arbitrary strings is allowed but
    discouraged.
    """
    if not content:
        raise GeneratedFileError("Generated file is empty")
    if len(content) > MAX_GENERATED_BYTES:
        raise GeneratedFileError(
            f"Generated file exceeds {MAX_GENERATED_BYTES // (1024 * 1024)} MB cap"
        )
    if len(content) > MAX_FILE_BYTES:
        # Belt-and-braces against a future bump to MAX_GENERATED_BYTES that
        # forgets to bump the global ceiling. Same wire-level error the
        # user-upload path raises so log dashboards stay consistent.
        raise GeneratedFileError("Generated file exceeds upload size limit")

    # Storage cap — same rules as user uploads. Generated files count.
    quota = await get_quota(db, user)
    if quota.cap_bytes is not None:
        if quota.used_bytes + len(content) > quota.cap_bytes:
            raise GeneratedFileError(
                "Generation would exceed your storage cap. Free some "
                "space or ask an admin to raise it."
            )

    # Resolve the destination folder *before* writing to disk so a
    # mis-routing failure doesn't leave us with an orphan blob.
    parent_folder = await folder_for_generated(db, user, mime_type)

    new_id = uuid.uuid4()
    ext = _ext_for_filename(filename)
    rel_path = storage_path_for(user.id, new_id, ext)
    ensure_bucket(user.id)

    abs_path: Path = absolute_path(rel_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        abs_path.write_bytes(content)
    except OSError as e:
        raise GeneratedFileError(f"Failed to write generated file: {e}") from e

    row = UserFile(
        id=new_id,
        user_id=user.id,
        folder_id=parent_folder.id,
        filename=filename,
        original_filename=filename,
        mime_type=mime_type,
        size_bytes=len(content),
        storage_path=rel_path,
        source_kind=source_kind,
        source_file_id=source_file_id,
    )
    db.add(row)
    try:
        await db.commit()
    except Exception:
        # Roll back the disk side too — otherwise the next attempt with
        # the same id will fail and we'll have garbage on disk for the
        # rest of the container's life.
        delete_blob(rel_path)
        raise
    await db.refresh(row)
    logger.info(
        "Persisted generated file id=%s user=%s mime=%s bytes=%d",
        row.id,
        user.id,
        mime_type,
        row.size_bytes,
    )
    return row


async def overwrite_generated_file(
    db: AsyncSession,
    *,
    user: User,
    file: UserFile,
    content: bytes,
    new_mime_type: str | None = None,
) -> UserFile:
    """Replace the bytes of an existing ``UserFile`` row in place.

    Used by Phase A3's source-editor flow: the user saves new Markdown
    via the side panel, we overwrite the source row, then re-render
    the linked PDF and overwrite *its* row too — both via this helper.
    Same id, same on-disk path; only ``size_bytes`` (and optionally
    ``mime_type``) change. Keeping the id stable means every chip in
    every chat history that already references this file picks up the
    new content automatically the next time the user clicks download.

    Quota delta: only the *change* in size counts against the cap (a
    smaller new file actually frees space). We still refuse if the
    delta would push the user over their cap. ``user`` must be the
    owner of ``file``; the caller (the router) has already enforced
    that via ``_load_writable_file``.

    On any disk-write failure we leave the original bytes intact (we
    write to a temp sibling first, then atomic-rename) so a half-saved
    edit can never corrupt the chip download.
    """
    if file.user_id != user.id:  # pragma: no cover — defensive
        raise GeneratedFileError("File does not belong to this user")
    if not content:
        raise GeneratedFileError("Replacement content is empty")
    if len(content) > MAX_GENERATED_BYTES:
        raise GeneratedFileError(
            f"Replacement exceeds {MAX_GENERATED_BYTES // (1024 * 1024)} MB cap"
        )
    if len(content) > MAX_FILE_BYTES:
        raise GeneratedFileError(
            "Replacement exceeds upload size limit"
        )

    delta = len(content) - file.size_bytes
    if delta > 0:
        # Only check quota when the file is *growing*. A re-render that
        # produced fewer bytes can always succeed regardless of cap.
        # ``quota.used_bytes`` already includes ``file.size_bytes``, so
        # the comparison is against (used + delta), not (used + new).
        quota = await get_quota(db, user)
        if quota.cap_bytes is not None:
            new_used = quota.used_bytes + delta
            if new_used > quota.cap_bytes:
                raise GeneratedFileError(
                    "Save would exceed your storage cap. Free some "
                    "space or ask an admin to raise it."
                )

    # Atomic rename: write to ``<path>.tmp.<id>``, fsync, replace.
    abs_path: Path = absolute_path(file.storage_path)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = abs_path.with_suffix(abs_path.suffix + f".tmp.{uuid.uuid4().hex}")
    try:
        tmp_path.write_bytes(content)
        # ``Path.replace`` is atomic on POSIX *and* Windows when both
        # paths live on the same filesystem (they always do — same
        # bucket dir). The original bytes survive any crash before
        # this call returns.
        tmp_path.replace(abs_path)
    except OSError as e:
        # Clean up the temp file if we failed mid-write.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise GeneratedFileError(f"Failed to overwrite file: {e}") from e

    file.size_bytes = len(content)
    if new_mime_type is not None:
        file.mime_type = new_mime_type
    try:
        await db.commit()
    except Exception:
        # The on-disk bytes have already been replaced. We can't roll
        # them back without keeping a copy of the originals (which
        # would defeat the atomic-rename simplicity), so we accept the
        # minor inconsistency: the next read will see the new bytes
        # but the row will reflect the old size until the next save.
        # In practice this branch only fires if the database is down,
        # in which case the user is about to see a 5xx anyway.
        raise
    await db.refresh(file)
    logger.info(
        "Overwrote generated file id=%s user=%s bytes=%d (delta=%+d)",
        file.id,
        file.user_id,
        file.size_bytes,
        delta,
    )
    return file


__all__ = [
    "GeneratedFileError",
    "MAX_GENERATED_BYTES",
    "overwrite_generated_file",
    "persist_generated_file",
]
