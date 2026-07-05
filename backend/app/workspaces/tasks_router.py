"""Workspace task list — a first-class, workspace-level to-do list.

Distinct from the TipTap checkboxes a note can hold (those still roll up
into the overview): a ``WorkspaceTask`` belongs to the project as a whole.
The overview "home" renders the open ones so a workspace doubles as a
lightweight planner.

    GET    /workspaces/{wid}/tasks            list (open first, then done)
    POST   /workspaces/{wid}/tasks            add a task
    PATCH  /workspaces/{wid}/tasks/{task_id}  edit title / toggle done / move
    DELETE /workspaces/{wid}/tasks/{task_id}  remove

Mounted under ``/api/workspaces`` from ``app.main``; the ``/tasks`` paths
don't collide with the core workspaces CRUD or the items router.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Response,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import WorkspaceItem, WorkspaceTask, WorkspaceTaskComment
from app.database import get_db
from app.files.models import UserFile
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

router = APIRouter()

_MAX_TITLE = 500

# ``status`` is a board *column id* — the three defaults (``todo`` /
# ``doing`` / ``done``) plus any custom columns the board defines in its
# config. Free string rather than an enum so custom columns work.
TaskStatus = str
TaskPriority = Literal["low", "medium", "high"]


async def _is_done_status(
    db: AsyncSession, board_item_id: uuid.UUID | None, status: str
) -> bool:
    """Whether ``status`` (a column id) counts as "done" for its board.

    A board's config can flag one or more columns ``done: true``; with no
    custom columns we fall back to the default ``done`` column id."""
    if board_item_id is None:
        return status == "done"
    item = await db.get(WorkspaceItem, board_item_id)
    cols = None
    if item is not None and isinstance(item.config, dict):
        cols = item.config.get("columns")
    if not cols:
        return status == "done"
    done_ids = {
        c.get("id") for c in cols if isinstance(c, dict) and c.get("done")
    }
    return status in done_ids


# ---------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------
class Subtask(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=500)
    done: bool = False


class TaskLink(BaseModel):
    """A reference from a card to another navigator item.

    ``item_id`` is the workspace tree node id; ``ref_id`` is what it opens by
    (doc id for a note, conversation id for a chat). ``title`` is denormalised
    for display + RAG."""

    item_id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=32)
    ref_id: str | None = Field(default=None, max_length=64)
    title: str = Field(default="", max_length=500)
    # External URL links carry ``kind="url"`` and the href here; navigator
    # links leave it null.
    url: str | None = Field(default=None, max_length=2000)


class TaskAttachment(BaseModel):
    """A file attached to a card. ``is_cover`` (an image) renders on the
    card face. ``file_id`` references a ``UserFile``."""

    file_id: str = Field(min_length=1, max_length=64)
    filename: str = Field(default="", max_length=512)
    mime_type: str = Field(default="", max_length=255)
    size_bytes: int = 0
    is_cover: bool = False


class TaskAttachmentCreate(BaseModel):
    file_id: uuid.UUID


class TaskAttachmentCover(BaseModel):
    cover: bool = True


class WorkspaceTaskCommentResponse(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    author_user_id: uuid.UUID | None = None
    author_username: str | None = None
    kind: str
    text: str
    created_at: datetime

    class Config:
        from_attributes = True


class WorkspaceTaskCommentCreate(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class WorkspaceTaskResponse(BaseModel):
    id: uuid.UUID
    board_item_id: uuid.UUID | None = None
    title: str
    description: str | None = None
    subtasks: list[Subtask] | None = None
    labels: list[str] | None = None
    links: list[TaskLink] | None = None
    attachments: list[TaskAttachment] | None = None
    assignee_user_id: uuid.UUID | None = None
    done: bool
    status: TaskStatus
    priority: TaskPriority
    due_at: datetime | None = None
    position: float
    completed_at: datetime | None = None
    # Custom-field values (0138): ``{field_id: value}`` against the board
    # item's ``config.fields`` registry.
    fields: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WorkspaceTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=_MAX_TITLE)
    board_item_id: uuid.UUID | None = None
    status: TaskStatus = "todo"
    priority: TaskPriority = "medium"
    due_at: datetime | None = None


class WorkspaceTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=_MAX_TITLE)
    done: bool | None = None
    status: TaskStatus | None = None
    priority: TaskPriority | None = None
    # ``due_at`` is explicitly nullable: sending ``null`` clears the due
    # date, so we distinguish "field omitted" from "set to null" via
    # ``model_fields_set`` at the call site.
    due_at: datetime | None = None
    position: float | None = None
    # ``None`` clears the body; both are distinguished from "omitted" via
    # ``model_fields_set``.
    description: str | None = Field(default=None, max_length=20_000)
    subtasks: list[Subtask] | None = None
    labels: list[str] | None = None
    links: list[TaskLink] | None = None
    assignee_user_id: uuid.UUID | None = None
    # Custom-field values — replaces the whole map when sent (the card
    # detail drawer always sends the full dict); ``None`` clears it.
    fields: dict[str, Any] | None = None


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
async def _load_task(
    db: AsyncSession, workspace_id: uuid.UUID, task_id: uuid.UUID
) -> WorkspaceTask:
    task = await db.get(WorkspaceTask, task_id)
    if task is None or task.workspace_id != workspace_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    return task


def _reindex_board(
    background: BackgroundTasks,
    workspace_id: uuid.UUID,
    board_item_id: uuid.UUID | None,
) -> None:
    """Re-embed the board's task list so it stays fresh in workspace RAG.
    No-op for tasks not attached to a board."""
    if board_item_id is None:
        return
    from app.workspaces.knowledge import index_board_for_workspace

    background.add_task(
        index_board_for_workspace, workspace_id, board_item_id
    )


# ---------------------------------------------------------------------
# Activity log helpers
# ---------------------------------------------------------------------
def _log_activity(
    db: AsyncSession, task_id: uuid.UUID, actor_id: uuid.UUID, text: str
) -> None:
    """Append a system activity entry to a card's thread (no commit)."""
    db.add(
        WorkspaceTaskComment(
            task_id=task_id, author_user_id=actor_id, kind="activity", text=text
        )
    )


async def _column_label(
    db: AsyncSession, board_item_id: uuid.UUID | None, status_id: str
) -> str:
    """Human label for a column id (custom config name, or default labels)."""
    if board_item_id is not None:
        item = await db.get(WorkspaceItem, board_item_id)
        if item is not None and isinstance(item.config, dict):
            for c in item.config.get("columns") or []:
                if isinstance(c, dict) and c.get("id") == status_id:
                    return str(c.get("name") or status_id)
    return {"todo": "To Do", "doing": "In Progress", "done": "Done"}.get(
        status_id, status_id
    )


async def _username(db: AsyncSession, uid: uuid.UUID | None) -> str | None:
    if uid is None:
        return None
    u = await db.get(User, uid)
    return u.username if u else None


# ---------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------
@router.get("/{workspace_id}/tasks", response_model=list[WorkspaceTaskResponse])
async def list_tasks(
    workspace_id: uuid.UUID,
    board_item_id: uuid.UUID | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceTask]:
    """List a workspace's tasks. Scope to a single board with
    ``?board_item_id=``; omit it to count/list across all boards (the
    overview's open-task glance)."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    stmt = select(WorkspaceTask).where(WorkspaceTask.workspace_id == ws.id)
    if board_item_id is not None:
        stmt = stmt.where(WorkspaceTask.board_item_id == board_item_id)
    rows = list(
        (
            await db.execute(
                # Open tasks first (the actionable ones), then by hand order.
                stmt.order_by(
                    WorkspaceTask.done.asc(),
                    WorkspaceTask.position.asc(),
                    WorkspaceTask.created_at.asc(),
                )
            )
        ).scalars()
    )
    return rows


@router.post(
    "/{workspace_id}/tasks",
    response_model=WorkspaceTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_task(
    workspace_id: uuid.UUID,
    payload: WorkspaceTaskCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    # New task lands at the end: max(position) + 1.
    max_pos = await db.scalar(
        select(func.max(WorkspaceTask.position)).where(
            WorkspaceTask.workspace_id == ws.id
        )
    )
    is_done = await _is_done_status(db, payload.board_item_id, payload.status)
    task = WorkspaceTask(
        workspace_id=ws.id,
        board_item_id=payload.board_item_id,
        title=payload.title.strip(),
        status=payload.status,
        priority=payload.priority,
        due_at=payload.due_at,
        done=is_done,
        completed_at=datetime.now(timezone.utc) if is_done else None,
        position=float(max_pos or 0.0) + 1.0,
        created_by=user.id,
    )
    db.add(task)
    await db.flush()
    _log_activity(db, task.id, user.id, "created this card")
    await db.commit()
    await db.refresh(task)
    _reindex_board(background, ws.id, task.board_item_id)
    return task


@router.patch(
    "/{workspace_id}/tasks/{task_id}", response_model=WorkspaceTaskResponse
)
async def update_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: WorkspaceTaskUpdate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    sent = payload.model_fields_set

    # Snapshot fields that drive activity entries before we mutate them.
    old_status = task.status
    old_due = task.due_at
    old_assignee = task.assignee_user_id
    old_priority = task.priority
    old_title = task.title
    old_description = task.description

    if payload.title is not None:
        task.title = payload.title.strip()
    if payload.position is not None:
        task.position = payload.position
    if payload.priority is not None:
        task.priority = payload.priority
    if "due_at" in sent:
        task.due_at = payload.due_at  # may be None to clear it
    if "description" in sent:
        desc = (payload.description or "").strip()
        task.description = desc or None
    if "subtasks" in sent:
        task.subtasks = (
            [s.model_dump() for s in payload.subtasks]
            if payload.subtasks
            else None
        )
    if "labels" in sent:
        task.labels = list(payload.labels) if payload.labels else None
    if "links" in sent:
        task.links = (
            [link.model_dump() for link in payload.links]
            if payload.links
            else None
        )
    if "assignee_user_id" in sent:
        task.assignee_user_id = payload.assignee_user_id  # None clears it
    if "fields" in sent:
        # Whole-map replace; drop empty values so cleared fields don't
        # linger as "" keys, and cap size defensively.
        cleaned = {
            str(k)[:64]: v
            for k, v in (payload.fields or {}).items()
            if v is not None and v != ""
        }
        task.fields = dict(list(cleaned.items())[:50]) or None

    # ``status`` (a board column id) is the board's source of truth; ``done`` is
    # the legacy boolean kept in lockstep — derived from whether the target
    # column is flagged done in the board config.
    if payload.status is not None and payload.status != task.status:
        task.status = payload.status
        task.done = await _is_done_status(
            db, task.board_item_id, payload.status
        )
        task.completed_at = (
            datetime.now(timezone.utc) if task.done else None
        )
    elif payload.done is not None and payload.done != task.done:
        # Legacy boolean toggle (no column move).
        task.done = payload.done
        task.completed_at = (
            datetime.now(timezone.utc) if payload.done else None
        )

    # Log meaningful changes to the activity thread.
    card_moved_label: str | None = None
    if task.status != old_status:
        label = await _column_label(db, task.board_item_id, task.status)
        _log_activity(db, task.id, user.id, f"moved to {label}")
        card_moved_label = label
    if "due_at" in sent and task.due_at != old_due:
        _log_activity(
            db,
            task.id,
            user.id,
            "cleared the due date"
            if task.due_at is None
            else f"set the due date to {task.due_at.date().isoformat()}",
        )
    if "assignee_user_id" in sent and task.assignee_user_id != old_assignee:
        who = await _username(db, task.assignee_user_id)
        _log_activity(
            db,
            task.id,
            user.id,
            f"assigned to {who}" if who else "unassigned the card",
        )
    if payload.priority is not None and task.priority != old_priority:
        _log_activity(
            db, task.id, user.id, f"set priority to {task.priority}"
        )
    if payload.title is not None and task.title != old_title:
        _log_activity(db, task.id, user.id, f"renamed the card to “{task.title}”")
    if "description" in sent and task.description != old_description:
        _log_activity(
            db,
            task.id,
            user.id,
            "cleared the description"
            if not task.description
            else "updated the description",
        )

    await db.commit()
    await db.refresh(task)
    _reindex_board(background, ws.id, task.board_item_id)
    # Automations (E-batch): a column change fires event-triggered flows.
    # Post-commit + fire-and-forget so it can never fail the move itself.
    if card_moved_label is not None:
        from app.tasks.events import EVENT_CARD_MOVED, emit_workspace_event

        emit_workspace_event(
            workspace_id=ws.id,
            event=EVENT_CARD_MOVED,
            payload={
                "card_id": str(task.id),
                "card_title": task.title,
                "board_item_id": str(task.board_item_id)
                if task.board_item_id
                else None,
                "column": task.status,
                "column_name": card_moved_label,
                "done": bool(task.done),
                "moved_by": user.username,
            },
        )
    # A card landing on someone's plate deserves a nudge (not self-assigns).
    if (
        "assignee_user_id" in sent
        and task.assignee_user_id is not None
        and task.assignee_user_id != old_assignee
    ):
        from app.workspaces.mentions import notify_assignment

        await notify_assignment(
            db,
            ws=ws,
            actor=user,
            assignee_user_id=task.assignee_user_id,
            card_title=task.title,
            url=(
                f"/workspaces/{ws.id}?item={task.board_item_id}"
                if task.board_item_id
                else f"/workspaces/{ws.id}"
            ),
        )
    return task


@router.delete(
    "/{workspace_id}/tasks/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_task(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    board_item_id = task.board_item_id
    # Drop any attachment chunks so deleted cards don't leave RAG residue.
    from app.workspaces.knowledge import delete_workspace_file_chunks

    for att in task.attachments or []:
        fid = att.get("file_id") if isinstance(att, dict) else None
        if fid:
            background.add_task(
                delete_workspace_file_chunks, ws.id, uuid.UUID(str(fid))
            )
    await db.delete(task)
    await db.commit()
    _reindex_board(background, ws.id, board_item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Comments + activity thread
# ---------------------------------------------------------------------
@router.get(
    "/{workspace_id}/tasks/{task_id}/comments",
    response_model=list[WorkspaceTaskCommentResponse],
)
async def list_comments(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceTaskCommentResponse]:
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    task = await _load_task(db, ws.id, task_id)
    rows = list(
        (
            await db.execute(
                select(WorkspaceTaskComment)
                .where(WorkspaceTaskComment.task_id == task.id)
                .order_by(WorkspaceTaskComment.created_at.asc())
            )
        ).scalars()
    )
    ids = {c.author_user_id for c in rows if c.author_user_id}
    names: dict[uuid.UUID, str] = {}
    if ids:
        users = (
            await db.execute(select(User).where(User.id.in_(ids)))
        ).scalars().all()
        names = {u.id: u.username for u in users}
    return [
        WorkspaceTaskCommentResponse(
            id=c.id,
            task_id=c.task_id,
            author_user_id=c.author_user_id,
            author_username=names.get(c.author_user_id) if c.author_user_id else None,
            kind=c.kind,
            text=c.text,
            created_at=c.created_at,
        )
        for c in rows
    ]


@router.post(
    "/{workspace_id}/tasks/{task_id}/comments",
    response_model=WorkspaceTaskCommentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_comment(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: WorkspaceTaskCommentCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTaskCommentResponse:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    comment = WorkspaceTaskComment(
        task_id=task.id,
        author_user_id=user.id,
        kind="comment",
        text=payload.text.strip(),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    # Comments are real content — keep the board's RAG text fresh.
    _reindex_board(background, ws.id, task.board_item_id)
    # @-mentions → inbox + push for named members (best-effort).
    from app.workspaces.mentions import notify_comment_mentions

    await notify_comment_mentions(
        db,
        ws=ws,
        author=user,
        text=comment.text,
        url=(
            f"/workspaces/{ws.id}?item={task.board_item_id}"
            if task.board_item_id
            else f"/workspaces/{ws.id}"
        ),
        where=f'a comment on the card "{task.title}"',
    )
    return WorkspaceTaskCommentResponse(
        id=comment.id,
        task_id=comment.task_id,
        author_user_id=comment.author_user_id,
        author_username=user.username,
        kind=comment.kind,
        text=comment.text,
        created_at=comment.created_at,
    )


@router.delete(
    "/{workspace_id}/tasks/{task_id}/comments/{comment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_comment(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    comment_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    comment = await db.get(WorkspaceTaskComment, comment_id)
    if comment is None or comment.task_id != task.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found"
        )
    # Only the author or the workspace owner can delete a comment.
    if comment.author_user_id != user.id and ws.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to delete this comment",
        )
    await db.delete(comment)
    await db.commit()
    _reindex_board(background, ws.id, task.board_item_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Attachments + cover
# ---------------------------------------------------------------------
def _index_attachment(
    background: BackgroundTasks, workspace_id: uuid.UUID, file_id: uuid.UUID
) -> None:
    from app.workspaces.knowledge import index_task_attachment_for_workspace

    background.add_task(
        index_task_attachment_for_workspace, workspace_id, file_id
    )


@router.post(
    "/{workspace_id}/tasks/{task_id}/attachments",
    response_model=WorkspaceTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_attachment(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    payload: TaskAttachmentCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)

    file = await db.get(UserFile, payload.file_id)
    if file is None or file.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )

    atts = list(task.attachments or [])
    fid = str(file.id)
    if any(a.get("file_id") == fid for a in atts):
        return task  # already attached — idempotent
    is_image = (file.mime_type or "").lower().startswith("image/")
    # First image becomes the cover automatically.
    auto_cover = is_image and not any(a.get("is_cover") for a in atts)
    atts.append(
        {
            "file_id": fid,
            "filename": file.filename,
            "mime_type": file.mime_type,
            "size_bytes": file.size_bytes,
            "is_cover": auto_cover,
        }
    )
    task.attachments = atts
    await db.commit()
    await db.refresh(task)
    _index_attachment(background, ws.id, file.id)
    _reindex_board(background, ws.id, task.board_item_id)
    return task


@router.post(
    "/{workspace_id}/tasks/{task_id}/attachments/{file_id}/cover",
    response_model=WorkspaceTaskResponse,
)
async def set_attachment_cover(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: TaskAttachmentCover,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    fid = str(file_id)
    atts = list(task.attachments or [])
    if not any(a.get("file_id") == fid for a in atts):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found"
        )
    # Exactly one cover at a time: set the target, clear the rest.
    task.attachments = [
        {**a, "is_cover": payload.cover and a.get("file_id") == fid}
        for a in atts
    ]
    await db.commit()
    await db.refresh(task)
    return task


@router.delete(
    "/{workspace_id}/tasks/{task_id}/attachments/{file_id}",
    response_model=WorkspaceTaskResponse,
)
async def delete_attachment(
    workspace_id: uuid.UUID,
    task_id: uuid.UUID,
    file_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceTask:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    task = await _load_task(db, ws.id, task_id)
    fid = str(file_id)
    atts = list(task.attachments or [])
    if not any(a.get("file_id") == fid for a in atts):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found"
        )
    task.attachments = [a for a in atts if a.get("file_id") != fid] or None
    await db.commit()
    await db.refresh(task)
    # Drop the attachment's RAG chunks; keep the underlying Drive file.
    from app.workspaces.knowledge import delete_workspace_file_chunks

    background.add_task(delete_workspace_file_chunks, ws.id, file_id)
    _reindex_board(background, ws.id, task.board_item_id)
    return task


__all__ = ["router"]
