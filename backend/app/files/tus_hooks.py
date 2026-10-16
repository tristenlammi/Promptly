"""Resumable uploads through the tusd sidecar (WP-8.2, Part C §5.6).

Big files (a 4 GB phone video) don't fit the one-request upload: Cloudflare
caps a request at 100 MB, a dropped connection starts again from zero, and
a refresh loses it. Files over the policy threshold go to tusd instead, in
~50 MB chunks it can resume, and tusd asks this backend at two moments:

* **pre-create** — before a byte is accepted: who's uploading (the
  forwarded ``Authorization``), where to (folder, workspace), the name
  (allowlist, a clash to ask about), the size (the admin's cap for big
  uploads), the disk, and the owner's storage — counting other big uploads
  still under way (a reservation in Redis). The upload gets an id we pick.
* **pre-finish** — when the last chunk is in: the file goes through exactly
  what any upload goes through (sniffed, hashed, quota checked, versioned
  or filed, pinned to a workspace…) and its id is sent back on that final
  response (``Upload-File-Id``).

``post-terminate`` releases a cancelled upload's reservation;
``post-finish`` tidies tusd's bookkeeping files. Abandoned uploads are
swept after a week (:func:`sweep`).

tusd treats any non-2xx hook reply as an internal error (the client sees a
500 and retries), so every reply here is 200 JSON: refusals are
``RejectUpload`` (pre-create) or an ``HTTPResponse`` status (pre-finish).
The endpoint is internal — nginx refuses ``/api/internal/`` from outside —
and needs ``TUS_HOOK_SECRET`` (``?key=``) when one is set.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request as StarletteRequest

from app.config import get_settings
from app.database import get_db
from app.files import storage

logger = logging.getLogger("promptly.files.tus")
settings = get_settings()

router = APIRouter()

TUS_DIR = ".tus"
STALE_SECONDS = 7 * 86400
_RESERVE = "promptly:tus:{}"
_OWNER = "promptly:tus:owner:{}"
DEFAULT_LARGE_MAX = 10 * 1024 ** 3


def tus_dir() -> Path:
    return storage.UPLOAD_ROOT / TUS_DIR


class _Reject(Exception):
    def __init__(self, status_code: int, detail: Any) -> None:
        self.status_code = status_code
        self.detail = detail

    def reply(self, hook: str) -> dict[str, Any]:
        response = {
            "StatusCode": self.status_code,
            "Body": json.dumps({"detail": self.detail}),
            "Header": {"Content-Type": "application/json"},
        }
        if hook == "pre-create":
            return {"RejectUpload": True, "HTTPResponse": response}
        return {"HTTPResponse": response}


# ------------------------------------------------------------------ helpers


def _headers(event: dict[str, Any]) -> dict[str, str]:
    raw = (event.get("HTTPRequest") or {}).get("Header") or {}
    return {k: (v[0] if isinstance(v, list) and v else str(v or "")) for k, v in raw.items()}


def client_request(event: dict[str, Any]) -> StarletteRequest:
    """The uploader's request as the audit log needs it (their address is
    in the headers nginx added, not tusd's own)."""
    headers = _headers(event)
    scope = {
        "type": "http",
        "method": (event.get("HTTPRequest") or {}).get("Method") or "PATCH",
        "path": "/api/files/tus/",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1", "replace")) for k, v in headers.items()],
        "client": None,
        "query_string": b"",
    }
    return StarletteRequest(scope)


async def _user(db: AsyncSession, event: dict[str, Any]):
    """Who's uploading — the same checks as any signed-in request."""
    from fastapi.security import HTTPAuthorizationCredentials

    from app.auth.deps import _get_singleton_user, _resolve_custom_user

    if settings.SINGLE_USER_MODE:
        return await _get_singleton_user(db)
    auth = _headers(event).get("Authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() == "basic":
        # A device with an app password allowed to upload (WP-8.3).
        from app.auth.basic import user_from_basic

        headers = _headers(event)
        ip = headers.get("X-Real-Ip") or headers.get("X-Forwarded-For", "").split(",")[0].strip() or "unknown"
        return await user_from_basic(db, auth, scope="upload", ip=ip)
    creds = HTTPAuthorizationCredentials(scheme=scheme or "Bearer", credentials=token) if token else None
    user = await _resolve_custom_user(creds, db)
    if user.must_change_password:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="password_change_required")
    return user


async def large_max_bytes(db: AsyncSession) -> int:
    """The admin's cap for one big (resumable) upload."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    cap = getattr(row, "max_upload_bytes_large", None) if row is not None else None
    return int(cap) if cap else DEFAULT_LARGE_MAX


async def _redis():
    from app.redis_client import redis

    return redis


async def _reserved_for(owner_id: uuid.UUID, excluding: str | None = None) -> int:
    r = await _redis()
    sizes = await r.hgetall(_OWNER.format(owner_id))
    return sum(int(v) for k, v in sizes.items() if k != excluding)


async def _reserve(upload_id: str, owner_id: uuid.UUID, size: int) -> None:
    r = await _redis()
    await r.set(_RESERVE.format(upload_id), json.dumps({"owner_id": str(owner_id), "size": size}), ex=STALE_SECONDS)
    await r.hset(_OWNER.format(owner_id), upload_id, size)
    await r.expire(_OWNER.format(owner_id), STALE_SECONDS)


async def _release(upload_id: str) -> None:
    r = await _redis()
    raw = await r.get(_RESERVE.format(upload_id))
    if raw:
        owner = json.loads(raw).get("owner_id")
        if owner:
            await r.hdel(_OWNER.format(owner), upload_id)
    await r.delete(_RESERVE.format(upload_id))


def _meta(upload: dict[str, Any]) -> dict[str, str]:
    return {k: str(v) for k, v in (upload.get("MetaData") or {}).items()}


def _plan_args(meta: dict[str, str], *, at_finish: bool) -> dict[str, Any]:
    def uid(key: str) -> uuid.UUID | None:
        try:
            return uuid.UUID(meta[key]) if meta.get(key) else None
        except ValueError:
            raise _Reject(status.HTTP_400_BAD_REQUEST, f"Bad {key}.") from None

    on_conflict = meta.get("on_conflict") or "allow"
    if on_conflict not in ("allow", "ask", "keep_both", "replace"):
        on_conflict = "allow"
    # The clash was settled before the bytes were sent; one that appeared
    # meanwhile keeps both rather than losing the upload.
    if at_finish and on_conflict == "ask":
        on_conflict = "keep_both"
    try:
        last_modified = int(meta["last_modified"]) if meta.get("last_modified") else None
    except ValueError:
        last_modified = None
    return {
        "filename": meta.get("filename") or "",
        "declared_mime": meta.get("filetype") or None,
        "scope": meta.get("scope") if meta.get("scope") in ("mine", "shared") else "mine",
        "folder_id": uid("folder_id"),
        "workspace_id": uid("workspace_id"),
        "route": meta.get("route") if meta.get("route") in ("chat", "generated", "camera") else None,
        "on_conflict": on_conflict,
        "last_modified": last_modified,
    }


# ------------------------------------------------------------------ hooks


async def _pre_create(db: AsyncSession, event: dict[str, Any]) -> dict[str, Any]:
    from app.files import disk_guard
    from app.files.router import plan_upload

    upload = event.get("Upload") or {}
    if upload.get("SizeIsDeferred") or upload.get("IsPartial") or upload.get("IsFinal"):
        raise _Reject(status.HTTP_400_BAD_REQUEST, "Uploads here need their size up front.")
    size = int(upload.get("Size") or 0)
    if size <= 0:
        raise _Reject(status.HTTP_400_BAD_REQUEST, "The file is empty.")
    user = await _user(db, event)
    cap = await large_max_bytes(db)
    if size > cap:
        raise _Reject(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That's larger than the {cap / 1024 ** 3:.3g} GB limit for one upload.",
        )
    try:
        disk_guard.ensure_room(size)
    except disk_guard.DiskFull as e:
        raise _Reject(status.HTTP_507_INSUFFICIENT_STORAGE, str(e)) from None
    meta = _meta(upload)
    if meta.get("import_job"):
        # An archive part for an import (WP-10.1): not a Drive file.
        from app.imports.router import plan_part

        try:
            await plan_part(db, user, meta["import_job"], meta.get("filename") or "", size)
        except HTTPException as e:
            raise _Reject(e.status_code, e.detail) from None
        return {"ChangeFileInfo": {"ID": uuid.uuid4().hex, "MetaData": meta}}
    args = _plan_args(meta, at_finish=False)
    plan = await plan_upload(db, request=client_request(event), user=user, size_hint=size, **args)
    if plan.owner_id is not None:
        # Other big uploads of this owner's still under way count too.
        from app.files.quota import get_quota

        reserved = await _reserved_for(plan.owner_id)
        quota = await get_quota(db, plan.quota_user)
        if reserved and quota.cap_bytes is not None and quota.used_bytes + reserved + size > quota.cap_bytes:
            raise _Reject(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                "With the other uploads still under way, this one would go over the storage limit.",
            )
    upload_id = uuid.uuid4().hex
    if plan.owner_id is not None:
        await _reserve(upload_id, plan.owner_id, size)
    meta["filename"] = plan.clean_name
    return {"ChangeFileInfo": {"ID": upload_id, "MetaData": meta}}


async def _pre_finish(db: AsyncSession, event: dict[str, Any]) -> dict[str, Any]:
    from app.files import blobstore
    from app.files.router import ingest_staged

    upload = event.get("Upload") or {}
    upload_id = str(upload.get("ID") or "")
    if not upload_id or "/" in upload_id or ".." in upload_id:
        raise _Reject(status.HTTP_400_BAD_REQUEST, "Unknown upload.")
    path = tus_dir() / upload_id
    size = int(upload.get("Size") or 0)
    try:
        if not path.is_file() or path.stat().st_size != size or int(upload.get("Offset") or 0) != size:
            raise _Reject(status.HTTP_409_CONFLICT, "The upload isn't complete.")
        user = await _user(db, event)
        meta = _meta(upload)
        if meta.get("import_job"):
            from app.imports.router import adopt_part

            n = await adopt_part(db, user, meta["import_job"], meta.get("filename") or "", path)
            return {"HTTPResponse": {"Header": {"Upload-File-Id": f"import-part-{n}"}}}
        await _release(upload_id)  # its own reservation is now real bytes
        args = _plan_args(_meta(upload), at_finish=True)
        # Into staging (a rename — same disk), hashed, then the one upload path.
        staged = await asyncio.to_thread(blobstore.blobstore.adopt, path)
    except HTTPException as e:
        path.unlink(missing_ok=True)
        raise _Reject(e.status_code, e.detail) from None
    except _Reject:
        path.unlink(missing_ok=True)
        raise
    try:
        resp = await ingest_staged(db, request=client_request(event), user=user, staged=staged, **args)
    except HTTPException as e:
        raise _Reject(e.status_code, e.detail) from None
    finally:
        blobstore.blobstore.discard(staged)  # a no-op once it's in place
    return {"HTTPResponse": {"Header": {"Upload-File-Id": str(resp.id)}}}


async def _post_finish(event: dict[str, Any]) -> dict[str, Any]:
    upload_id = str((event.get("Upload") or {}).get("ID") or "")
    if upload_id and "/" not in upload_id and ".." not in upload_id:
        await asyncio.sleep(2)  # tusd lets go of its lock after replying
        for suffix in (".info", ".lock", ""):
            (tus_dir() / f"{upload_id}{suffix}").unlink(missing_ok=True)
    return {}


async def _post_terminate(event: dict[str, Any]) -> dict[str, Any]:
    upload_id = str((event.get("Upload") or {}).get("ID") or "")
    if upload_id:
        await _release(upload_id)
    return {}


def _caller_ok(request: Request, key: str | None) -> bool:
    secret = settings.TUS_HOOK_SECRET or ""
    if secret:
        return hmac.compare_digest(secret, key or "")
    # No secret configured: only a container on the internal network (no
    # nginx-forwarded headers — nginx refuses /api/internal/ anyway).
    from app.rate_limit import _is_service_call

    return _is_service_call(request)


@router.post("/tus-hook")
async def tus_hook(request: Request, key: str | None = Query(default=None), db: AsyncSession = Depends(get_db)) -> JSONResponse:
    if not _caller_ok(request, key):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    body = await request.json()
    hook = str(body.get("Type") or "")
    event = body.get("Event") or {}
    try:
        if hook == "pre-create":
            out = await _pre_create(db, event)
        elif hook == "pre-finish":
            out = await _pre_finish(db, event)
        elif hook == "post-finish":
            out = await _post_finish(event)
        elif hook == "post-terminate":
            out = await _post_terminate(event)
        else:
            out = {}
    except _Reject as r:
        out = r.reply(hook)
    except HTTPException as e:
        out = _Reject(e.status_code, e.detail).reply(hook)
    except Exception:  # noqa: BLE001 — a reply tusd understands, and the client can show
        logger.exception("tus %s hook failed", hook)
        out = _Reject(status.HTTP_500_INTERNAL_SERVER_ERROR, "The upload couldn't be saved. Try again.").reply(hook)
    return JSONResponse(out)


def sweep(max_age: float = STALE_SECONDS) -> int:
    """Delete uploads nobody finished within a week (their data, .info and
    .lock). Returns how many uploads went."""
    root = tus_dir()
    if not root.is_dir():
        return 0
    cutoff = time.time() - max_age
    gone: set[str] = set()
    for p in root.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                gone.add(p.name.split(".")[0])
        except OSError:
            continue
    return len(gone)


__all__ = ["TUS_DIR", "large_max_bytes", "router", "sweep", "tus_dir"]
