"""Workspace Drive (Phases 6-7) — the workspace's own file area.

Replaces the flat "pinned files" surface with a real file browser:

    GET    /workspaces/{wid}/drive                      listing (folders +
                                                        files + quota)
    POST   /workspaces/{wid}/drive/files                upload → workspace-
                                                        owned + auto-pinned
    POST   /workspaces/{wid}/drive/folders              create folder
    PATCH  /workspaces/{wid}/drive/folders/{fid}        rename folder
    DELETE /workspaces/{wid}/drive/folders/{fid}        delete empty folder
    POST   /workspaces/{wid}/drive/files/{fid}/move     move file to folder

Storage semantics: every workspace file lives in the *owner's* Drive under
``Workspaces/<title>/Files`` — regardless of who uploaded it. That matches
how notes and canvases have always worked (their backing rows are created
in the owner's Drive even when a collaborator makes them) and fixes the old
behaviour where a collaborator's upload landed in their personal Drive and
left the workspace when they did. The ``workspace_files`` pivot remains the
membership + context + indexing record; folders are ordinary ``FileFolder``
rows inside the subtree.

Legacy pins whose backing file lives *outside* the subtree (old
collaborator uploads) still list — at the drive root, unmovable — so
nothing disappears.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from fastapi import Form
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import Workspace, WorkspaceFile
from app.database import get_db
from app.files.models import FileFolder, UserFile
from app.files.quota import get_quota
from app.files.safety import (
    UnsafeUploadError,
    sanitize_filename,
    sniff_and_validate,
    strip_image_metadata_in_place,
)
from app.files.storage import (
    MAX_FILE_BYTES,
    absolute_path,
    copy_stream_to_disk,
    delete_blob,
    ensure_bucket,
    storage_path_for,
)
from app.files.system_folders import (
    create_workspace_folder_tree,
    get_or_create_subfolder,
)
from app.workspaces.knowledge import (
    WORKSPACE_MEMORY_SOURCE_KIND,
    index_file_for_workspace,
)
from app.workspaces.schemas import (
    WorkspaceDriveFile,
    WorkspaceDriveFolder,
    WorkspaceDriveFolderCreate,
    WorkspaceDriveFolderRename,
    WorkspaceDriveMove,
    WorkspaceDriveResponse,
)
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

logger = logging.getLogger("promptly.workspaces.drive")
router = APIRouter()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


async def _workspace_owner(db: AsyncSession, ws: Workspace, caller: User) -> User:
    owner = caller if ws.user_id == caller.id else await db.get(User, ws.user_id)
    if owner is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace owner is missing",
        )
    return owner


async def _files_root(
    db: AsyncSession, ws: Workspace, owner: User
) -> FileFolder:
    """The workspace's ``Files`` Drive folder (created if missing)."""
    if ws.root_folder_id is None:
        ws_folder = await create_workspace_folder_tree(db, owner, ws.title)
        ws.root_folder_id = ws_folder.id
        await db.flush()
    return await get_or_create_subfolder(
        db, user_id=owner.id, parent_id=ws.root_folder_id, name="Files"
    )


async def _subtree_folders(
    db: AsyncSession, root: FileFolder, owner_id: uuid.UUID
) -> list[FileFolder]:
    """Every folder strictly below the drive root (BFS)."""
    all_folders = list(
        (
            await db.execute(
                select(FileFolder).where(FileFolder.user_id == owner_id)
            )
        ).scalars()
    )
    by_parent: dict[uuid.UUID | None, list[FileFolder]] = {}
    for f in all_folders:
        by_parent.setdefault(f.parent_id, []).append(f)
    out: list[FileFolder] = []
    stack = list(by_parent.get(root.id, []))
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(by_parent.get(cur.id, []))
    return out


async def _folder_in_subtree(
    db: AsyncSession,
    folder_id: uuid.UUID,
    root: FileFolder,
    owner_id: uuid.UUID,
) -> FileFolder:
    """Resolve ``folder_id`` iff it sits at/under the drive root."""
    target = await db.get(FileFolder, folder_id)
    node = target
    hops = 0
    while node is not None and hops < 64:
        if node.user_id != owner_id:
            break
        if node.id == root.id:
            return target  # type: ignore[return-value]
        node = (
            await db.get(FileFolder, node.parent_id)
            if node.parent_id is not None
            else None
        )
        hops += 1
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Folder not found in this workspace's drive",
    )


async def _drive_used_bytes(db: AsyncSession, workspace_id: uuid.UUID) -> int:
    used = await db.scalar(
        select(func.coalesce(func.sum(UserFile.size_bytes), 0))
        .select_from(WorkspaceFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(WorkspaceFile.workspace_id == workspace_id)
    )
    return int(used or 0)


def _pin_to_drive_file(
    pin: WorkspaceFile, uf: UserFile, *, in_subtree: bool, root_id: uuid.UUID
) -> WorkspaceDriveFile:
    # The drive root is ``null`` client-side — normalise files sitting
    # directly in the Files folder (and legacy out-of-subtree pins) to it.
    folder_id = (
        uf.folder_id
        if in_subtree and uf.folder_id is not None and uf.folder_id != root_id
        else None
    )
    return WorkspaceDriveFile(
        file_id=uf.id,
        filename=uf.filename,
        mime_type=uf.mime_type,
        size_bytes=uf.size_bytes,
        pinned_at=pin.pinned_at,
        indexing_status=pin.indexing_status,
        indexing_error=pin.indexing_error,
        context_enabled=pin.context_enabled,
        folder_id=folder_id,
        movable=in_subtree,
    )


# ---------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------


@router.get("/{workspace_id}/drive", response_model=WorkspaceDriveResponse)
async def get_drive(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveResponse:
    """The whole drive in one shot: folder tree (flat, parented), every
    pinned file with its folder placement, and the quota snapshot. Drives
    are small (dozens of files) — the client builds the tree."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)
    await db.commit()  # _files_root may have created rows

    folders = await _subtree_folders(db, root, owner.id)
    subtree_ids = {root.id, *(f.id for f in folders)}

    pins_q = await db.execute(
        select(WorkspaceFile, UserFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(WorkspaceFile.workspace_id == ws.id)
        .order_by(WorkspaceFile.pinned_at.asc())
    )
    files = [
        _pin_to_drive_file(
            pin,
            uf,
            in_subtree=uf.folder_id in subtree_ids,
            root_id=root.id,
        )
        for pin, uf in pins_q.all()
        if uf.source_kind != WORKSPACE_MEMORY_SOURCE_KIND
    ]

    used = sum(f.size_bytes for f in files)
    return WorkspaceDriveResponse(
        root_folder_id=root.id,
        folders=[
            WorkspaceDriveFolder(
                id=f.id,
                name=f.name,
                # The drive root renders as "/" client-side — normalise
                # first-level folders to a null parent.
                parent_id=f.parent_id if f.parent_id != root.id else None,
            )
            for f in folders
        ],
        files=files,
        used_bytes=used,
        quota_bytes=ws.storage_quota_bytes,
    )


# ---------------------------------------------------------------------
# Upload (workspace-owned + auto-pin)
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/drive/files",
    response_model=WorkspaceDriveFile,
    status_code=status.HTTP_201_CREATED,
)
async def upload_drive_file(
    workspace_id: uuid.UUID,
    file: UploadFile,
    background: BackgroundTasks,
    folder_id: uuid.UUID | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveFile:
    """Upload straight into the workspace drive.

    The file is stored in the *owner's* bucket under the workspace's
    ``Files`` folder (or a subfolder) no matter who uploads — same
    ownership rule as notes/canvases — then pinned and indexed. Applies
    the same sanitise → stream → sniff → EXIF-strip pipeline as the
    personal-Drive upload, plus the workspace's own storage cap.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)

    target = root
    if folder_id is not None and folder_id != root.id:
        target = await _folder_in_subtree(db, folder_id, root, owner.id)

    # Filename hygiene before anything touches disk.
    try:
        clean_name = sanitize_filename(file.filename)
    except UnsafeUploadError as e:
        await file.close()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    import os

    ext = os.path.splitext(clean_name)[1].lower()

    # The owner's personal quota backs every workspace byte.
    quota = await get_quota(db, owner)
    if quota.cap_bytes is not None and quota.used_bytes >= quota.cap_bytes:
        await file.close()
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                "The workspace owner's storage is full — free up space or "
                "raise their quota before adding more files."
            ),
        )

    new_id = uuid.uuid4()
    rel_path = storage_path_for(owner.id, new_id, ext)
    ensure_bucket(owner.id)
    try:
        size = copy_stream_to_disk(
            file.file, rel_path, size_limit=MAX_FILE_BYTES
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"File exceeds maximum size of "
                f"{MAX_FILE_BYTES // (1024 * 1024)} MB"
            ),
        )
    finally:
        await file.close()

    if size == 0:
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The upload was empty — try attaching the file again.",
        )

    abs_path = absolute_path(rel_path)
    try:
        canonical_mime = sniff_and_validate(
            abs_path,
            declared_filename=clean_name,
            declared_mime=file.content_type,
        )
    except UnsafeUploadError as e:
        delete_blob(rel_path)
        logger.warning(
            "workspace %s: rejected drive upload %r (%s)",
            ws.id,
            clean_name,
            e.code,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )

    strip_image_metadata_in_place(abs_path, canonical_mime)
    try:
        size = abs_path.stat().st_size
    except OSError:
        pass
    if size <= 0:
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The upload finished but the file was empty on disk.",
        )

    # Exact-size checks: owner quota, then the workspace's own cap.
    if quota.cap_bytes is not None and quota.used_bytes + size > quota.cap_bytes:
        delete_blob(rel_path)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                "This upload would push the workspace owner over their "
                "storage limit."
            ),
        )
    if ws.storage_quota_bytes is not None:
        used = await _drive_used_bytes(db, ws.id)
        if used + size > ws.storage_quota_bytes:
            delete_blob(rel_path)
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    "This upload would exceed the workspace's storage cap. "
                    "Remove some files or raise the cap in Settings."
                ),
            )

    row = UserFile(
        id=new_id,
        user_id=owner.id,
        folder_id=target.id,
        filename=clean_name,
        original_filename=clean_name,
        mime_type=canonical_mime,
        size_bytes=size,
        storage_path=rel_path,
    )
    db.add(row)
    # No ORM relationship wires ``WorkspaceFile`` → ``UserFile``, so
    # SQLAlchemy's unit of work doesn't know the pin depends on the file —
    # flush the file first or the pin's FK insert races ahead and fails.
    await db.flush()
    pin = WorkspaceFile(workspace_id=ws.id, file_id=new_id, pinned_by=user.id)
    db.add(pin)
    ws.updated_at = datetime.now(timezone.utc)
    try:
        await db.commit()
    except Exception:
        delete_blob(rel_path)
        raise
    await db.refresh(row)
    await db.refresh(pin)

    # FTS extraction — best effort, post-commit (mirrors the Drive upload).
    from app.files.extraction import extract_content_text

    try:
        content_text = extract_content_text(row)
        if content_text is not None:
            row.content_text = content_text
            await db.commit()
            await db.refresh(row)
    except Exception:  # noqa: BLE001
        logger.exception(
            "FTS extraction failed for workspace drive file %s", row.id
        )
        await db.rollback()

    background.add_task(index_file_for_workspace, ws.id, row.id)

    # Automations (E-batch): fire event-triggered flows. Best-effort,
    # non-blocking — a flow hiccup can never fail an upload.
    from app.tasks.events import EVENT_FILE_ADDED, emit_workspace_event

    emit_workspace_event(
        workspace_id=ws.id,
        event=EVENT_FILE_ADDED,
        payload={
            "file_id": str(row.id),
            "filename": row.filename,
            "mime_type": row.mime_type,
            "size_bytes": row.size_bytes,
            "uploaded_by": user.username,
        },
    )
    return _pin_to_drive_file(pin, row, in_subtree=True, root_id=root.id)


# ---------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/drive/folders",
    response_model=WorkspaceDriveFolder,
    status_code=status.HTTP_201_CREATED,
)
async def create_drive_folder(
    workspace_id: uuid.UUID,
    payload: WorkspaceDriveFolderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveFolder:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)

    parent = root
    if payload.parent_id is not None and payload.parent_id != root.id:
        parent = await _folder_in_subtree(db, payload.parent_id, root, owner.id)

    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Folder name can't be empty",
        )
    # Sibling-name dedupe, same nudge as workspace items ("Research 2").
    siblings = {
        n
        for (n,) in (
            await db.execute(
                select(FileFolder.name).where(
                    FileFolder.user_id == owner.id,
                    FileFolder.parent_id == parent.id,
                )
            )
        ).all()
    }
    base, n = name, 2
    while name in siblings:
        name = f"{base} {n}"
        n += 1

    folder = FileFolder(user_id=owner.id, parent_id=parent.id, name=name)
    db.add(folder)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(folder)
    return WorkspaceDriveFolder(
        id=folder.id,
        name=folder.name,
        parent_id=folder.parent_id if folder.parent_id != root.id else None,
    )


@router.patch(
    "/{workspace_id}/drive/folders/{folder_id}",
    response_model=WorkspaceDriveFolder,
)
async def rename_drive_folder(
    workspace_id: uuid.UUID,
    folder_id: uuid.UUID,
    payload: WorkspaceDriveFolderRename,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveFolder:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)
    if folder_id == root.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The drive root can't be renamed",
        )
    folder = await _folder_in_subtree(db, folder_id, root, owner.id)
    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Folder name can't be empty",
        )
    folder.name = name
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(folder)
    return WorkspaceDriveFolder(
        id=folder.id,
        name=folder.name,
        parent_id=folder.parent_id if folder.parent_id != root.id else None,
    )


@router.delete(
    "/{workspace_id}/drive/folders/{folder_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_drive_folder(
    workspace_id: uuid.UUID,
    folder_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete an *empty* drive folder (contents must be moved out first —
    a recursive delete of workspace context deserves more ceremony than a
    row menu click)."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)
    if folder_id == root.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The drive root can't be deleted",
        )
    folder = await _folder_in_subtree(db, folder_id, root, owner.id)

    child_folders = await db.scalar(
        select(func.count()).where(FileFolder.parent_id == folder.id)
    )
    child_files = await db.scalar(
        select(func.count()).where(UserFile.folder_id == folder.id)
    )
    if (child_folders or 0) > 0 or (child_files or 0) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Move the folder's contents out before deleting it.",
        )
    await db.delete(folder)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()


# ---------------------------------------------------------------------
# Move
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/drive/files/{file_id}/move",
    response_model=WorkspaceDriveFile,
)
async def move_drive_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: WorkspaceDriveMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDriveFile:
    """Re-folder a drive file (``folder_id`` null → drive root). Only
    workspace-owned files move — legacy pins living in a member's personal
    Drive aren't ours to re-organise."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    owner = await _workspace_owner(db, ws, user)
    root = await _files_root(db, ws, owner)

    pin = await db.scalar(
        select(WorkspaceFile).where(
            WorkspaceFile.workspace_id == ws.id,
            WorkspaceFile.file_id == file_id,
        )
    )
    uf = await db.get(UserFile, file_id)
    if pin is None or uf is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )
    if uf.user_id != owner.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "This file lives in a member's personal Drive and can't be "
                "re-organised here."
            ),
        )

    target = root
    if payload.folder_id is not None and payload.folder_id != root.id:
        target = await _folder_in_subtree(db, payload.folder_id, root, owner.id)
    uf.folder_id = target.id
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(uf)
    await db.refresh(pin)
    return _pin_to_drive_file(pin, uf, in_subtree=True, root_id=root.id)
