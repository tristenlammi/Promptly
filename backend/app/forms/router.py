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
* ``POST /{file_id}/link`` (make, or ``reset``) / ``DELETE /{file_id}/link``
  (turn off) — the answer link ``/f/<token>`` (WP-F1.3);
  ``POST /{file_id}/send`` — send it to people on this server.
* ``GET /{file_id}/summary`` · ``GET /{file_id}/responses?question=`` ·
  ``GET|DELETE /{file_id}/responses/{n}`` · ``DELETE /{file_id}/responses``
  · ``GET /{file_id}/export?format=csv|xlsx`` — the Responses tab
  (WP-F1.4); ``PUT /{file_id}/notify`` and ``POST /{file_id}/seen`` — your
  notifications for this form.
* ``POST /{file_id}/ai/summary`` — Summarise the answers to a text
  question (WP-F1.7): themes with counts and short quotes, the answers
  sent as data; nothing stored. ``POST /from-event`` — an RSVP form for a
  Calendar event, linked to it.
* ``POST /{file_id}/uploads/{upload_id}/save`` — Save to Files: a copy of
  a file someone sent, into your own Drive (WP-F1.6).
* ``POST /{file_id}/sheet`` (link a new or existing sheet) ·
  ``POST /{file_id}/sheet/sync`` (Sync now) · ``DELETE /{file_id}/sheet``
  (unlink) — the linked Sheet (WP-F1.5, :mod:`app.forms.sheet`).

Every route checks :mod:`app.forms.access`; anything you can't open is a
404, never a 403.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
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
        # The answer link (Send, WP-F1.3), for people who can change the form.
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
    # New or renamed questions reach the linked sheet's header (WP-F1.5).
    from app.forms.sheet import sync_soon

    sync_soon(form)
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
    if "collect_email" in changes or "audience" in changes:
        # An Email or Account column may be needed now (WP-F1.5).
        from app.forms.sheet import sync_soon

        sync_soon(form)
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


# --------------------------------------------------------------------
# The answer link and Send (WP-F1.3)
# --------------------------------------------------------------------
class _LinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Turn the current link off and make a new one.
    reset: bool = False


@router.post("/{file_id:uuid}/link")
async def make_link(
    file_id: uuid.UUID,
    payload: _LinkRequest | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The form's answer link (``/f/<token>``): made the first time,
    replaced with ``reset`` (the old one stops working at once)."""
    shell, form, access = await load_form(db, file_id, user, need="edit", lock=True)
    await service.make_link(db, shell, form, by=user, reset=bool(payload and payload.reset))
    await db.commit()
    await db.refresh(form)
    return await _view(db, shell, form, access, user)


@router.delete("/{file_id:uuid}/link")
async def turn_off_link(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Turn the answer link off: it says "doesn't exist" from now on."""
    shell, form, access = await load_form(db, file_id, user, need="edit", lock=True)
    await service.turn_off_links(db, shell)
    await db.commit()
    await db.refresh(form)
    return await _view(db, shell, form, access, user)


class _SendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


@router.post("/{file_id:uuid}/send")
async def send_to_people(
    file_id: uuid.UUID,
    payload: _SendRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Send the form to people on this server: each gets a notification
    that opens the answer page. It never gives them the form itself."""
    from app.notifications.dispatch import notify_user

    shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    link = await service.make_link(db, shell, form, by=user)
    token = link.token
    await db.commit()
    ids = list(dict.fromkeys(payload.user_ids))
    people = (
        await db.execute(select(User).where(User.id.in_(ids), User.disabled.is_(False)))
    ).scalars().all()
    title = (form.definition or {}).get("title") or "Untitled form"
    sent = 0
    for person in people:
        if person.id == user.id:
            continue
        await notify_user(
            user_id=person.id,
            category="invite",
            title=f"{user.username} sent you a form",
            body=f"“{title}”. Tap to fill it in.",
            url=f"/f/{token}",
            tag=f"form-send:{form.id}",
            actor_user_id=user.id,
        )
        sent += 1
    return {"sent": sent}


# --------------------------------------------------------------------
# Responses, downloads and notifications (WP-F1.4)
# --------------------------------------------------------------------
@router.get("/{file_id:uuid}/summary")
async def responses_summary(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """The Responses tab's summary: every question's counts, and how many
    answers are new to you. Answers are other people's words, sent as plain
    text."""
    from app.forms import notify, results

    shell, form, access = await load_form(db, file_id, user)
    out = await results.summary(db, form, user)
    out["new_count"] = await notify.unseen_count(db, form.id, user.id)
    out["can_delete"] = access == "edit"
    out["accepting"] = bool(form.accepting)
    out["notify"] = await notify.settings_for(db, shell, form, user)
    # The Sheet card (WP-F1.5).
    from app.forms import sheet

    out["sheet"] = await sheet.status(db, form, user)
    out["can_link_sheet"] = access == "edit"
    return out


@router.get("/{file_id:uuid}/responses")
async def question_responses(
    file_id: uuid.UUID,
    question: str = Query(..., min_length=1, max_length=40),
    before: int | None = Query(None, ge=1),
    q: str | None = Query(None, max_length=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Every answer to one question, newest first (``before`` pages back);
    ``q`` searches a text question's answers (or a choice's "Other")."""
    from app.forms import results

    _shell, form, _access = await load_form(db, file_id, user)
    out = await results.question_answers(db, form, question, before=before, search=q, user=user)
    if out is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")
    return out


@router.get("/{file_id:uuid}/responses/{number:int}")
async def one_response(
    file_id: uuid.UUID,
    number: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """One answer, with where it sits among the rest (``‹ 3 of 12 ›``)."""
    from app.forms import results

    _shell, form, _access = await load_form(db, file_id, user)
    out = await results.one(db, form, number, user)
    if out is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That answer isn't here any more.")
    return out


@router.delete("/{file_id:uuid}/responses/{number:int}")
async def delete_response(
    file_id: uuid.UUID,
    number: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Delete one answer for good. Its places on limited options and its
    storage are given back; the linked sheet (WP-F1.5) keeps its row."""
    from app.forms import results

    shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    if not await results.delete_one(db, shell, form, number):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That answer isn't here any more.")
    await db.commit()
    return {"deleted": 1, "response_count": form.response_count}


@router.delete("/{file_id:uuid}/responses")
async def delete_all_responses(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Delete every answer (the page asks twice first)."""
    from app.forms import results

    shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    n = await results.delete_all(db, shell, form)
    await db.commit()
    return {"deleted": n, "response_count": 0}


@router.get("/{file_id:uuid}/export")
async def export_responses(
    file_id: uuid.UUID,
    format: Literal["csv", "xlsx"] = Query("csv"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Every answer as CSV or Excel. Values that a spreadsheet could run as
    a formula start with ``'``; Excel cells are stored as text."""
    from fastapi.responses import Response

    from app.files.router import _content_disposition
    from app.forms import results

    shell, form, _access = await load_form(db, file_id, user)
    data, filename, mime = await results.export(db, shell, form, user, format)
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Content-Disposition": _content_disposition(filename),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


class _Summarise(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_id: str = Field(min_length=1, max_length=40)
    provider_id: uuid.UUID | None = None
    model_id: str | None = Field(default=None, max_length=200)


@router.post("/{file_id:uuid}/ai/summary")
async def summarise_answers(
    file_id: uuid.UUID,
    payload: _Summarise,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Summarise the answers to one text question: a few themes with counts
    and short quotes that link to their answers. The answers are other
    people's words — sent to the model as data inside
    ``<untrusted_content>``, on a call with no tools — and the result is
    shown as text and never stored or remembered."""
    from sqlalchemy import text as sql_text

    from app.files.editor_ai import EditorAiError, _http, _quotas, complete, parse_json, resolve_model
    from app.forms import ai as form_ai_mod
    from app.forms.definition import questions
    from app.models_config.provider import ChatMessage

    _shell, form, _access = await load_form(db, file_id, user)
    q = next((x for x in questions(form.definition or {}, include_deleted=True) if x["id"] == payload.question_id), None)
    if q is None or q.get("kind") not in ("short_text", "paragraph"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Only written answers can be summarised.")
    rows = (
        await db.execute(
            sql_text(
                "SELECT r.number, r.answers ->> CAST(:q AS text) FROM form_responses r "
                "WHERE r.form_id = :f AND r.deleted_at IS NULL AND jsonb_exists(r.answers, CAST(:q AS text)) "
                "ORDER BY r.number DESC LIMIT :n"
            ),
            {"f": form.id, "q": payload.question_id, "n": form_ai_mod.SUMMARY_ANSWERS},
        )
    ).all()
    answers = [(int(n), str(t or "")) for n, t in rows if (t or "").strip()]
    if len(answers) < 2:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="There aren't enough answers to summarise yet.")
    await _quotas(request, user, db)
    provider, model_id = await resolve_model(db, user, payload.provider_id, payload.model_id)
    title = (q.get("title") or "").strip() or "Untitled question"
    prompt = (
        f"The question was: {title[:300]}\n"
        f"There are {len(answers)} answers. Everything inside the untrusted_content block is what people wrote:\n\n"
        + form_ai_mod.untrusted_block(answers)
    )
    # No tools on this call: complete() streams a plain answer.
    raw = await complete(provider, model_id, system=form_ai_mod.SUMMARY_SYSTEM,
                         messages=[ChatMessage(role="user", content=prompt)], max_tokens=2500, temperature=0.2)
    try:
        themes = form_ai_mod.themes_from(parse_json(raw), dict(answers))
    except EditorAiError as exc:
        raise _http(exc) from exc
    if not themes:
        raise _http(EditorAiError("The summary didn't come back in a usable shape. Try again."))
    return {"question_id": q["id"], "answers": len(answers), "themes": themes}


class _FromEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: uuid.UUID


@router.post("/from-event", status_code=status.HTTP_201_CREATED)
async def rsvp_from_event(
    payload: _FromEvent,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """"Add an RSVP form" on a Calendar event: an RSVP form with the
    event's title, time and place written into its description, linked to
    the event (both ways). An event that already has one gets it back."""
    from app.files.router import _file_to_response
    from app.forms.calendar_link import rsvp_for_event

    shell, made = await rsvp_for_event(db, user, payload.event_id)
    await db.commit()
    await db.refresh(shell)
    return {"file": _file_to_response(shell, caller=user).model_dump(mode="json"), "made": made}


@router.post("/{file_id:uuid}/uploads/{upload_id:uuid}/save", status_code=status.HTTP_201_CREATED)
async def save_upload_to_files(
    file_id: uuid.UUID,
    upload_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    _room: None = Depends(require_disk_room),
) -> dict:
    """Save to Files: copy a file someone sent into your own Drive (your
    Forms folder), through the normal upload path — so it gets every check
    and everything Files does with a file (search, previews…). Your
    storage counts the copy."""
    from app.files import blobstore
    from app.files.router import ingest_staged
    from app.files.storage import absolute_path
    from app.files.system_folders import ensure_forms_folder
    from app.forms import uploads
    from app.forms.models import FormUpload

    _shell, form, _access = await load_form(db, file_id, user)
    up = await db.get(FormUpload, upload_id)
    row = await uploads.readable(db, up.file_id, user) if up is not None and up.form_id == form.id else None
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That file isn't here any more.")
    path = absolute_path(row.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="That file isn't here any more.")
    folder = await ensure_forms_folder(db, user)
    await db.commit()
    with open(path, "rb") as fh:
        staged = await blobstore.stage_upload(fh)
    try:
        saved = await ingest_staged(
            db, request=request, user=user, staged=staged, filename=row.filename, declared_mime=row.mime_type,
            scope="mine", folder_id=folder.id, route=None, on_conflict="keep_both", workspace_id=None,
            last_modified=None, exact_folder=True,
        )
    finally:
        blobstore.blobstore.discard(staged)
    return {"file": saved.model_dump(mode="json") if hasattr(saved, "model_dump") else saved}


# --------------------------------------------------------------------
# The linked sheet (WP-F1.5)
# --------------------------------------------------------------------
class _LinkSheet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # "new": make "<Form> (Responses)"; "existing": add a tab to ``file_id``.
    mode: Literal["new", "existing"] = "new"
    name: str | None = Field(default=None, max_length=200)
    file_id: uuid.UUID | None = None


async def _sheet_reply(db: AsyncSession, form, user: User) -> dict:
    from app.forms import sheet

    await db.refresh(form)
    return {"sheet": await sheet.status(db, form, user)}


@router.post("/{file_id:uuid}/sheet")
async def link_sheet(
    file_id: uuid.UUID,
    payload: _LinkSheet,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Link a sheet: a new spreadsheet next to the form (the default), or a
    "Form responses" tab added to one you can edit. The header row is
    written from the questions and the answers so far go in at once; after
    that each answer is added as it arrives. A form whose sheet was deleted
    (or is in the bin, or full) can link a new one."""
    from app.forms import sheet

    shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    if form.sheet_tab_id is not None:
        current = await sheet.status(db, form, user)
        if current and current["problem"] not in ("deleted", "trashed", "tab_deleted", "full"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This form already has a sheet. Unlink it first to use another.",
            )
    try:
        if payload.mode == "existing":
            if payload.file_id is None:
                raise sheet.SheetLinkError("Pick a spreadsheet.")
            await sheet.link_existing(db, form, user, payload.file_id)
        else:
            await sheet.link_new(db, shell, form, user, name=payload.name)
    except sheet.SheetLinkError as exc:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
    await db.commit()
    form_id = form.id
    try:
        await sheet.sync_form(form_id)
    except Exception:  # noqa: BLE001 — linked; the catch-up tick writes the rows
        import logging

        logging.getLogger("promptly.forms").exception("forms: first sheet sync failed")
    return await _sheet_reply(db, form, user)


@router.post("/{file_id:uuid}/sheet/sync")
async def sync_sheet_now(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """"Sync now": bring the linked sheet up to date (and every answer
    checked against it)."""
    from app.forms import sheet

    _shell, form, _access = await load_form(db, file_id, user, need="edit")
    if form.sheet_tab_id is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This form has no sheet.")
    await db.commit()  # don't hold anything while the sync runs
    await sheet.sync_form(form.id, everything=True)
    return await _sheet_reply(db, form, user)


@router.delete("/{file_id:uuid}/sheet")
async def unlink_sheet(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Stop updating the sheet. The sheet itself is kept as it is."""
    from app.forms import sheet

    _shell, form, _access = await load_form(db, file_id, user, need="edit", lock=True)
    await sheet._lock(db, form.id)  # not in the middle of a sync
    sheet.unlink(form)
    await db.commit()
    return {"sheet": None}


class _Notify(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["each", "daily", "off"] | None = None
    email_daily: bool | None = None


@router.put("/{file_id:uuid}/notify")
async def set_notify(
    file_id: uuid.UUID,
    payload: _Notify,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Your own choice for this form: tell me each time / once a day /
    never, and a daily email (only when this server can send email)."""
    from app.calendars.reach import smtp_ready
    from app.forms import notify

    shell, form, _access = await load_form(db, file_id, user)
    if payload.email_daily and not await smtp_ready(db):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This server can't send email yet. An admin can set it up in Admin → Settings.",
        )
    await notify.set_settings(db, shell, form, user, mode=payload.mode, email_daily=payload.email_daily)
    await db.commit()
    return await notify.settings_for(db, shell, form, user)


@router.post("/{file_id:uuid}/seen")
async def mark_seen(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """You looked at the answers: "new" counts from now."""
    from app.forms import notify

    shell, form, _access = await load_form(db, file_id, user)
    await notify.mark_seen(db, shell, form, user)
    await db.commit()
    return {"new_count": 0}


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
