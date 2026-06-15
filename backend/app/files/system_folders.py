"""System-managed folders living inside each user's private file pool.

Every user gets these four folders the moment their account is created
(see ``seed_system_folders`` below, called from every user-provisioning
path) and existing accounts are backfilled by the
``0011_seed_system_folders`` migration. The ``ensure_*`` helpers are
still kept as a defensive safety net so any code path that asks for a
system folder gets one even if seeding was somehow skipped. They are
all protected from rename / delete / move so callers can assume the
rows are stable:

  My files/
  ├── Chat Uploads/        ← every file uploaded from a chat lands here
  └── Generated Files/     ← reserved for future "AI made this for you" flow
      ├── Files/           ← .txt, .md, .pdf, .csv, code, ...
      └── Media/           ← image/audio/video

Routing rules:

* Chat uploads → ``Chat Uploads`` (no per-conversation subfoldering;
  one flat bucket the user can manually re-organise later).
* Generated artefacts → ``Generated Files / Media`` if the MIME type
  starts with ``image/`` / ``audio/`` / ``video/``; otherwise
  ``Generated Files / Files``. PDFs go to **Files** (treated as a
  document, not media).
"""
from __future__ import annotations

from enum import Enum
from typing import Final

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import FileFolder


class SystemKind(str, Enum):
    """Stable identifiers persisted in ``file_folders.system_kind``.

    Treat these strings as part of the schema: renaming a value would
    require a data migration.
    """

    CHAT_UPLOADS = "chat_uploads"
    GENERATED_ROOT = "generated_root"
    GENERATED_FILES = "generated_files"
    GENERATED_MEDIA = "generated_media"
    # Phase 1 — the single protected root holding every workspace's
    # Drive folder. Only this root is system-managed (no rename / delete
    # / move); the per-workspace folders + their Notes/Canvases/Files
    # subfolders inside it are ordinary, fully-editable folders.
    WORKSPACES_ROOT = "workspaces_root"
    # Phase 12 — lazy-seeded when a user connects their first email account.
    # Hidden from the Files page when email_mode == "off".
    EMAIL_ATTACHMENTS = "email_attachments"


DISPLAY_NAMES: Final[dict[SystemKind, str]] = {
    SystemKind.CHAT_UPLOADS: "Chat Uploads",
    SystemKind.GENERATED_ROOT: "Generated Files",
    SystemKind.GENERATED_FILES: "Files",
    SystemKind.GENERATED_MEDIA: "Media",
    SystemKind.EMAIL_ATTACHMENTS: "Email Attachments",
    SystemKind.WORKSPACES_ROOT: "Workspaces",
}

# The per-type subfolders auto-created inside each workspace's Drive
# folder. Notes land in ``Notes/`` by default, canvases in ``Canvases/``,
# uploads in ``Files/`` — purely for tidy physical storage. The
# user-facing navigator (``workspace_items``) is free-form and does NOT
# mirror this type bucketing.
WORKSPACE_SUBFOLDERS: Final[tuple[str, ...]] = ("Notes", "Canvases", "Files")

# A "media" mime is anything that's primarily a moving / sounding /
# pixel-y blob the user would expect to preview rather than read.
# PDFs are deliberately excluded — they're treated as documents and
# routed to the Files subfolder so the Media bucket stays focused.
_MEDIA_PREFIXES: Final[tuple[str, ...]] = ("image/", "audio/", "video/")


def is_media_mime(mime: str | None) -> bool:
    """Return True for image/audio/video MIME types (PDF is *not* media)."""
    if not mime:
        return False
    lowered = mime.lower()
    return any(lowered.startswith(p) for p in _MEDIA_PREFIXES)


# --------------------------------------------------------------------
# Lazy ensure helpers
# --------------------------------------------------------------------
async def _fetch(
    db: AsyncSession, user_id, kind: SystemKind
) -> FileFolder | None:
    return (
        await db.execute(
            select(FileFolder).where(
                FileFolder.user_id == user_id,
                FileFolder.system_kind == kind.value,
            )
        )
    ).scalar_one_or_none()


async def _ensure(
    db: AsyncSession,
    user_id,
    kind: SystemKind,
    *,
    parent_id=None,
) -> FileFolder:
    """Find-or-create the named system folder for ``user_id``.

    Concurrent first-time uploads can race here; the partial unique index
    on ``(user_id, system_kind)`` will reject the loser, which we catch
    inside a SAVEPOINT and resolve by re-fetching. Without the SAVEPOINT
    the surrounding transaction would be poisoned and every subsequent
    statement would fail.
    """
    existing = await _fetch(db, user_id, kind)
    if existing is not None:
        return existing
    try:
        async with db.begin_nested():
            folder = FileFolder(
                user_id=user_id,
                parent_id=parent_id,
                name=DISPLAY_NAMES[kind],
                system_kind=kind.value,
            )
            db.add(folder)
            await db.flush()
        return folder
    except IntegrityError:
        # Someone else created it between the SELECT and the INSERT.
        existing = await _fetch(db, user_id, kind)
        if existing is None:  # pragma: no cover — defensive
            raise
        return existing


async def ensure_chat_uploads(db: AsyncSession, user: User) -> FileFolder:
    return await _ensure(db, user.id, SystemKind.CHAT_UPLOADS)


async def ensure_generated_root(db: AsyncSession, user: User) -> FileFolder:
    return await _ensure(db, user.id, SystemKind.GENERATED_ROOT)


async def ensure_generated_files(db: AsyncSession, user: User) -> FileFolder:
    root = await ensure_generated_root(db, user)
    return await _ensure(
        db, user.id, SystemKind.GENERATED_FILES, parent_id=root.id
    )


async def ensure_generated_media(db: AsyncSession, user: User) -> FileFolder:
    root = await ensure_generated_root(db, user)
    return await _ensure(
        db, user.id, SystemKind.GENERATED_MEDIA, parent_id=root.id
    )


async def ensure_email_attachments(db: AsyncSession, user: User) -> FileFolder:
    """Folder where email attachment files are saved.

    Lazy — only called when a user connects an email account, not at
    registration. This keeps the folder out of non-email users' drives.
    """
    return await _ensure(db, user.id, SystemKind.EMAIL_ATTACHMENTS)


async def ensure_workspaces_root(db: AsyncSession, user: User) -> FileFolder:
    """Find-or-create the single protected ``Workspaces`` root folder.

    This is the only system-managed folder in the workspace storage
    tree — the API blocks rename / delete / move on it (via
    ``system_kind``) so the per-workspace folder seeding always has a
    stable parent to hang off. Everything *inside* it is ordinary,
    user-editable folders.
    """
    return await _ensure(db, user.id, SystemKind.WORKSPACES_ROOT)


async def get_or_create_subfolder(
    db: AsyncSession,
    *,
    user_id,
    parent_id,
    name: str,
) -> FileFolder:
    """Return the live child folder ``name`` under ``parent_id``,
    creating it if absent.

    Used to resolve a workspace's ``Notes`` / ``Canvases`` / ``Files``
    bucket on demand — the folders are auto-created at workspace
    creation, but a user may have deleted or renamed one, so callers
    (e.g. note creation) re-create the bucket rather than 500.
    """
    existing = (
        await db.execute(
            select(FileFolder).where(
                FileFolder.user_id == user_id,
                FileFolder.parent_id == parent_id,
                FileFolder.name == name,
                FileFolder.trashed_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    folder = FileFolder(user_id=user_id, parent_id=parent_id, name=name)
    db.add(folder)
    await db.flush()
    return folder


async def create_workspace_folder_tree(
    db: AsyncSession, user: User, title: str
) -> FileFolder:
    """Create ``My files / Workspaces / <title> / {Notes,Canvases,Files}``.

    Returns the per-workspace ``<title>`` folder (the row a workspace's
    ``root_folder_id`` should point at). The ``<title>`` folder and its
    three subfolders are ordinary, fully-editable folders — only the
    ``Workspaces`` grandparent is protected.

    Does not commit; the caller batches this into the workspace-create
    transaction.
    """
    root = await ensure_workspaces_root(db, user)
    clean = (title or "Workspace").strip()[:255] or "Workspace"
    ws_folder = FileFolder(user_id=user.id, parent_id=root.id, name=clean)
    db.add(ws_folder)
    await db.flush()
    for sub in WORKSPACE_SUBFOLDERS:
        db.add(FileFolder(user_id=user.id, parent_id=ws_folder.id, name=sub))
    await db.flush()
    return ws_folder


async def seed_system_folders(db: AsyncSession, user: User) -> None:
    """Materialise every system folder for ``user``.

    Called from every user-provisioning path (registration, admin
    create, bootstrap singleton) so the folders are visible from the
    very first time the user opens the Files page — no upload required
    to make them appear. Idempotent: safe to call against a user who
    already has any subset of the folders.

    Does *not* commit; the caller batches this with the surrounding
    transaction and decides when to flush.
    """
    await ensure_chat_uploads(db, user)
    # ensure_generated_files / _media each call ensure_generated_root,
    # which is idempotent — the second call short-circuits on the
    # SELECT and reuses the existing row.
    await ensure_generated_files(db, user)
    await ensure_generated_media(db, user)
    # Phase 1 — the protected Workspaces root. Seeded for new users so
    # the folder is visible the moment they open Files; existing users
    # get it lazily on their first workspace create (``ensure_*`` is
    # find-or-create).
    await ensure_workspaces_root(db, user)


# --------------------------------------------------------------------
# Routing
# --------------------------------------------------------------------
async def folder_for_chat_upload(
    db: AsyncSession, user: User
) -> FileFolder:
    """Folder a chat-uploaded file should land in by default."""
    return await ensure_chat_uploads(db, user)


async def folder_for_generated(
    db: AsyncSession, user: User, mime: str | None
) -> FileFolder:
    """Folder a future "AI generated this" file should land in."""
    if is_media_mime(mime):
        return await ensure_generated_media(db, user)
    return await ensure_generated_files(db, user)
