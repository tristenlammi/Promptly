"""``/api/items`` — the Item Store and item files.

Store
  ``GET    /store``                 the catalog, with what you've added
  ``POST   /store/{kind}``          add an item (it shows up in New)
  ``DELETE /store/{kind}``          remove it (your files stay)
  ``PUT    /store/admin``           admin: hide kinds from everyone

Files
  ``GET    /``                      your item files (``?kind=``)
  ``POST   /``                      a new file of a kind you've added
  ``GET    /{id}``                  the file: data, revision, access, kind info
  ``GET    /{id}/revision``         just the revision (cheap polling)
  ``PUT    /{id}``                  save ``data`` made against ``base_revision``
                                    (409 + the current state when it's stale)
  ``POST   /{id}/actions/{name}``   run one of the kind's actions
  ``POST   /{id}/restore/{vid}``    make a kept version current (Undo)
  ``POST   /{id}/ai`` …             the AI panel (``app.items.ai``)

Kinds can add their own endpoints under ``/k/{kind}/``.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.models import FileVersion, UserFile
from app.items import service
from app.items.models import ItemDocument
from app.items.registry import all_specs, get_spec
from app.items.spec import ActionError, ItemSpec

router = APIRouter()


# ------------------------------------------------------------------ shapes


def spec_brief(spec: ItemSpec) -> dict[str, Any]:
    return {
        "kind": spec.kind,
        "name": spec.name,
        "tagline": spec.tagline,
        "description": spec.description,
        "category": spec.category,
        "icon": spec.icon,
        "color": spec.color,
        "suffix": spec.suffix,
        "replaces": spec.replaces,
        "highlights": spec.highlights,
    }


def doc_out(row: UserFile, doc: ItemDocument, access: str, user: User) -> dict[str, Any]:
    spec = get_spec(doc.kind)
    return {
        "file_id": str(row.id),
        "kind": doc.kind,
        "title": service.title_of(row),
        "filename": row.filename,
        "folder_id": str(row.folder_id) if row.folder_id else None,
        "revision": doc.revision,
        "schema_version": doc.schema_version,
        "data": doc.data,
        "access": access,
        "is_owner": row.user_id == user.id,
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
        "starred": row.starred_at is not None,
        "size_bytes": int(row.size_bytes or 0),
        "max_bytes": spec.max_bytes if spec else 0,
        "can_archive": bool(spec and spec.archive),
        "spec": None
        if spec is None
        else {
            **spec_brief(spec),
            "ai_suggestions": spec.ai_suggestions,
            "ai_web": spec.ai_web,
            "actions": [
                {"name": a.name, "description": a.description, "writes": a.writes} for a in spec.actions
            ],
        },
    }


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")


def _conflict(c: service.Conflict) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={
            "detail": "This changed somewhere else — showing the latest.",
            "revision": c.doc.revision,
            "data": c.doc.data,
        },
    )


# ------------------------------------------------------------------- store


@router.get("/store")
async def store(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    mine = await service.installed_kinds(db, user)
    off = await service.disabled_kinds(db)
    counts: dict[str, int] = {}
    for _f, d in await service.list_items(db, user, limit=2000):
        counts[d.kind] = counts.get(d.kind, 0) + 1
    out = []
    for spec in sorted(all_specs().values(), key=lambda s: s.name.lower()):
        if spec.hidden:
            continue
        if spec.kind in off and user.role != "admin":
            continue
        out.append(
            {
                **spec_brief(spec),
                "installed": spec.kind in mine,
                "disabled": spec.kind in off,
                "files": counts.get(spec.kind, 0),
            }
        )
    return {"items": out, "is_admin": user.role == "admin"}


@router.post("/store/{kind}")
async def add_item(kind: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        await service.install(db, user, kind)
    except service.ItemNotFound:
        raise _not_found()
    await db.commit()
    return {"ok": True}


@router.delete("/store/{kind}")
async def remove_item(kind: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    await service.uninstall(db, user, kind)
    await db.commit()
    return {"ok": True}


class AdminStore(BaseModel):
    disabled: list[str] = Field(default_factory=list, max_length=200)


@router.put("/store/admin")
async def admin_store(
    payload: AdminStore, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admins only")
    known = set(all_specs())
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.disabled_items = sorted({k for k in payload.disabled if k in known})
    await db.commit()
    return {"disabled": row.disabled_items}


# ------------------------------------------------------------------ launcher

LAUNCHER_KEY = "apps_order"


@router.get("/launcher")
async def launcher(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """The Apps page: the apps this person added, in their order, with how
    many files each has and the one to open."""
    await service.ensure_apps_layout(db, user)
    await db.commit()
    available = await service.available_specs(db)
    mine = await service.installed_kinds(db, user)
    files = await service.list_items(db, user, limit=2000, archives=False)
    latest: dict[str, str] = {}
    counts: dict[str, int] = {}
    for f, d in files:  # newest first
        counts[d.kind] = counts.get(d.kind, 0) + 1
        latest.setdefault(d.kind, str(f.id))
    order = [k for k in ((user.settings or {}).get(LAUNCHER_KEY) or []) if isinstance(k, str)]
    kinds = [k for k in order if k in mine and k in available]
    kinds += sorted((k for k in mine if k in available and k not in kinds), key=lambda k: available[k].name.lower())
    return {
        "apps": [
            {**spec_brief(available[k]), "files": counts.get(k, 0), "latest": latest.get(k)} for k in kinds
        ]
    }


class LauncherOrder(BaseModel):
    order: list[str] = Field(default_factory=list, max_length=200)


@router.put("/launcher")
async def save_launcher(
    payload: LauncherOrder, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    from sqlalchemy.orm.attributes import flag_modified

    u = await db.get(User, user.id)
    settings = dict(u.settings or {})
    settings[LAUNCHER_KEY] = [k for k in dict.fromkeys(payload.order) if isinstance(k, str) and len(k) <= 48]
    u.settings = settings
    flag_modified(u, "settings")
    await db.commit()
    return {"order": settings[LAUNCHER_KEY]}


@router.post("/open/{kind}")
async def open_app(kind: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Launching an app: its most recently used file, or a new one."""
    try:
        row, created = await service.open_app(db, user, kind)
    except service.ItemNotFound:
        raise _not_found()
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    return {"file_id": str(row.id), "created": created}


# ------------------------------------------------------- an item as its own app


@router.get("/app/{kind}/manifest.webmanifest")
async def app_manifest(
    kind: str,
    id: uuid.UUID = Query(...),
    name: str = Query(default="", max_length=80),
) -> JSONResponse:
    """The web-app manifest that lets one item file install as its own app
    (``/app/<file id>/``: its own name, icon and window, no Promptly chrome).

    Public on purpose — browsers fetch manifests without credentials — so it
    reads nothing from the database: the kind's public look plus the name
    the page passes in. The app itself still needs the person signed in."""
    import re

    spec = get_spec(kind)
    if spec is None:
        raise _not_found()
    clean = re.sub(r"[\x00-\x1f<>]", "", name).strip()[:60] or spec.name
    short = clean if len(clean) <= 12 else spec.name[:12]
    base = f"/app/{id}/"
    icon = spec.kind if spec.kind in _ICON_KINDS else "item"
    manifest = {
        "name": clean,
        "short_name": short,
        "description": f"{spec.name} — {spec.tagline} Saved in your Promptly.",
        "id": base,
        "start_url": f"{base}?source=pwa",
        "scope": base,
        "display": "standalone",
        "background_color": "#1C1917",
        "theme_color": spec.color,
        "categories": ["productivity", "lifestyle"],
        "icons": [
            {"src": f"/item-icons/{icon}-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": f"/item-icons/{icon}-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": f"/item-icons/{icon}-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return JSONResponse(manifest, media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


# Kinds with their own icon set in frontend/public/item-icons (made by
# frontend/scripts/gen-item-icons.cjs); others use the generic one.
_ICON_KINDS = frozenset(
    {"workout", "health", "meals", "mealplan", "habits", "budget", "contacts", "trip", "journal",
     "boardgames", "flashcards", "example"}
)


# ------------------------------------------------------------------- files


@router.get("")
async def my_items(
    kind: str | None = Query(default=None, max_length=48),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    rows = await service.list_items(db, user, kind)
    return {
        "items": [
            {
                "file_id": str(f.id),
                "kind": d.kind,
                "title": service.title_of(f),
                "folder_id": str(f.folder_id) if f.folder_id else None,
                "updated_at": f.modified_at.isoformat() if f.modified_at else None,
            }
            for f, d in rows
            if get_spec(d.kind) is not None
        ]
    }


class CreateItem(BaseModel):
    kind: str = Field(max_length=48)
    title: str | None = Field(default=None, max_length=200)
    folder_id: uuid.UUID | None = None
    # A file to start from (an import of a download).
    data: dict[str, Any] | None = None


@router.post("", status_code=201)
async def create(payload: CreateItem, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    data = payload.data
    if isinstance(data, dict) and data.get("promptly_item") == payload.kind and isinstance(data.get("data"), dict):
        data = data["data"]  # a downloaded export
    try:
        row, doc = await service.create_item(
            db, user, payload.kind, title=payload.title, folder_id=payload.folder_id, data=data
        )
    except service.ItemNotFound:
        raise _not_found()
    except service.ItemExists as e:
        if data is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="You already have this app — each app has one file. Open it from Apps.",
            )
        # One app = one file: "new" opens the one there is.
        await db.commit()
        return JSONResponse(status_code=200, content=jsonable_encoder(doc_out(e.row, e.doc, "edit", user)))
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    return doc_out(row, doc, "edit", user)


@router.get("/{file_id}")
async def get_item(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        row, doc, access = await service.load(db, user, file_id)
    except service.ItemNotFound:
        raise _not_found()
    await db.commit()  # an upgrade of an old file sticks
    return doc_out(row, doc, access, user)


@router.get("/{file_id}/revision")
async def get_revision(file_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        _row, doc, _access = await service.load(db, user, file_id)
    except service.ItemNotFound:
        raise _not_found()
    return {"revision": doc.revision}


class SaveItem(BaseModel):
    """The whole new ``data``, or a JSON ``patch`` against ``base_revision``
    (what the app sends: one answer on a big deck is a few fields)."""

    data: dict[str, Any] | None = None
    patch: list[dict[str, Any]] | None = Field(default=None, max_length=20_000)
    base_revision: int


@router.put("/{file_id}")
async def save(
    file_id: uuid.UUID, payload: SaveItem, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    from app.items.ai import PatchError, apply_patch
    from app.items.jsonpatch import diff

    if (payload.data is None) == (payload.patch is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Send data or a patch.")
    try:
        row, doc, _access = await service.load(db, user, file_id, need="edit", lock=True)
        if payload.patch is not None:
            if payload.base_revision != doc.revision:
                raise service.Conflict(doc)
            try:
                target = apply_patch(doc.data, payload.patch)
            except (PatchError, ValueError, TypeError, IndexError, KeyError):
                # The client's idea of the file is off: hand it the real one.
                raise service.Conflict(doc)
        else:
            target = payload.data
        await service.save_data(db, user, row, doc, target, base_revision=payload.base_revision)
    except service.ItemNotFound:
        raise _not_found()
    except service.Conflict as c:
        return _conflict(c)
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    if payload.patch is not None:
        # What validation changed relative to what the client has — usually
        # nothing, so the file isn't sent back.
        return {"revision": doc.revision, "fix": diff(target, doc.data)}
    return {"revision": doc.revision, "data": doc.data}


class RunAction(BaseModel):
    args: dict[str, Any] = Field(default_factory=dict)


@router.post("/{file_id}/actions/{name}")
async def action(
    file_id: uuid.UUID,
    name: str,
    payload: RunAction,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Run a kind's action as the person (from the UI). A read-only action
    works with read access; one that writes needs edit."""
    import copy

    try:
        row, doc, access = await service.load(db, user, file_id, lock=True)
    except service.ItemNotFound:
        raise _not_found()
    spec = get_spec(doc.kind)
    act = spec.action(name) if spec else None
    if spec is None or act is None:
        raise _not_found()
    if act.writes and access != "edit":
        raise _not_found()
    data = copy.deepcopy(doc.data)
    ctx = service.make_context(db, user, row.id, spec)
    try:
        out = await service.run_action(ctx, spec, data, name, payload.args)
        if act.writes:
            await service.save_data(db, user, row, doc, data, base_revision=None)
    except ActionError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    return {"summary": out.summary, "result": out.result, "revision": doc.revision, "data": doc.data}


@router.post("/{file_id}/restore/{version_id}")
async def restore(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    try:
        row, doc, _access = await service.load(db, user, file_id, need="edit", lock=True)
        version = await db.get(FileVersion, version_id)
        if version is None:
            raise service.ItemNotFound()
        await service.restore(db, user, row, doc, version)
        # The AI panel's turn that made this version shows "Undone" from now
        # on — an Undo offered again after a reload would throw away newer edits.
        key = f"ai:{user.id}"
        thread = await service.get_state(db, row.id, key)
        if isinstance(thread, list) and any(t.get("version_id") == str(version_id) for t in thread):
            for t in thread:
                if t.get("version_id") == str(version_id):
                    t["undone"] = True
            await service.set_state(db, row.id, key, thread)
    except service.ItemNotFound:
        raise _not_found()
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    return {"revision": doc.revision, "data": doc.data}


class ArchiveItem(BaseModel):
    before: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/{file_id}/archive")
async def archive_item(
    file_id: uuid.UUID,
    payload: ArchiveItem,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Move data older than ``before`` into a new archive file beside this one."""
    try:
        row, doc, _access = await service.load(db, user, file_id, need="edit", lock=True)
        new_row = await service.archive(db, user, row, doc, payload.before)
    except service.ItemNotFound:
        raise _not_found()
    except service.ItemError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    await db.commit()
    return {"archive_id": str(new_row.id), "revision": doc.revision, "data": doc.data, "size_bytes": int(row.size_bytes or 0)}


def mount_kind_routers(parent: APIRouter) -> None:
    """Each kind's own endpoints, at ``/k/{kind}/…``."""
    for spec in all_specs().values():
        if spec.router is not None:
            parent.include_router(spec.router, prefix=f"/k/{spec.kind}")
