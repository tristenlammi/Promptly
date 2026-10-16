"""Workspaces API — CRUD, archive, pinned files, conversations listing.

Separate module from :mod:`app.chat.router` because:

* The chat router is already 2 k+ lines and growing; keeping workspaces
  isolated makes each area easier to reason about.
* Workspace endpoints don't touch streaming / SSE plumbing, so the
  import graph stays narrower than a single combined file would.

Mounted under ``/api/workspaces`` from ``app.main`` — see the
``include_router`` block there.

Surface area::

    GET    /workspaces                 list user's workspaces (active / archived)
    POST   /workspaces                 create a workspace
    GET    /workspaces/{wid}           full detail (incl. pinned files)
    PATCH  /workspaces/{wid}           rename / edit system prompt / change default model
    DELETE /workspaces/{wid}           permanently delete
    POST   /workspaces/{wid}/archive   move to archive
    POST   /workspaces/{wid}/unarchive bring back from archive
    GET    /workspaces/{wid}/conversations   list chats inside the workspace
    POST   /workspaces/{wid}/files     pin a file to the workspace
    DELETE /workspaces/{wid}/files/{fid}     unpin

Access control: every endpoint looks up the workspace via
:func:`_get_owned_workspace`, which 404s when the caller isn't the
owner. There is no sharing / collaborator story for workspaces
today — if/when we add it, the check becomes a helper mirroring
:func:`app.chat.shares.get_accessible_conversation`.
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
    Request,
    Response,
    status,
)
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.auth.audit import record_event
from app.auth.deps import get_current_user
from app.auth.events import (
    EVENT_WORKSPACE_ARCHIVED,
    EVENT_WORKSPACE_CREATED,
    EVENT_WORKSPACE_DELETED,
    EVENT_WORKSPACE_UNARCHIVED,
)
from app.auth.models import User
from app.chat.models import (
    Conversation,
    Message,
    Workspace,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceTask,
)
from app.workspaces.schemas import (
    WorkspaceCreate,
    WorkspaceDetail,
    WorkspaceFileContext,
    WorkspaceFilePin,
    WorkspaceParticipant,
    WorkspacePinFile,
    WorkspaceSummary,
    WorkspaceUpdate,
    WorkspaceUsage,
    WorkspaceUsageModel,
)
from app.workspaces.visibility import conversation_visible_to
from app.workspaces.shares import (
    get_accessible_workspace,
    is_owner_of_workspace,
    load_workspace_participants,
    require_workspace_admin,
    require_workspace_write,
)
from app.chat.schemas import ConversationSummary
from app.workspaces.knowledge import (
    WORKSPACE_MEMORY_SOURCE_KIND,
    delete_workspace_file_chunks,
    index_file_for_workspace,
    reindex_workspace,
    workspace_context_stats,
)
from app.chat.shares import list_accessible_workspace_ids
from app.tasks.models import Task as AutomationTask
from app.custom_models.resolver import is_custom_model_id
from app.database import get_db
from app.files.models import FileFolder, UserFile
from app.files.system_folders import create_workspace_folder_tree
from app.models_config.models import ModelProvider

logger = logging.getLogger("promptly.workspaces")

router = APIRouter()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


async def _get_owned_workspace(
    workspace_id: uuid.UUID, user: User, db: AsyncSession
) -> Workspace:
    """Return the workspace iff ``user`` owns it, else 404.

    Now a thin wrapper around :func:`is_owner_of_workspace` so the
    owner-vs-collaborator distinction lives in one place. Used by
    endpoints that should never be exposed to a collaborator
    (delete, archive / unarchive).
    """
    return await is_owner_of_workspace(workspace_id, user, db)


async def _get_owned_workspace_any(
    workspace_id: uuid.UUID, user: User, db: AsyncSession
) -> Workspace:
    """Like :func:`_get_owned_workspace`, but a trashed workspace counts —
    for delete / restore."""
    return await is_owner_of_workspace(workspace_id, user, db, allow_trashed=True)


WORKSPACE_TRASH_DAYS = 30


async def purge_trashed_workspaces(db: AsyncSession) -> int:
    """Delete workspaces trashed more than :data:`WORKSPACE_TRASH_DAYS`
    ago (nightly maintenance). Returns how many went."""
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=WORKSPACE_TRASH_DAYS)
    rows = list(
        (
            await db.execute(
                select(Workspace).where(
                    Workspace.trashed_at.is_not(None),
                    Workspace.trashed_at < cutoff,
                )
            )
        ).scalars()
    )
    for ws in rows:
        await db.delete(ws)
    return len(rows)


async def _validate_provider(
    provider_id: uuid.UUID | None, user: User, db: AsyncSession
) -> ModelProvider | None:
    """Reject ``default_provider_id`` pointing at a provider the user
    isn't allowed to use. Mirrors the ACL rules the send-message
    endpoint enforces, so a workspace can't be wired up with a
    provider the caller couldn't actually hit anyway.

    ``None`` is always fine (means "fall back to global selection")
    and returns without a DB hit. Returns the resolved provider row
    (or ``None`` when ``provider_id`` was ``None``) so callers that
    also need to inspect ``enabled_models`` don't re-fetch it."""
    if provider_id is None:
        return None
    provider = await db.get(ModelProvider, provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        # Providers added in the admin panel carry the adding admin's id
        # and are shared with everyone — the chat picker offers them to all
        # users, so a non-admin choosing one isn't "unknown" (R-179).
        owner = await db.get(User, provider.user_id)
        owner_ok = owner is not None and owner.role == "admin"
    if not owner_ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    return provider


async def _validate_default_model(
    provider_id: uuid.UUID | None,
    model_id: str | None,
    user: User,
    db: AsyncSession,
) -> None:
    """Reject a default model the caller couldn't actually use.

    Rules mirror the create-conversation fallback in
    :mod:`app.chat.router`:

    * ``provider_id`` and ``model_id`` are set together or cleared
      together — a half-set default silently falls back at send time,
      which is confusing to debug.
    * The provider must exist and be usable by the caller
      (delegated to :func:`_validate_provider`).
    * For a real (non-custom) model the id must be one of the
      provider's ``enabled_models``. Custom models carry a synthetic
      ``custom:<uuid>`` id the chat resolver expands at send time, so
      the membership check is skipped for them (the provider check
      still applies)."""
    if model_id is None and provider_id is None:
        return
    if (model_id is None) != (provider_id is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Set a default model and provider together, or clear both.",
        )
    provider = await _validate_provider(provider_id, user, db)
    if is_custom_model_id(model_id):
        return
    # ``enabled_models`` semantics must mirror the chat picker
    # (``models_config.router``): NULL means "expose every catalog
    # model" (the default for a provider the admin never curated), an
    # explicit list narrows to those ids, and ``[]`` exposes none.
    # The old ``enabled_models or []`` collapsed NULL into ``[]``, so a
    # freshly-added provider (e.g. a direct DeepSeek key) rejected every
    # model — you couldn't set it as a workspace default at all.
    if provider is None:  # defensive — provider_id was non-None here
        return
    if provider.enabled_models is None:
        allowed = {m.get("id") for m in (provider.models or [])}
    else:
        allowed = set(provider.enabled_models)
    if model_id not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That model isn't enabled for the selected provider.",
        )
    # A workspace's default model follows whoever *sets* it: the default
    # must be a model the editing caller can personally use. A member who
    # only has models 1 & 2 can't pin model 3; a member (or admin) who
    # does have model 3 can. Send-time already gates every user by their
    # own access and falls back if the stored default is out of reach, so
    # this just keeps the person choosing the default honest.
    from app.models_config.access import is_model_allowed

    if not await is_model_allowed(
        user, db, model_id=model_id, base_model_id=model_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only set the default to a model you have access to.",
        )


async def _summary_with_rollups(
    ws: Workspace,
    db: AsyncSession,
    caller: User,
) -> WorkspaceSummary:
    """Hydrate a :class:`WorkspaceSummary` with the conversation +
    file counts the list/card UI needs.

    Also populates ``role`` / ``shared_by`` so collaborator-visible
    cards can render "shared by Jane" instead of the owner's
    timestamp line. Two cheap ``SELECT COUNT(*)`` queries are
    cheaper than joining and grouping for every list response; the
    N-workspaces * 2-counts pattern is fine for the dozens of
    workspaces a power user will accumulate.
    """
    from app.workspaces.visibility import conversation_visible_to, item_visible_to

    # Only what this caller can see — private chats and drafts are their
    # creator's alone, and trashed content isn't content (R-203).
    conv_count = await db.scalar(
        select(func.count())
        .select_from(Conversation)
        .where(
            Conversation.workspace_id == ws.id,
            Conversation.archived_at.is_(None),
            conversation_visible_to(caller.id),
        )
    )
    # Mirror the Drive pane's filter: the auto-maintained Workspace
    # Memory doc is pinned for retrieval but hidden from the file list,
    # so it mustn't inflate the card's "N files" either (hub said
    # "2 files" while Drive showed 1).
    file_count = await db.scalar(
        select(func.count())
        .select_from(WorkspaceFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(
            WorkspaceFile.workspace_id == ws.id,
            UserFile.trashed_at.is_(None),
            or_(
                UserFile.source_kind.is_(None),
                UserFile.source_kind != WORKSPACE_MEMORY_SOURCE_KIND,
            ),
        )
    )
    # Per-kind item counts (notes / boards / sheets / …) so the card can
    # say what a workspace actually contains. One GROUP BY per workspace.
    # Automations aren't item rows (they're synthesised into the tree from
    # the tasks table, like chats from conversations) — count them directly.
    kind_rows = await db.execute(
        select(WorkspaceItem.kind, func.count())
        .where(
            WorkspaceItem.workspace_id == ws.id,
            WorkspaceItem.archived_at.is_(None),
            WorkspaceItem.trashed_at.is_(None),
            item_visible_to(caller.id),
        )
        .group_by(WorkspaceItem.kind)
    )
    # Caller-scoped, matching the navigator tree (which synthesises only the
    # caller's own automations) — counting other users' homed tasks made the
    # card claim "3 automations" while the tree showed one.
    task_count = await db.scalar(
        select(func.count())
        .select_from(AutomationTask)
        .where(
            AutomationTask.workspace_id == ws.id,
            AutomationTask.user_id == caller.id,
        )
    )
    base = WorkspaceSummary.model_validate(ws)
    base.conversation_count = int(conv_count or 0)
    base.file_count = int(file_count or 0)
    base.item_counts = {str(k): int(c) for k, c in kind_rows}
    if task_count:
        base.item_counts["task"] = int(task_count)

    participants = await load_workspace_participants(ws, db)
    base.member_names = [participants.owner.username] + [
        c.username for c in participants.collaborators
    ]
    base.members = [participants.owner, *participants.collaborators]

    if ws.user_id == caller.id:
        base.role = "owner"
        base.shared_by = None
    else:
        base.role = "collaborator"
        owner = await db.get(User, ws.user_id)
        if owner is not None:
            base.shared_by = WorkspaceParticipant(
                user_id=owner.id,
                username=owner.username,
                email=owner.email,
                avatar_url=owner.avatar_url,
                avatar_color=owner.avatar_color,
            )
    return base


# ---------------------------------------------------------------------
# Listings + creation
# ---------------------------------------------------------------------


@router.get("", response_model=list[WorkspaceSummary])
async def list_workspaces(
    archived: bool = False,
    trashed: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WorkspaceSummary]:
    """List workspaces the caller owns *or* has an accepted share on.

    ``archived=false`` (default) → only active workspaces
    (``archived_at IS NULL``). Collaborator-visible workspaces always
    show in the active list — invitees don't get the archive UX
    since they can't archive/unarchive.

    Owned and shared workspaces arrive in the same payload but each
    row carries a ``role`` discriminator so the card UI can badge
    shared ones.
    """
    if trashed:
        # The owner's recently deleted workspaces, restorable until the
        # retention sweep purges them (R-177).
        rows = list(
            (
                await db.execute(
                    select(Workspace)
                    .where(
                        Workspace.user_id == user.id,
                        Workspace.trashed_at.is_not(None),
                    )
                    .order_by(Workspace.trashed_at.desc())
                )
            ).scalars()
        )
        return [await _summary_with_rollups(w, db, user) for w in rows]
    accessible_ids = await list_accessible_workspace_ids(user, db)
    if not accessible_ids:
        return []
    q = select(Workspace).where(Workspace.id.in_(accessible_ids))
    if archived:
        # Archive is owner-facing only — collaborators don't get
        # surfaced archived workspaces (the owner may have hidden it
        # for a reason; surfacing it to shared users would be
        # surprising).
        q = (
            q.where(Workspace.user_id == user.id)
            .where(Workspace.archived_at.is_not(None))
            .order_by(Workspace.archived_at.desc())
        )
    else:
        q = q.where(Workspace.archived_at.is_(None)).order_by(
            Workspace.updated_at.desc()
        )
    res = await db.execute(q)
    rows = list(res.scalars().all())
    return [await _summary_with_rollups(w, db, user) for w in rows]


class MyWorkCard(BaseModel):
    """One open card assigned to the caller, with enough context to
    render outside its board (workspace + board titles, deep link)."""

    id: uuid.UUID
    title: str
    status: str
    priority: str
    due_at: datetime | None = None
    created_at: datetime
    workspace_id: uuid.UUID
    workspace_title: str
    board_item_id: uuid.UUID | None = None
    board_title: str | None = None


class MyWorkResponse(BaseModel):
    cards: list[MyWorkCard]


# NOTE: registered before the /{workspace_id} routes — FastAPI matches in
# declaration order and "my-work" must not be parsed as a workspace UUID.
@router.get("/templates")
async def list_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """The new-workspace picker's catalog: the built-in starters plus every
    workspace the caller can open that's been saved as a template. The
    picker used to carry its own copy of the built-in list (R-204)."""
    from app.workspaces.templates import template_catalog

    out = template_catalog()
    ids = await list_accessible_workspace_ids(user, db)
    if ids:
        for w in (
            await db.execute(
                select(Workspace)
                .where(Workspace.id.in_(ids), Workspace.is_template.is_(True))
                .order_by(Workspace.title.asc())
            )
        ).scalars():
            out.append(
                {
                    "key": f"ws:{w.id}",
                    "name": w.title,
                    "description": w.description or "Your team's template.",
                    "group": "Your templates",
                }
            )
    return out


class MyShift(BaseModel):
    workspace_id: uuid.UUID
    workspace_title: str
    roster_item_id: uuid.UUID
    roster_title: str
    date: str
    start: str | None = None
    end: str | None = None
    hours: float | None = None
    note: str | None = None


async def _my_shifts(db: AsyncSession, user: User, days: int = 56) -> list[MyShift]:
    """The caller's upcoming shifts across every roster they can see — the
    published version where there is one (R-174)."""
    from app.chat.models import Roster, WorkspaceShare
    from app.workspaces.roster_text import upcoming_for, visible_shifts
    from app.workspaces.visibility import item_visible_to

    ids = await list_accessible_workspace_ids(user, db)
    if not ids:
        return []
    admin_of = {
        w for w in (
            await db.execute(select(Workspace.id).where(Workspace.id.in_(ids), Workspace.user_id == user.id))
        ).scalars()
    } | {
        w for w in (
            await db.execute(
                select(WorkspaceShare.workspace_id).where(
                    WorkspaceShare.invitee_user_id == user.id,
                    WorkspaceShare.status == "accepted",
                    WorkspaceShare.role == "admin",
                )
            )
        ).scalars()
    }
    rows = (
        await db.execute(
            select(WorkspaceItem, Roster, Workspace.title)
            .join(Roster, Roster.id == WorkspaceItem.ref_id)
            .join(Workspace, Workspace.id == WorkspaceItem.workspace_id)
            .where(
                WorkspaceItem.workspace_id.in_(ids),
                WorkspaceItem.kind == "roster",
                WorkspaceItem.trashed_at.is_(None),
                WorkspaceItem.archived_at.is_(None),
                Workspace.archived_at.is_(None),
                item_visible_to(user.id),
            )
        )
    ).all()
    out: list[MyShift] = []
    for item, roster, ws_title in rows:
        shifts = visible_shifts(roster.data, for_admin=item.workspace_id in admin_of)
        for sh in upcoming_for(str(user.id), shifts, days=days):
            out.append(
                MyShift(
                    workspace_id=item.workspace_id,
                    workspace_title=ws_title,
                    roster_item_id=item.id,
                    roster_title=item.title or "Roster",
                    date=str(sh.get("date")),
                    start=sh.get("start") if sh.get("timed") else None,
                    end=sh.get("end") if sh.get("timed") else None,
                    hours=sh.get("hours"),
                    note=(sh.get("note") or None),
                )
            )
    out.sort(key=lambda m: (m.date, m.start or ""))
    return out


def _ics_signature(user: User) -> str:
    import hashlib
    import hmac

    from app.config import get_settings

    # token_version in the signature: "sign out everywhere" revokes feeds.
    msg = f"shifts-ics:{user.id}:{user.token_version}".encode()
    return hmac.new(get_settings().SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()[:40]


@router.get("/my-shifts", response_model=list[MyShift])
async def my_shifts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[MyShift]:
    return await _my_shifts(db, user)


@router.post("/my-shifts/calendar-link")
async def my_shifts_calendar_link(
    request: Request,
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """A private calendar-feed URL (subscribe from a phone's calendar).
    Signing out everywhere changes it."""
    base = str(request.base_url).rstrip("/")
    return {"url": f"{base}/api/workspaces/my-shifts.ics?u={user.id}&sig={_ics_signature(user)}"}


@router.get("/my-shifts.ics")
async def my_shifts_ics(
    u: uuid.UUID,
    sig: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    import hmac

    from app.workspaces.localtime import zone_of
    from app.workspaces.roster_text import shift_bounds

    user = await db.get(User, u)
    if user is None or user.disabled or not hmac.compare_digest(sig, _ics_signature(user)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    zone = zone_of(user)
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    def esc(v: str) -> str:
        return v.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")

    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Promptly//Shifts//EN",
        "CALSCALE:GREGORIAN", "X-WR-CALNAME:My shifts (Promptly)",
    ]
    for i, m in enumerate(await _my_shifts(db, user, days=120)):
        st, en, all_day = shift_bounds(
            {"date": m.date, "timed": bool(m.start and m.end), "start": m.start, "end": m.end}, zone
        )
        lines += ["BEGIN:VEVENT", f"UID:{m.roster_item_id}-{m.date}-{m.start or 'day'}-{i}@promptly", f"DTSTAMP:{now}"]
        if all_day:
            lines += [f"DTSTART;VALUE=DATE:{st:%Y%m%d}", f"DTEND;VALUE=DATE:{en:%Y%m%d}"]
        else:
            u1, u2 = st.astimezone(timezone.utc), en.astimezone(timezone.utc)
            lines += [f"DTSTART:{u1:%Y%m%dT%H%M%SZ}", f"DTEND:{u2:%Y%m%dT%H%M%SZ}"]
        lines.append(f"SUMMARY:{esc(f'Shift — {m.roster_title}')}")
        desc = m.workspace_title + (f" — {m.note}" if m.note else "")
        lines += [f"DESCRIPTION:{esc(desc)}", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return Response(
        content="\r\n".join(lines) + "\r\n",
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/my-work", response_model=MyWorkResponse)
async def my_work(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MyWorkResponse:
    """Every open card assigned to the caller across their workspaces.

    The cross-workspace "what's on my plate" view: open (non-done)
    cards in active workspaces the caller can still access, due-date
    first (nulls last). Mentions and invites come from the inbox and
    invites endpoints — this only owns the cards."""
    accessible_ids = await list_accessible_workspace_ids(user, db)
    if not accessible_ids:
        return MyWorkResponse(cards=[])
    from app.workspaces.board_columns import done_status_ids

    board = aliased(WorkspaceItem)
    rows = (
        await db.execute(
            select(WorkspaceTask, Workspace.title, board.title, board.config)
            .join(Workspace, Workspace.id == WorkspaceTask.workspace_id)
            .outerjoin(board, board.id == WorkspaceTask.board_item_id)
            .where(
                WorkspaceTask.assignee_user_id == user.id,
                WorkspaceTask.workspace_id.in_(accessible_ids),
                Workspace.archived_at.is_(None),
                # Cards on a board that's been trashed or archived aren't
                # on anyone's plate (R-184).
                board.trashed_at.is_(None),
                board.archived_at.is_(None),
            )
            .order_by(
                WorkspaceTask.due_at.asc().nulls_last(),
                WorkspaceTask.created_at.desc(),
            )
            .limit(400)
        )
    ).all()
    # "Done" is whatever column the board says is done — a custom "Shipped"
    # column used to leave finished cards on the list for good (R-184).
    rows = [
        (t, ws_title, board_title)
        for t, ws_title, board_title, config in rows
        if t.status not in done_status_ids(config)
    ][:200]
    return MyWorkResponse(
        cards=[
            MyWorkCard(
                id=t.id,
                title=t.title,
                status=t.status,
                priority=t.priority,
                due_at=t.due_at,
                created_at=t.created_at,
                workspace_id=t.workspace_id,
                workspace_title=ws_title,
                board_item_id=t.board_item_id,
                board_title=board_title,
            )
            for t, ws_title, board_title in rows
        ]
    )


@router.post(
    "", response_model=WorkspaceSummary, status_code=status.HTTP_201_CREATED
)
async def create_workspace(
    payload: WorkspaceCreate,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    await _validate_default_model(
        payload.default_provider_id, payload.default_model_id, user, db
    )
    ws = Workspace(
        user_id=user.id,
        title=payload.title.strip(),
        description=payload.description,
        system_prompt=payload.system_prompt,
        default_model_id=payload.default_model_id,
        default_provider_id=payload.default_provider_id,
    )
    db.add(ws)
    # Flush to mint the workspace id before seeding its Drive folder tree.
    await db.flush()
    # Seed ``My files / Workspaces / <title> / {Notes,Canvases,Files}`` and
    # point the workspace at its per-workspace folder. Notes / canvases /
    # uploads created in the workspace physically land under here so they
    # inherit Drive's preview / search / trash / quota plumbing.
    ws_folder = await create_workspace_folder_tree(db, user, ws.title)
    ws.root_folder_id = ws_folder.id
    # Starter template (4.6): seed notes / board / system prompt inside the
    # same transaction. A template bug must never lose the workspace, so
    # failures degrade to a blank workspace with a logged warning.
    to_index: list = []
    if payload.template and payload.template.startswith("ws:"):
        # One of the caller's accessible workspaces saved as a template.
        from app.workspaces.duplicate import copy_workspace_content

        try:
            tpl_id = uuid.UUID(payload.template[3:])
        except ValueError:
            tpl_id = None
        tpl = None
        if tpl_id is not None:
            try:
                tpl, _r = await get_accessible_workspace(tpl_id, user, db)
            except HTTPException:
                tpl = None
        if tpl is None or not tpl.is_template:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="That template isn't available.",
            )
        to_index = await copy_workspace_content(db, src=tpl, dest=ws, user=user)
    elif payload.template:
        # A savepoint, so a template that fails part-way rolls back cleanly
        # and leaves a blank workspace — a bare try/except couldn't undo a
        # failed flush (R-204).
        try:
            from app.workspaces.templates import apply_template

            async with db.begin_nested():
                await apply_template(
                    db, ws=ws, user=user, template_key=payload.template
                )
        except Exception:  # noqa: BLE001
            logger.warning(
                "template %r failed; created blank workspace",
                payload.template,
                exc_info=True,
            )
    await record_event(
        db,
        event_type=EVENT_WORKSPACE_CREATED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id})',
    )
    await db.commit()
    await db.refresh(ws)
    if to_index:
        from app.workspaces.duplicate import schedule_indexing

        schedule_indexing(background, ws.id, to_index)
    return await _summary_with_rollups(ws, db, user)


# ---------------------------------------------------------------------
# Detail + mutation
# ---------------------------------------------------------------------


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceDetail:
    # Owner *or* accepted collaborator — workspace sharing grants
    # read access to the workspace detail page and its files; the role
    # tells the frontend whether to expose edit affordances.
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    # Build the detail payload. Pinned files need a join against
    # ``user_files`` to pull the display metadata the frontend shows
    # on the Files tab.
    files_q = await db.execute(
        select(WorkspaceFile, UserFile)
        .join(UserFile, UserFile.id == WorkspaceFile.file_id)
        .where(WorkspaceFile.workspace_id == ws.id)
        .order_by(WorkspaceFile.pinned_at.asc())
    )
    pins = [
        WorkspaceFilePin(
            file_id=uf.id,
            filename=uf.filename,
            mime_type=uf.mime_type,
            size_bytes=uf.size_bytes,
            pinned_at=pin.pinned_at,
            indexing_status=pin.indexing_status,
            indexing_error=pin.indexing_error,
            context_enabled=pin.context_enabled,
        )
        for pin, uf in files_q.all()
        # The auto-maintained Workspace Memory.md stays pinned (that's how it
        # reaches chat context) but is hidden from the user-managed Pinned
        # files list — it has its own editor in Settings → Workspace memory,
        # and shouldn't be separately editable, unpinnable, or deletable here.
        if uf.source_kind != WORKSPACE_MEMORY_SOURCE_KIND
    ]
    summary = await _summary_with_rollups(ws, db, user)
    stats = await workspace_context_stats(
        db, workspace_id=ws.id, system_prompt=ws.system_prompt
    )
    participants = await load_workspace_participants(ws, db)
    # The workspace's ``Files`` Drive subfolder (owned by the owner). Read-only
    # lookup — never creates here, so a GET stays side-effect free; it's seeded
    # at workspace creation. The owner uploads workspace files straight into it
    # so their Drive stays tidy; collaborators can't write to the owner's
    # folder, so the frontend only uses this when the caller is the owner.
    files_folder_id: uuid.UUID | None = None
    if ws.root_folder_id is not None:
        files_folder_id = await db.scalar(
            select(FileFolder.id).where(
                FileFolder.user_id == ws.user_id,
                FileFolder.parent_id == ws.root_folder_id,
                FileFolder.name == "Files",
            )
        )
    # ``WorkspaceDetail`` extends ``WorkspaceSummary`` — merge the
    # two payloads into one validated object so the HTTP shape stays
    # flat (no nested "summary" object the frontend has to unwrap).
    return WorkspaceDetail(
        **summary.model_dump(),
        system_prompt=ws.system_prompt,
        files=pins,
        owner=WorkspaceParticipant(
            user_id=participants.owner.user_id,
            username=participants.owner.username,
            email=participants.owner.email,
            avatar_url=participants.owner.avatar_url,
            avatar_color=participants.owner.avatar_color,
        ),
        collaborators=[
            WorkspaceParticipant(
                user_id=c.user_id,
                username=c.username,
                email=c.email,
                avatar_url=c.avatar_url,
                avatar_color=c.avatar_color,
                role=participants.roles.get(c.user_id),
            )
            for c in participants.collaborators
        ],
        my_share_id=participants.share_ids.get(user.id),
        instruction_tokens=stats.instruction_tokens,
        pinned_file_tokens=stats.pinned_file_tokens,
        per_turn_tokens=stats.per_turn_tokens,
        retrieval_active=stats.retrieval_active,
        indexing_count=stats.indexing_count,
        access_role=access_role,
        auto_memory_enabled=ws.auto_memory_enabled,
        memory_mode=ws.memory_mode,
        embeddings_configured=stats.embeddings_configured,
        files_folder_id=files_folder_id,
    )


@router.patch("/{workspace_id}", response_model=WorkspaceSummary)
async def update_workspace(
    workspace_id: uuid.UUID,
    payload: WorkspaceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    # Settings are an admin concern: owner + admin only. Plain editors can
    # edit content but not the workspace's title / prompt / default model /
    # memory / storage; viewers are read-only.
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_admin(access_role)
    # ``model_fields_set`` tells us which keys were actually sent by
    # the client — lets us differentiate "leave alone" (absent) from
    # "set to null" (explicit clear). Matches the PATCH semantics
    # used across the rest of the API.
    sent = payload.model_fields_set
    if "title" in sent:
        if not payload.title or not payload.title.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Title cannot be empty",
            )
        ws.title = payload.title.strip()
    if "description" in sent:
        ws.description = payload.description
    if "system_prompt" in sent:
        if "expected_system_prompt" in sent and (ws.system_prompt or "") != (
            payload.expected_system_prompt or ""
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Someone else changed the instructions while you were "
                    "editing them."
                ),
            )
        ws.system_prompt = payload.system_prompt
    # Default model + provider are validated as a *pair* against the
    # resulting state — sending one without the other (or a model the
    # provider doesn't enable) is rejected so the chat header and the
    # send-time fallback can't disagree.
    if "default_model_id" in sent or "default_provider_id" in sent:
        new_model = (
            payload.default_model_id
            if "default_model_id" in sent
            else ws.default_model_id
        )
        new_provider = (
            payload.default_provider_id
            if "default_provider_id" in sent
            else ws.default_provider_id
        )
        # Only a *change* is validated — an admin without access to the
        # current default used to be unable to save anything, even a typo
        # fix in the description, because every save re-sent it (R-179).
        if (new_model, new_provider) != (ws.default_model_id, ws.default_provider_id):
            await _validate_default_model(new_provider, new_model, user, db)
        ws.default_model_id = new_model
        ws.default_provider_id = new_provider
    # ``memory_mode`` is the source of truth; keep the legacy boolean synced.
    if "memory_mode" in sent and payload.memory_mode is not None:
        ws.memory_mode = payload.memory_mode
        ws.auto_memory_enabled = payload.memory_mode == "auto"
    elif "auto_memory_enabled" in sent and payload.auto_memory_enabled is not None:
        ws.auto_memory_enabled = payload.auto_memory_enabled
        ws.memory_mode = "auto" if payload.auto_memory_enabled else "off"
    # Dedicated memory model — validated as a pair only when actually set;
    # clearing both falls back to the workspace default chat model.
    if "memory_model_id" in sent or "memory_provider_id" in sent:
        new_mem_model = (
            payload.memory_model_id
            if "memory_model_id" in sent
            else ws.memory_model_id
        )
        new_mem_provider = (
            payload.memory_provider_id
            if "memory_provider_id" in sent
            else ws.memory_provider_id
        )
        changed = (new_mem_model, new_mem_provider) != (
            ws.memory_model_id,
            ws.memory_provider_id,
        )
        if changed and new_mem_model and new_mem_provider:
            await _validate_default_model(
                new_mem_provider, new_mem_model, user, db
            )
        ws.memory_model_id = new_mem_model
        ws.memory_provider_id = new_mem_provider
    if "is_template" in sent and payload.is_template is not None:
        ws.is_template = payload.is_template
    # Drive storage cap — owner-only (collaborators can edit content, but
    # capping the drive is a lifecycle decision like delete/share).
    if "storage_quota_bytes" in sent:
        if ws.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the workspace owner can change the storage cap.",
            )
        ws.storage_quota_bytes = payload.storage_quota_bytes
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    permanent: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Move a workspace to the owner's trash, or (``permanent=true`` on a
    trashed one) delete it for good.

    A delete used to be immediate and final: boards and cards, sheets,
    canvases, rosters, discussions and comments all cascade with the row
    (R-177). Now it's hidden from everyone and restorable for
    :data:`WORKSPACE_TRASH_DAYS` days, then the nightly maintenance purges
    it. On purge, conversations are preserved (``ON DELETE SET NULL``)
    and come back to their creators' chat lists."""
    ws = await _get_owned_workspace_any(workspace_id, user, db)
    title = ws.title
    if ws.trashed_at is None:
        if permanent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Move the workspace to the trash before deleting it for good.",
            )
        ws.trashed_at = datetime.now(timezone.utc)
        detail = f'"{title}" (ws={workspace_id}) moved to trash'
    else:
        if not permanent:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        await db.delete(ws)
        detail = f'"{title}" (ws={workspace_id}) deleted permanently'
    await record_event(
        db,
        event_type=EVENT_WORKSPACE_DELETED,
        request=request,
        user_id=user.id,
        detail=detail,
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{workspace_id}/events")
async def workspace_events(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Live feed of structural changes to this workspace — items, chats,
    files, members, automations — so open pages refresh when a teammate
    changes something (R-187). Access is checked on each connect."""
    from fastapi.responses import StreamingResponse

    from app.workspaces import live

    await get_accessible_workspace(workspace_id, user, db)
    # Hand the DB connection back before the long-lived stream starts.
    await db.close()
    return StreamingResponse(
        live.event_stream(workspace_id, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class DuplicateWorkspaceRequest(BaseModel):
    title: str | None = None


@router.post(
    "/{workspace_id}/duplicate",
    response_model=WorkspaceSummary,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_workspace(
    workspace_id: uuid.UUID,
    payload: DuplicateWorkspaceRequest,
    background: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    """A new workspace, owned by the caller, with this one's setup: its
    instructions, notebooks, notes, sheets, boards (columns, labels and
    cards), canvases, rosters and the caller's automations (paused).
    Chats, discussions, members and pinned files stay behind (R-204)."""
    from app.workspaces.duplicate import copy_workspace_content, schedule_indexing

    src, role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_admin(role)
    title = (payload.title or "").strip()[:255] or f"{src.title} (copy)"[:255]
    ws = Workspace(user_id=user.id, title=title)
    db.add(ws)
    await db.flush()
    ws_folder = await create_workspace_folder_tree(db, user, ws.title)
    ws.root_folder_id = ws_folder.id
    to_index = await copy_workspace_content(db, src=src, dest=ws, user=user)
    await record_event(
        db,
        event_type=EVENT_WORKSPACE_CREATED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id}) duplicated from ws={src.id}',
    )
    await db.commit()
    await db.refresh(ws)
    schedule_indexing(background, ws.id, to_index)
    return await _summary_with_rollups(ws, db, user)


@router.post("/{workspace_id}/restore", response_model=WorkspaceSummary)
async def restore_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    """Bring a trashed workspace back, exactly as it was (R-177)."""
    ws = await _get_owned_workspace_any(workspace_id, user, db)
    if ws.trashed_at is not None:
        ws.trashed_at = None
        ws.updated_at = datetime.now(timezone.utc)
        await record_event(
            db,
            event_type=EVENT_WORKSPACE_UNARCHIVED,
            request=request,
            user_id=user.id,
            detail=f'"{ws.title}" (ws={ws.id}) restored from trash',
        )
        await db.commit()
        await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


class TransferWorkspaceRequest(BaseModel):
    user_id: uuid.UUID
    # Stay on as an admin member (the usual case) or step away entirely.
    keep_access: bool = True


@router.post("/{workspace_id}/transfer", response_model=WorkspaceSummary)
async def transfer_workspace_ownership(
    workspace_id: uuid.UUID,
    payload: TransferWorkspaceRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    """Hand the workspace — and its Drive folder and files — to one of its
    admins. There was no way to do this short of an admin deleting the
    owner's account (R-177)."""
    from app.chat.models import WorkspaceShare
    from app.workspaces.ownership import transfer_workspace

    ws = await _get_owned_workspace(workspace_id, user, db)
    share = (
        await db.execute(
            select(WorkspaceShare).where(
                WorkspaceShare.workspace_id == ws.id,
                WorkspaceShare.invitee_user_id == payload.user_id,
                WorkspaceShare.status == "accepted",
            )
        )
    ).scalars().first()
    new_owner = await db.get(User, payload.user_id)
    if (
        share is None
        or share.role != "admin"
        or new_owner is None
        or new_owner.disabled
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The new owner has to be an active admin of this workspace.",
        )
    await transfer_workspace(db, ws, new_owner)
    if payload.keep_access:
        db.add(
            WorkspaceShare(
                workspace_id=ws.id,
                inviter_user_id=new_owner.id,
                invitee_user_id=user.id,
                status="accepted",
                role="admin",
                accepted_at=datetime.now(timezone.utc),
            )
        )
    ws.updated_at = datetime.now(timezone.utc)
    from app.auth.events import EVENT_WORKSPACE_SHARE_CREATED

    await record_event(
        db,
        event_type=EVENT_WORKSPACE_SHARE_CREATED,
        request=request,
        user_id=user.id,
        detail=f'"{ws.title}" (ws={ws.id}) ownership → {new_owner.username}',
    )
    await db.commit()
    await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


# ---------------------------------------------------------------------
# Archive / unarchive
# ---------------------------------------------------------------------


@router.post("/{workspace_id}/archive", response_model=WorkspaceSummary)
async def archive_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    ws = await _get_owned_workspace(workspace_id, user, db)
    if ws.archived_at is None:
        ws.archived_at = datetime.now(timezone.utc)
        ws.updated_at = ws.archived_at
        await record_event(
            db,
            event_type=EVENT_WORKSPACE_ARCHIVED,
            request=request,
            user_id=user.id,
            detail=f'"{ws.title}" (ws={ws.id})',
        )
        await db.commit()
        await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


@router.post("/{workspace_id}/unarchive", response_model=WorkspaceSummary)
async def unarchive_workspace(
    workspace_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceSummary:
    ws = await _get_owned_workspace(workspace_id, user, db)
    if ws.archived_at is not None:
        ws.archived_at = None
        ws.updated_at = datetime.now(timezone.utc)
        await record_event(
            db,
            event_type=EVENT_WORKSPACE_UNARCHIVED,
            request=request,
            user_id=user.id,
            detail=f'"{ws.title}" (ws={ws.id})',
        )
        await db.commit()
        await db.refresh(ws)
    return await _summary_with_rollups(ws, db, user)


# ---------------------------------------------------------------------
# Conversations inside a workspace
# ---------------------------------------------------------------------


@router.get(
    "/{workspace_id}/conversations",
    response_model=list[ConversationSummary],
)
async def list_workspace_conversations(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ConversationSummary]:
    """Return every conversation under ``workspace_id`` (most recent
    first).

    Once the caller has access to the workspace (owner or accepted
    collaborator) they see every chat *shared with the workspace*
    (``visibility='workspace'``) plus their own chats. Another member's
    private chat stays creator-only — even for the owner (R-040, R-312).
    Individual conversation shares still work on top of this and remain
    invisible here; they're surfaced through the main sidebar.
    """
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    q = (
        select(Conversation)
        .where(
            Conversation.workspace_id == ws.id,
            conversation_visible_to(user.id),
        )
        .order_by(Conversation.updated_at.desc())
    )
    res = await db.execute(q)
    return [
        ConversationSummary.model_validate(c) for c in res.scalars().all()
    ]


@router.delete(
    "/{workspace_id}/conversations",
    response_model=dict,
    status_code=status.HTTP_200_OK,
)
async def remove_all_conversations_from_workspace(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Bulk-detach every conversation from this workspace.

    Sets ``workspace_id = NULL`` on every conversation currently under the
    workspace. Conversations are *preserved* — they move back to the
    top-level chat list. Useful when you want to dissolve an archived
    workspace without losing history.

    Owner-only: collaborators don't have permission to reorganise the
    workspace's conversation list in bulk.
    """
    ws = await _get_owned_workspace(workspace_id, user, db)
    result = await db.execute(
        select(Conversation).where(Conversation.workspace_id == ws.id)
    )
    convs = result.scalars().all()
    removed = 0
    for conv in convs:
        conv.workspace_id = None
        removed += 1
    if removed:
        ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"removed": removed}


# ---------------------------------------------------------------------
# Usage rollup
# ---------------------------------------------------------------------


@router.get("/{workspace_id}/usage", response_model=WorkspaceUsage)
async def workspace_usage(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceUsage:
    """Token + cost usage aggregated over every conversation in the
    workspace. Built from message-level stats because ``usage_daily`` is
    keyed by ``(user_id, day)`` and can't be sliced by workspace.

    Scoped to the workspace's conversations (all collaborators' chats),
    gated by :func:`get_accessible_workspace`."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)

    conv_count = int(
        await db.scalar(
            select(func.count())
            .select_from(Conversation)
            .where(Conversation.workspace_id == ws.id)
        )
        or 0
    )

    # One grouped pass over the workspace's messages, attributed to each
    # conversation's model (``messages`` rows don't carry a model — the
    # model lives on the conversation). This attributes a chat's whole
    # spend to its *current* model, which is the only model key we
    # retain; good enough for a per-workspace rollup. ``model_id`` is NULL
    # for conversations that never had one persisted.
    rows = (
        await db.execute(
            select(
                Conversation.model_id.label("model_id"),
                func.count(Message.id).label("messages"),
                func.coalesce(func.sum(Message.prompt_tokens), 0).label("pt"),
                func.coalesce(func.sum(Message.completion_tokens), 0).label("ct"),
                func.coalesce(func.sum(Message.cost_usd_micros), 0).label("cost"),
            )
            .join(Message, Message.conversation_id == Conversation.id)
            .where(Conversation.workspace_id == ws.id)
            .group_by(Conversation.model_id)
        )
    ).all()

    message_count = sum(int(r.messages) for r in rows)
    prompt_tokens = sum(int(r.pt) for r in rows)
    completion_tokens = sum(int(r.ct) for r in rows)
    cost_micros = sum(int(r.cost) for r in rows)

    by_model = [
        WorkspaceUsageModel(
            model_id=r.model_id,
            messages=int(r.messages),
            prompt_tokens=int(r.pt),
            completion_tokens=int(r.ct),
            cost_usd=round(int(r.cost) / 1_000_000, 6),
        )
        for r in rows
        if r.model_id is not None
        and (int(r.pt) or int(r.ct) or int(r.cost))
    ]
    by_model.sort(
        key=lambda m: m.prompt_tokens + m.completion_tokens, reverse=True
    )

    return WorkspaceUsage(
        conversation_count=conv_count,
        message_count=message_count,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        cost_usd=round(cost_micros / 1_000_000, 6),
        by_model=by_model,
    )


# ---------------------------------------------------------------------
# Reindex pinned files (backfill)
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/reindex",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=dict,
)
async def reindex_workspace_files(
    workspace_id: uuid.UUID,
    background: BackgroundTasks,
    failed_only: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Queue a background re-index of the workspace's files, items, chats
    and automations (R-321); ``failed_only`` retries just what's queued or
    failed.

    Useful after enabling an embedding provider for the first time, or
    to backfill files pinned before Phase-2 that are still ``queued``.
    Owner-only: collaborators don't manage the workspace's embedding state.
    Returns immediately; the Files tab's polling will show progress.
    """
    ws = await _get_owned_workspace(workspace_id, user, db)
    background.add_task(reindex_workspace, ws.id, failed_only=failed_only)
    return {"queued": True}


# ---------------------------------------------------------------------
# Pinned files
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/files",
    response_model=WorkspaceFilePin,
    status_code=status.HTTP_201_CREATED,
)
async def pin_file(
    workspace_id: uuid.UUID,
    payload: WorkspacePinFile,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceFilePin:
    """Pin an existing :class:`UserFile` to the workspace.

    File must be owned by the caller (``user_files.user_id`` match).
    Admin-managed shared-pool files (``user_id IS NULL``) are *not*
    pinnable to a personal workspace today — the UX would be confusing
    (admins can already surface those via system folders).

    Collaborators on a shared workspace can pin their *own* files;
    the workspace owner (and other collaborators) will then see them
    in the workspace's file list the same way they see the owner's
    originals.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    uf = await db.get(UserFile, payload.file_id)
    if uf is None or uf.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found"
        )

    # Idempotent: re-pinning is a no-op, returns the existing row's
    # data so the client doesn't have to case on "already pinned".
    existing_q = await db.execute(
        select(WorkspaceFile).where(
            WorkspaceFile.workspace_id == ws.id,
            WorkspaceFile.file_id == uf.id,
        )
    )
    existing = existing_q.scalar_one_or_none()
    if existing is None:
        # Workspace drive cap applies to pins of existing files too —
        # otherwise pinning a large personal file would bypass it.
        if ws.storage_quota_bytes is not None:
            used = await db.scalar(
                select(func.coalesce(func.sum(UserFile.size_bytes), 0))
                .select_from(WorkspaceFile)
                .join(UserFile, UserFile.id == WorkspaceFile.file_id)
                .where(WorkspaceFile.workspace_id == ws.id)
            )
            if int(used or 0) + uf.size_bytes > ws.storage_quota_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=(
                        "Adding this file would exceed the workspace's "
                        "storage cap. Remove some files or raise the cap "
                        "in Settings."
                    ),
                )
        pin = WorkspaceFile(
            workspace_id=ws.id, file_id=uf.id, pinned_by=user.id
        )
        db.add(pin)
        ws.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(pin)
        # Kick off RAG indexing after the response is sent. The task
        # owns its own session and no-ops for images / when embeddings
        # aren't configured, so this is safe to fire unconditionally on
        # a fresh pin.
        background.add_task(index_file_for_workspace, ws.id, uf.id)
    else:
        pin = existing

    return WorkspaceFilePin(
        file_id=uf.id,
        filename=uf.filename,
        mime_type=uf.mime_type,
        size_bytes=uf.size_bytes,
        pinned_at=pin.pinned_at,
        indexing_status=pin.indexing_status,
        indexing_error=pin.indexing_error,
        context_enabled=pin.context_enabled,
    )


@router.patch(
    "/{workspace_id}/files/{file_id}/context",
    response_model=WorkspaceFilePin,
)
async def set_file_context(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: WorkspaceFileContext,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WorkspaceFilePin:
    """Toggle whether a pinned file feeds the workspace RAG context.

    Off keeps the file attached to the workspace (and its embeddings) but
    drops it from every chat's context until turned back on.
    """
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    pin = await db.get(WorkspaceFile, (ws.id, file_id))
    if pin is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not pinned"
        )
    pin.context_enabled = payload.enabled
    await db.commit()
    await db.refresh(pin)
    uf = await db.get(UserFile, file_id)
    return WorkspaceFilePin(
        file_id=file_id,
        filename=uf.filename if uf else "",
        mime_type=uf.mime_type if uf else "",
        size_bytes=uf.size_bytes if uf else 0,
        pinned_at=pin.pinned_at,
        indexing_status=pin.indexing_status,
        indexing_error=pin.indexing_error,
        context_enabled=pin.context_enabled,
    )


@router.delete(
    "/{workspace_id}/files/{file_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unpin_file(
    workspace_id: uuid.UUID,
    file_id: uuid.UUID,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)

    pin = await db.get(WorkspaceFile, (ws.id, file_id))
    if pin is None:
        # Idempotent: already unpinned.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    # Unpin guard: the owner can remove any file; a collaborator can
    # only remove files they pinned themselves (``pinned_by`` is NULL on
    # pre-0071 rows → owner-only). Stops one editor yanking another's
    # reference material out from under them.
    if access_role != "owner" and pin.pinned_by != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the workspace owner or the person who pinned this file can remove it.",
        )
    await db.delete(pin)
    ws.updated_at = datetime.now(timezone.utc)
    await db.commit()
    # Drop the file's workspace-scoped chunks so they stop surfacing in
    # retrieval. Best-effort, after the response.
    background.add_task(delete_workspace_file_chunks, ws.id, file_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------
# Move a conversation in / out of a workspace
# ---------------------------------------------------------------------


@router.post(
    "/{workspace_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def move_conversation_into_workspace(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Move an existing chat into the workspace.

    Caller must own the conversation (no moving someone else's
    chats into your workspace) and have access to the target
    workspace (owner or accepted collaborator). Temporary chats are
    rejected: tying a short-lived chat to a workspace complicates the
    cleanup sweep for negligible benefit."""
    ws, access_role = await get_accessible_workspace(workspace_id, user, db)
    require_workspace_write(access_role)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.temporary_mode is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Temporary chats can't belong to a workspace.",
        )
    conv.workspace_id = ws.id
    conv.updated_at = datetime.now(timezone.utc)
    ws.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)


@router.delete(
    "/{workspace_id}/conversations/{conversation_id}",
    response_model=ConversationSummary,
)
async def remove_conversation_from_workspace(
    workspace_id: uuid.UUID,
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConversationSummary:
    """Detach a chat from its workspace without deleting the chat
    itself — it resurfaces at the top level of the sidebar."""
    ws, _role = await get_accessible_workspace(workspace_id, user, db)
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if conv.workspace_id != ws.id:
        # Idempotent: already out, return the current state so the UI
        # doesn't need a special-case error path.
        return ConversationSummary.model_validate(conv)
    conv.workspace_id = None
    conv.updated_at = datetime.now(timezone.utc)
    ws.updated_at = conv.updated_at
    await db.commit()
    await db.refresh(conv)
    return ConversationSummary.model_validate(conv)
