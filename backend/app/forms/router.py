"""Forms — the owner side, ``/api/forms`` (WP-F1.1).

A form is made through Files (``POST /api/files/office {kind: "form"}``,
blank or from a built-in template), and is copied, trashed, restored and
downloaded like any office file. These routes are the builder's:

* ``GET  ""`` — the Forms home (``?scope=mine|shared``); ``POST ""`` makes
  a form in your ``Forms`` folder (blank or from a template).
* ``GET  /templates`` — the built-in templates and your own saved ones.
* ``GET  /{file_id}`` — the definition, settings, your access, the link.
* ``PUT  /{file_id}/definition`` — save (409 when someone saved since).
* ``PATCH /{file_id}/settings``
* ``POST /{file_id}/assets`` — a picture for the header, a question or an
  option; ``POST /{file_id}/assets/from-file`` copies one from Photos/Files. ``GET /{file_id}/assets/{asset_id}`` serves it by a signed link.

Every route checks :mod:`app.forms.access`; anything you can't open is a
404, never a 403.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse as FastAPIFileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import get_db
from app.files.disk_guard import require_disk_room
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms import service
from app.forms.access import link_answers_allowed, load_form, not_found
from app.forms.definition import DefinitionError

router = APIRouter()


async def _view(db: AsyncSession, shell: UserFile, form, access: str, user: User) -> dict[str, Any]:
    from app.files.router import _file_to_response

    link = await service.live_link(db, shell)
    return {
        "file": _file_to_response(shell, caller=user).model_dump(mode="json"),
        "access": access,
        "is_owner": shell.user_id == user.id,
        "form": service.form_view(shell, form),
        # Answer links are made in WP-F1.3 (Send); shown here once one exists.
        "link": (
            {
                "token": link.token,
                "url": f"/f/{link.token}",
                "created_at": link.created_at.isoformat() if link.created_at else None,
            }
            if link is not None and access == "edit"
            else None
        ),
        "asset_urls": service.asset_urls(shell, form.definition or {}),
        "link_answers_allowed": await link_answers_allowed(db),
        "limits": service.LIMITS,
    }


@router.get("/templates")
async def get_templates(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The built-in templates (RSVP, Sign-up sheet, Feedback, Contact
    details, Event registration, Order form) and the forms you saved as
    templates."""
    from app.files.office_templates import office_title
    from app.files.system_folders import SystemKind, _fetch
    from app.forms.templates import listing

    mine: list[dict] = []
    folder = await _fetch(db, user.id, SystemKind.TEMPLATES)
    if folder is not None:
        rows = (
            await db.execute(
                select(UserFile)
                .where(
                    UserFile.folder_id == folder.id,
                    UserFile.user_id == user.id,
                    UserFile.trashed_at.is_(None),
                    UserFile.source_kind == GeneratedKind.FORM.value,
                )
                .order_by(UserFile.filename)
            )
        ).scalars().all()
        mine = [{"id": str(r.id), "title": office_title(r), "modified_at": r.modified_at} for r in rows]
    return {"built_in": listing(), "mine": mine}


@router.get("")
async def home(
    scope: Literal["mine", "shared"] = Query("mine"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The Forms home: your forms (``mine``) or forms shared with you, with
    answers, new answers since you last looked, and open or closed."""
    from app.forms.home import list_forms

    return {"forms": await list_forms(db, user, scope=scope)}


class _NewForm(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A built-in template (``GET /templates``) …
    template: str | None = Field(default=None, max_length=40)
    # … or one of your saved templates (a form file you can read).
    template_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=300)


@router.post("", status_code=status.HTTP_201_CREATED)
async def new_form(
    payload: _NewForm,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """A new form from the Forms home: blank, from a built-in template or
    from one you saved. It goes in your ``Forms`` folder (made the first
    time). Returns the new form's file."""
    from app.files.office import get_office_access
    from app.files.office_templates import office_title
    from app.files.quota import get_quota
    from app.files.router import _file_to_response
    from app.files.system_folders import ensure_forms_folder

    folder = await ensure_forms_folder(db, user)
    title = (payload.title or "").strip() or None
    if payload.template_id is not None:
        src = await db.get(UserFile, payload.template_id)
        if (
            src is None
            or src.source_kind != GeneratedKind.FORM.value
            or await get_office_access(db, src, user) == "none"
        ):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
        if not (await get_quota(db, user)).can_fit(src.size_bytes or 0):
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="This would exceed your storage quota.",
            )
        shell = await service.copy_form(db, src, owner=user, folder_id=folder.id, title=title or office_title(src))
    elif payload.template is not None:
        made = await service.from_template(db, owner=user, key=payload.template, title=title, folder_id=folder.id)
        if made is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
        shell = made[0]
    else:
        shell, _form = await service.create_form(db, owner=user, title=title or "Untitled form", folder_id=folder.id)
    await db.commit()
    await db.refresh(shell)
    return {"file": _file_to_response(shell, caller=user).model_dump(mode="json")}


@router.get("/{file_id:uuid}")
async def get_form(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    shell, form, access = await load_form(db, file_id, user)
    return await _view(db, shell, form, access, user)


class _SaveDefinition(BaseModel):
    definition: dict[str, Any]
    data_version: int = Field(ge=0)


@router.put("/{file_id:uuid}/definition")
async def save_definition(
    file_id: uuid.UUID,
    payload: _SaveDefinition,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Save the builder's questions. 409 ``{code: "stale"}`` with the newer
    definition when someone saved since ``data_version``; 422 ``{message,
    item_id}`` when the form breaks a rule (shown on that question)."""
    from app.files.activity import record_activity

    shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    try:
        await service.save_definition(db, shell, form, payload.definition, data_version=payload.data_version)
    except service.StaleDefinition as exc:
        current = {"data_version": exc.form.data_version, "definition": exc.form.definition}
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "stale",
                "message": "Someone else changed this form. Reload to see their changes.",
                **current,
            },
        ) from None
    except DefinitionError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "invalid", "message": str(exc), "item_id": exc.item_id},
        ) from None
    await record_activity(db, user_id=user.id, file_id=shell.id, kind="edited")
    await db.commit()
    await db.refresh(form)
    await db.refresh(shell)
    from app.files.router import _file_to_response

    return {
        "data_version": form.data_version,
        "definition": form.definition,
        "asset_urls": service.asset_urls(shell, form.definition or {}),
        # The title is the file's name, so a save can rename it.
        "file": _file_to_response(shell, caller=user).model_dump(mode="json"),
    }


class _Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audience: Literal["server", "link"] | None = None
    accepting: bool | None = None
    close_at: datetime | None = None
    max_responses: int | None = Field(default=None, ge=1, le=100_000)
    one_per_person: bool | None = None
    allow_edit: bool | None = None
    collect_email: bool | None = None
    show_remaining: bool | None = None
    allow_uploads_from_link: bool | None = None
    confirmation: str | None = Field(default=None, max_length=2000)
    closed_message: str | None = Field(default=None, max_length=2000)
    allow_another: bool | None = None


# Settings whose "off" is null — sending null clears them.
_NULLABLE = ("close_at", "max_responses")


@router.patch("/{file_id:uuid}/settings")
async def update_settings(
    file_id: uuid.UUID,
    payload: _Settings,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Change some settings; only the fields sent change (``close_at`` /
    ``max_responses`` set to null turn that limit off)."""
    shell, form, access = await load_form(db, file_id, user, need="edit", lock=True)
    sent = payload.model_dump(exclude_unset=True)
    changes = {k: v for k, v in sent.items() if v is not None or k in _NULLABLE}
    if "close_at" in changes and changes["close_at"] is not None and changes["close_at"].tzinfo is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Give the closing time with its time zone.",
        )
    for k in ("confirmation", "closed_message"):
        if k in changes:
            changes[k] = changes[k].strip()
    try:
        await service.apply_settings(db, form, changes)
    except service.SettingsError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
    await db.commit()
    await db.refresh(form)
    await db.refresh(shell)
    return await _view(db, shell, form, access, user)


@router.post("/{file_id:uuid}/assets", status_code=status.HTTP_201_CREATED)
async def upload_asset(
    file_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),
) -> dict:
    """A picture for the header, a question or an option (images only).
    Returns ``{id, url}``; put the id in the definition and save."""
    shell, _form, _access = await load_form(db, file_id, user, need="edit")
    try:
        row = await service.add_asset(db, shell, file)
    except service.AssetError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None
    finally:
        await file.close()
    await db.commit()
    return {"id": str(row.id), "url": service.asset_url(shell.id, row.id)}


class _AssetFromFile(BaseModel):
    file_id: uuid.UUID


@router.post("/{file_id:uuid}/assets/from-file", status_code=status.HTTP_201_CREATED)
async def asset_from_file(
    file_id: uuid.UUID,
    payload: _AssetFromFile,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),
) -> dict:
    """A picture from your Photos or Files, **copied** into the form (so a
    form's link never serves your library file). Same checks as an upload."""
    from types import SimpleNamespace

    from app.files.router import _load_readable_file
    from app.files.storage import absolute_path

    shell, _form, _access = await load_form(db, file_id, user, need="edit")
    try:
        src = await _load_readable_file(db, payload.file_id, user)
    except HTTPException:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Picture not found") from None
    if src.trashed_at is not None or not src.storage_path or not (src.mime_type or "").startswith("image/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only pictures can go in a form.")
    path = absolute_path(src.storage_path)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Picture not found")
    fh = open(path, "rb")  # noqa: SIM115 — closed below
    try:
        row = await service.add_asset(
            db, shell, SimpleNamespace(filename=src.filename or "image", content_type=src.mime_type, file=fh)
        )
    except service.AssetError as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from None
    finally:
        fh.close()
    await db.commit()
    return {"id": str(row.id), "url": service.asset_url(shell.id, row.id)}


@router.get("/{file_id:uuid}/assets/{asset_id:uuid}")
async def get_asset(
    file_id: uuid.UUID,
    asset_id: uuid.UUID,
    exp: int = Query(...),
    sig: str = Query(..., max_length=128),
    db: AsyncSession = Depends(get_db),
) -> FastAPIFileResponse:
    """One of a form's pictures, by the signed link the builder was given
    (``<img src>`` can't send a sign-in header)."""
    from app.files.storage import absolute_path

    if not service.verify_asset(file_id, asset_id, exp, sig):
        raise not_found()
    row = await service.asset_row(db, file_id, asset_id)
    shell = await db.get(UserFile, file_id)
    if row is None or shell is None or shell.trashed_at is not None:
        raise not_found()
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise not_found()
    return FastAPIFileResponse(
        path=str(path),
        media_type=row.mime_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, max-age=3600",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


__all__ = ["router"]
