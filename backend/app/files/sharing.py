"""ACL helpers for peer-to-peer Drive share grants.

This module is the single source of truth for "who can see / copy
this file or folder?" — every read path in the files router calls
into here so we don't end up with N copies of the same logic
drifting apart.

Four core questions each helper answers:

1. **Is this resource shareable?** — Owner-owned, not in trash, not
   a system folder. Files inside system folders ARE shareable
   (chat upload of a doc you want to send a colleague is the
   canonical case).
2. **Does the caller have a grant on this resource?** — Either
   directly on the row, or via any ancestor folder grant.
3. **Effective ``can_copy`` for the caller** — true if any direct
   or ancestor grant on the resource has ``can_copy=true``.
4. **Render-ready grant summary** — for the wire payload, including
   the owner brief and other grantees.
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Iterable

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import FileFolder, ResourceGrant, UserFile
from app.files.schemas import GranteeBrief, GrantSummary


# --------------------------------------------------------------------
# Eligibility
# --------------------------------------------------------------------
def assert_folder_shareable(folder: FileFolder) -> None:
    """Raise if ``folder`` cannot be shared.

    System folders themselves are off-limits (renaming / deleting /
    moving them would break the auto-routing helpers; sharing them
    would expose a recipient to whatever the owner uploads later
    via chat / generation, which is a privacy footgun). Files
    *inside* system folders are still shareable individually — the
    block is only on the folder rows.
    """
    if folder.system_kind is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Can't share the {folder.name!r} system folder.",
        )
    if folder.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't share a trashed folder. Restore it first.",
        )
    if folder.user_id is None:
        # Should never hit this post-0042 (legacy pool was wiped),
        # but defensive in case future code reintroduces NULL owners.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This folder doesn't have an owner and can't be shared.",
        )


def assert_file_shareable(row: UserFile) -> None:
    if row.trashed_at is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't share a trashed file. Restore it first.",
        )
    if row.user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This file doesn't have an owner and can't be shared.",
        )


# --------------------------------------------------------------------
# Ancestor walk
# --------------------------------------------------------------------
async def ancestor_folder_ids(
    db: AsyncSession, folder_id: uuid.UUID | None
) -> list[uuid.UUID]:
    """Return ``folder_id`` plus every parent up to the root.

    Bounded to 64 hops to mirror the cycle defence elsewhere in the
    router — the tree shouldn't ever be that deep. Returns an empty
    list when ``folder_id`` is None (file at scope root).
    """
    out: list[uuid.UUID] = []
    if folder_id is None:
        return out
    cursor: uuid.UUID | None = folder_id
    hops = 0
    while cursor is not None and hops < 64:
        out.append(cursor)
        row = await db.get(FileFolder, cursor)
        if row is None:
            break
        cursor = row.parent_id
        hops += 1
    return out


# --------------------------------------------------------------------
# Caller access lookup
# --------------------------------------------------------------------
async def caller_grants_for_file(
    db: AsyncSession, row: UserFile, user: User
) -> list[ResourceGrant]:
    """Every grant covering ``row`` for ``user``.

    Walks the file's own grants + every ancestor folder's grants.
    Returns the raw ORM rows so callers can inspect ``can_copy``
    individually — the ``effective_*`` helpers below collapse the
    list when callers just want a yes/no.
    """
    folder_ids = await ancestor_folder_ids(db, row.folder_id)
    rows = (
        await db.execute(
            select(ResourceGrant).where(
                ResourceGrant.grantee_user_id == user.id,
                (
                    (
                        (ResourceGrant.resource_type == "file")
                        & (ResourceGrant.resource_id == row.id)
                    )
                    | (
                        (ResourceGrant.resource_type == "folder")
                        & (ResourceGrant.resource_id.in_(folder_ids))
                        if folder_ids
                        else (ResourceGrant.resource_type == "__never__")
                    )
                ),
            )
        )
    ).scalars().all()
    return list(rows)


async def caller_grants_for_folder(
    db: AsyncSession, folder: FileFolder, user: User
) -> list[ResourceGrant]:
    """Every folder-grant covering ``folder`` for ``user`` (self + ancestors)."""
    folder_ids = await ancestor_folder_ids(db, folder.id)
    if not folder_ids:
        return []
    rows = (
        await db.execute(
            select(ResourceGrant).where(
                ResourceGrant.grantee_user_id == user.id,
                ResourceGrant.resource_type == "folder",
                ResourceGrant.resource_id.in_(folder_ids),
            )
        )
    ).scalars().all()
    return list(rows)


def effective_can_copy(grants: Iterable[ResourceGrant]) -> bool:
    """True if any grant in the iterable carries ``can_copy=true``."""
    return any(g.can_copy for g in grants)


def effective_can_edit(grants: Iterable[ResourceGrant]) -> bool:
    """True if any grant in the iterable carries ``can_edit=true``.

    Stage 5.1: write access for grantees on Drive Documents. The
    router refuses to *issue* ``can_edit=true`` on folders or
    non-document files, so this never returns true for a folder
    cascade in practice — but the helper takes the same shape as
    :func:`effective_can_copy` so callers can use it uniformly.
    """
    return any(g.can_edit for g in grants)


async def caller_can_write_file(
    db: AsyncSession, row: UserFile, user: User
) -> bool:
    """True if ``user`` may mutate ``row`` (collab edit, manual save, …).

    Collapses the ownership + grant lookups into one yes/no the
    document router can ask without re-importing the sharing
    helpers everywhere. Logic:

    * Owner (row.user_id == user.id) → always writable.
    * Grantee with ``can_edit=true`` on the file or any ancestor
      folder → writable.
    * Anyone else → not writable (they can still *read* if they
      have any grant — that path goes through
      :func:`caller_grants_for_file`).

    Note: the issuance path (router) refuses ``can_edit=true`` on
    folder grants so in practice the folder-cascade branch is
    a defensive read; if the data is consistent with the API
    contract it'll never trigger.
    """
    if row.user_id is not None and row.user_id == user.id:
        return True
    grants = await caller_grants_for_file(db, row, user)
    return effective_can_edit(grants)


# --------------------------------------------------------------------
# Render summary
# --------------------------------------------------------------------
def _user_brief(
    grant: ResourceGrant,
    *,
    username: str,
    email: str | None,
) -> GranteeBrief:
    return GranteeBrief(
        grant_id=grant.id,
        user_id=grant.grantee_user_id,
        username=username,
        email=email,
        can_copy=grant.can_copy,
        can_edit=grant.can_edit,
    )


async def _users_by_id(
    db: AsyncSession, ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, User]:
    ids_list = list({i for i in ids})
    if not ids_list:
        return {}
    rows = (
        await db.execute(select(User).where(User.id.in_(ids_list)))
    ).scalars().all()
    return {u.id: u for u in rows}


async def grants_for_resource(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
) -> list[ResourceGrant]:
    rows = (
        await db.execute(
            select(ResourceGrant).where(
                ResourceGrant.resource_type == resource_type,
                ResourceGrant.resource_id == resource_id,
            )
        )
    ).scalars().all()
    return list(rows)


async def build_summary_for_resource(
    db: AsyncSession,
    *,
    resource_type: str,
    resource_id: uuid.UUID,
    owner_user_id: uuid.UUID,
    caller: User,
    direct_grants: list[ResourceGrant] | None = None,
) -> GrantSummary | None:
    """Build the ``GrantSummary`` (or None if nobody's involved).

    ``direct_grants`` is an optional pre-fetched list to save a
    round trip when the caller already has the rows.
    """
    grants = (
        direct_grants
        if direct_grants is not None
        else await grants_for_resource(
            db,
            resource_type=resource_type,
            resource_id=resource_id,
        )
    )
    if not grants:
        return None
    role: str = "owner" if caller.id == owner_user_id else "grantee"
    user_ids = {g.grantee_user_id for g in grants}
    if role == "grantee":
        user_ids.add(owner_user_id)
    users = await _users_by_id(db, user_ids)

    # Pill omits the caller themselves (you don't see your own name).
    grantees: list[GranteeBrief] = []
    caller_can_copy = False
    caller_can_edit = False
    for g in grants:
        if g.grantee_user_id == caller.id:
            caller_can_copy = g.can_copy
            caller_can_edit = g.can_edit
            continue
        u = users.get(g.grantee_user_id)
        if u is None:
            continue  # user vanished mid-flight; skip
        grantees.append(
            _user_brief(g, username=u.username, email=u.email)
        )

    owner_brief: GranteeBrief | None = None
    if role == "grantee":
        owner = users.get(owner_user_id)
        if owner is not None:
            # The owner isn't a grantee — but we reuse the brief shape
            # so the frontend pill / banner can render uniformly. The
            # ``grant_id`` is synthetic (zero UUID); both permission
            # flags are always true for the owner since they have
            # full control implicitly.
            owner_brief = GranteeBrief(
                grant_id=uuid.UUID(int=0),
                user_id=owner.id,
                username=owner.username,
                email=owner.email,
                can_copy=True,
                can_edit=True,
            )

    return GrantSummary(
        role=role,  # type: ignore[arg-type]
        grantees=grantees,
        can_copy=caller_can_copy if role == "grantee" else False,
        can_edit=caller_can_edit if role == "grantee" else False,
        owner=owner_brief,
    )


# --------------------------------------------------------------------
# Bulk summary loader (used by /browse to avoid N+1)
# --------------------------------------------------------------------
async def bulk_summaries(
    db: AsyncSession,
    *,
    files: list[UserFile],
    folders: list[FileFolder],
    caller: User,
) -> tuple[dict[uuid.UUID, GrantSummary], dict[uuid.UUID, GrantSummary]]:
    """Return (file_id -> summary, folder_id -> summary) in two queries.

    Used by the browse / starred / recent / search / trash endpoints
    so the per-row pill render doesn't fan out into one grant lookup
    per item.
    """
    file_ids = [f.id for f in files]
    folder_ids = [f.id for f in folders]

    grants_by_resource: dict[
        tuple[str, uuid.UUID], list[ResourceGrant]
    ] = defaultdict(list)
    if file_ids:
        rows = (
            await db.execute(
                select(ResourceGrant).where(
                    ResourceGrant.resource_type == "file",
                    ResourceGrant.resource_id.in_(file_ids),
                )
            )
        ).scalars().all()
        for g in rows:
            grants_by_resource[("file", g.resource_id)].append(g)
    if folder_ids:
        rows = (
            await db.execute(
                select(ResourceGrant).where(
                    ResourceGrant.resource_type == "folder",
                    ResourceGrant.resource_id.in_(folder_ids),
                )
            )
        ).scalars().all()
        for g in rows:
            grants_by_resource[("folder", g.resource_id)].append(g)

    # Resolve user briefs in a single query for everyone the pills
    # could possibly reference.
    user_ids: set[uuid.UUID] = set()
    for grants in grants_by_resource.values():
        for g in grants:
            user_ids.add(g.grantee_user_id)
    for f in files:
        if f.user_id is not None and f.user_id != caller.id:
            user_ids.add(f.user_id)
    for f in folders:
        if f.user_id is not None and f.user_id != caller.id:
            user_ids.add(f.user_id)
    users = await _users_by_id(db, user_ids)

    file_summaries: dict[uuid.UUID, GrantSummary] = {}
    folder_summaries: dict[uuid.UUID, GrantSummary] = {}
    for resource in files:
        summary = _summary_from_cache(
            grants_by_resource.get(("file", resource.id), []),
            owner_user_id=resource.user_id,
            caller=caller,
            users=users,
        )
        if summary is not None:
            file_summaries[resource.id] = summary
    for resource in folders:
        summary = _summary_from_cache(
            grants_by_resource.get(("folder", resource.id), []),
            owner_user_id=resource.user_id,
            caller=caller,
            users=users,
        )
        if summary is not None:
            folder_summaries[resource.id] = summary
    return file_summaries, folder_summaries


def _summary_from_cache(
    grants: list[ResourceGrant],
    *,
    owner_user_id: uuid.UUID | None,
    caller: User,
    users: dict[uuid.UUID, User],
) -> GrantSummary | None:
    if not grants:
        return None
    role: str = (
        "owner"
        if owner_user_id is not None and owner_user_id == caller.id
        else "grantee"
    )
    grantees: list[GranteeBrief] = []
    caller_can_copy = False
    caller_can_edit = False
    for g in grants:
        if g.grantee_user_id == caller.id:
            caller_can_copy = g.can_copy
            caller_can_edit = g.can_edit
            continue
        u = users.get(g.grantee_user_id)
        if u is None:
            continue
        grantees.append(_user_brief(g, username=u.username, email=u.email))
    owner_brief: GranteeBrief | None = None
    if role == "grantee" and owner_user_id is not None:
        owner = users.get(owner_user_id)
        if owner is not None:
            owner_brief = GranteeBrief(
                grant_id=uuid.UUID(int=0),
                user_id=owner.id,
                username=owner.username,
                email=owner.email,
                can_copy=True,
                can_edit=True,
            )
    return GrantSummary(
        role=role,  # type: ignore[arg-type]
        grantees=grantees,
        can_copy=caller_can_copy if role == "grantee" else False,
        can_edit=caller_can_edit if role == "grantee" else False,
        owner=owner_brief,
    )


# --------------------------------------------------------------------
# Shared-tab queries
# --------------------------------------------------------------------
async def folder_ids_caller_is_granted(
    db: AsyncSession, user: User
) -> list[uuid.UUID]:
    """Folder ids the caller has a direct grant on (incl. ancestors of files)."""
    rows = (
        await db.execute(
            select(ResourceGrant.resource_id).where(
                ResourceGrant.grantee_user_id == user.id,
                ResourceGrant.resource_type == "folder",
            )
        )
    ).scalars().all()
    return list(rows)


async def file_ids_caller_is_granted(
    db: AsyncSession, user: User
) -> list[uuid.UUID]:
    """File ids the caller has a direct grant on (folder cascades not expanded)."""
    rows = (
        await db.execute(
            select(ResourceGrant.resource_id).where(
                ResourceGrant.grantee_user_id == user.id,
                ResourceGrant.resource_type == "file",
            )
        )
    ).scalars().all()
    return list(rows)


async def expand_folder_subtree(
    db: AsyncSession, root_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """BFS from each root collecting every descendant folder id.

    Same shape as the router's existing ``_descendant_folder_ids``
    helper but accepts a list of starting points.
    """
    if not root_ids:
        return []
    collected: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    frontier = list(root_ids)
    hops = 0
    while frontier and hops < 64:
        new_frontier: list[uuid.UUID] = []
        for fid in frontier:
            if fid in seen:
                continue
            seen.add(fid)
            collected.append(fid)
            new_frontier.append(fid)
        if not new_frontier:
            break
        children = (
            await db.execute(
                select(FileFolder.id).where(
                    FileFolder.parent_id.in_(new_frontier),
                    FileFolder.trashed_at.is_(None),
                )
            )
        ).scalars().all()
        frontier = list(children)
        hops += 1
    return collected
