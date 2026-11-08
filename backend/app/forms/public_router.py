"""Forms — the answer side, ``/api/f/{token}`` (WP-F1.3).

No sign-in dependency: people without an account answer link forms. A
Bearer token, when the page sends one, says who a signed-in respondent is
(``share_router._resolve_authed_user``); forms for "People on this server"
need it.

* ``GET  /{token}`` — the form as a respondent sees it, its state
  (``open`` / ``closed`` / ``sign_in``), places left, your earlier answer,
  and a signed start token. Unknown, turned-off, expired and trashed links,
  and link forms while the admin has link answers off, are all the same
  404.
* ``GET  /{token}/asset/{asset_id}`` — one of the form's pictures, by the
  signed link the page was given.
* ``POST /{token}/submit`` — ``{answers, submit_id, start_token, email?,
  website?}``; ``website`` is the honeypot. Idempotent on ``submit_id``.
* ``GET  /{token}/mine?edit=`` · ``PUT /{token}/mine`` — change your answer
  (signed in, or with the edit token from the confirmation).
* ``POST /{token}/report`` — ``{reason}``, link forms only.

Answering never gives access to the form's file: the link is a
``resource_type="form"`` row that nothing serving files reads.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse as FastAPIFileResponse
from limits import parse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import request_meta
from app.database import get_db
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms import responses
from app.forms.responses import Incoming, Refusal
from app.rate_limit import rate_limit

router = APIRouter()

# Route-level limits, per address (on top of the per-form ones in abuse.py).
_submit_limit = rate_limit(parse("10/minute"), bucket="form_submit")
_report_limit = rate_limit(parse("5/hour"), bucket="form_report")

MAX_BODY_BYTES = 128 * 1024


def _raise(exc: Refusal) -> HTTPException:
    headers = {"Retry-After": "60"} if exc.status == 429 else None
    return HTTPException(status_code=exc.status, detail=exc.detail(), headers=headers)


async def _who(request: Request, db: AsyncSession):
    """The signed-in respondent, or None. A sign-in token that's there but
    has run out is a 401, so the page refreshes it and tries again — rather
    than quietly answering as nobody (or being told to sign in) halfway
    through a form."""
    from app.files.share_router import _resolve_authed_user

    header = request.headers.get("authorization") or ""
    user = await _resolve_authed_user(request, db)
    if user is None and header.lower().startswith("bearer ") and header[7:].strip():
        from app.auth.utils import TokenError, decode_token

        try:
            decode_token(header[7:].strip(), expected_type="access")
        except TokenError:
            raise HTTPException(
                status_code=401, detail={"code": "signed_out", "message": "Your sign-in ran out."}
            ) from None
    return user


async def _body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise _raise(Refusal(413, "too_big", "These answers are too long to send. Shorten the longest ones."))
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        raise _raise(Refusal(400, "bad_request", "That didn't arrive in a shape the form understands.")) from None
    if not isinstance(data, dict):
        raise _raise(Refusal(400, "bad_request", "That didn't arrive in a shape the form understands."))
    return data


def _incoming(data: dict[str, Any]) -> Incoming:
    sid = data.get("submit_id")
    try:
        submit_id = uuid.UUID(str(sid)) if sid else None
    except ValueError:
        submit_id = None
    def text(key: str, limit: int) -> str | None:
        v = data.get(key)
        return v[:limit] if isinstance(v, str) else None

    return Incoming(
        answers=data.get("answers", {}),
        submit_id=submit_id,
        start_token=text("start_token", 200),
        email=text("email", 400),
        website=text("website", 2000),
        edit=text("edit", 200),
    )


@router.get("/{token}")
async def get_form(token: str, request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    user = await _who(request, db)
    ctx = await responses.load(db, token, user)
    if ctx.state == "gone":
        raise _raise(responses.gone())
    return await responses.page(db, ctx, user, token)


@router.get("/{token}/asset/{asset_id:uuid}")
async def get_asset(
    token: str,
    asset_id: uuid.UUID,
    exp: int = Query(...),
    sig: str = Query(..., max_length=128),
    db: AsyncSession = Depends(get_db),
) -> FastAPIFileResponse:
    from app.files.storage import absolute_path

    if not responses.verify_asset(token, asset_id, exp, sig):
        raise _raise(responses.gone())
    ctx = await responses.load(db, token, None)
    if ctx.state == "gone" or ctx.shell is None:
        raise _raise(responses.gone())
    row = await db.get(UserFile, asset_id)
    if (
        row is None
        or row.source_kind != GeneratedKind.FORM_ASSET.value
        or row.source_file_id != ctx.shell.id
        or not row.storage_path
    ):
        raise _raise(responses.gone())
    path = absolute_path(row.storage_path)
    if not path.exists():
        raise _raise(responses.gone())
    return FastAPIFileResponse(
        path=str(path),
        media_type=row.mime_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, max-age=21600",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


@router.post("/{token}/submit")
async def submit(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _limit: None = Depends(_submit_limit),
) -> dict:
    data = await _body(request)
    user = await _who(request, db)
    ip, _ua = request_meta(request)
    try:
        return await responses.submit(db, token, _incoming(data), user, ip=ip)
    except Refusal as exc:
        await db.rollback()
        raise _raise(exc) from None


@router.get("/{token}/mine")
async def get_mine(
    token: str,
    request: Request,
    edit: str | None = Query(default=None, max_length=200),
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = await _who(request, db)
    try:
        return await responses.mine(db, token, user, edit)
    except Refusal as exc:
        raise _raise(exc) from None


@router.put("/{token}/mine")
async def put_mine(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _limit: None = Depends(_submit_limit),
) -> dict:
    data = await _body(request)
    user = await _who(request, db)
    try:
        return await responses.edit(db, token, _incoming(data), user)
    except Refusal as exc:
        await db.rollback()
        raise _raise(exc) from None


@router.post("/{token}/report", status_code=204)
async def report(
    token: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _limit: None = Depends(_report_limit),
) -> None:
    data = await _body(request)
    reason = data.get("reason")
    try:
        await responses.report(db, token, reason if isinstance(reason, str) else "")
    except Refusal as exc:
        raise _raise(exc) from None


__all__ = ["router"]
