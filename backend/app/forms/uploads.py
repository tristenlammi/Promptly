"""Files people send with their answers (WP-F1.6, plan §8 "Files from
respondents").

Who may send what:

* **Signed-in people** — the kinds the question allows (pictures, PDFs,
  documents, spreadsheets, audio, video), each group narrowed to what the
  upload allowlist (``app.files.safety._ALLOWED_EXTS``) takes, so nothing
  outside it ever gets in (HTML never does).
* **People without an account** — only on link forms whose owner turned on
  "Let people without an account send files", and only pictures and PDFs.
  This server has no virus scanner; that's the line.

Every file gets the checks an upload gets — a clean file name, extension +
declared type + magic bytes (``sniff_and_validate``, which also checks
Office zips), the pixel limit, the disk floor — and pictures (and videos)
lose their metadata, location included, before they're kept.

Where they go: hidden ``form_upload`` file rows owned by the **form's
owner** (their storage quota counts them), hanging off the form's shell by
``source_file_id``. Never in Drive, Search, the Drive index or RAG (it's a
``HIDDEN_KINDS`` kind, and nothing reads its text); pictures get a tile
from the media worker, nothing gets an Office/PDF preview.

A file is *staged* when it's picked on the answer page (``form_uploads``
row with no response, tied to the page's draft key), and *claimed* when
the answer is sent. Staged files nobody sent are swept after a day
(:func:`sweep`); deleting an answer deletes its files; changing an answer
deletes the files it dropped.

Each form takes at most a day's worth of files (a rolling 24 hours): by
default 500 MB for a form for people on this server, 100 MB for a link
form — an admin can change both (Admin → Forms).

Serving: signed ``/m/`` links with their own claims (``form_upload`` for
the file, as a download in a sandbox; ``form_thumb`` for a picture's tile),
checked against :func:`app.forms.access.form_access` every time, so a link
dies when the form is trashed or the person loses access.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.forms import answering as ans
from app.forms.models import Form, FormResponse, FormUpload

if TYPE_CHECKING:
    from app.auth.models import User
    from app.forms.responses import AnswerCtx

logger = logging.getLogger("promptly.forms.uploads")

MB = 1024 * 1024
#: Each form's rolling 24-hour allowance, unless the admin set another.
DEFAULT_DAILY_MB = 500
DEFAULT_LINK_DAILY_MB = 100
#: Staged files nobody sent are deleted after this.
STAGED_TTL = timedelta(hours=24)
#: Files shown in a question's strip on the summary.
STRIP = 12

# The groups a question can allow, as file extensions. Only what the
# upload allowlist takes is ever used (``allowed_exts``).
GROUP_EXTS: dict[str, tuple[str, ...]] = {
    "images": (".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif", ".bmp"),
    "pdf": (".pdf",),
    "documents": (".docx", ".doc", ".odt", ".rtf", ".txt", ".md"),
    "spreadsheets": (".xlsx", ".xls", ".ods", ".csv"),
    "audio": (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"),
    "video": (".mp4", ".mov", ".m4v", ".3gp"),
}
GROUP_WORDS = {
    "images": "pictures",
    "pdf": "PDFs",
    "documents": "documents",
    "spreadsheets": "spreadsheets",
    "audio": "audio",
    "video": "videos",
}
# A phone offers its camera and gallery for these.
_GROUP_MIME = {"images": "image/*", "audio": "audio/*", "video": "video/*", "pdf": "application/pdf"}

NOT_TAKING = "This form can't take files right now."


# --------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------
def mode_for(form: Form, user: User | None) -> str:
    """Who's answering, for file questions: ``all`` (signed in), ``link``
    (no account, on a link form that takes their files) or ``none``."""
    if user is not None:
        return "all"
    if form.audience == "link" and form.allow_uploads_from_link:
        return "link"
    return "none"


def allowed_exts(kinds: list[str]) -> set[str]:
    """The extensions these groups allow — never anything the upload
    allowlist doesn't take."""
    from app.files.safety import _ALLOWED_EXTS

    out: set[str] = set()
    for k in kinds:
        out.update(e for e in GROUP_EXTS.get(k, ()) if e in _ALLOWED_EXTS)
    return out


def accept_attr(kinds: list[str]) -> str:
    """The ``accept`` for the answer page's file picker."""
    parts = sorted(allowed_exts(kinds))
    parts += [m for k, m in _GROUP_MIME.items() if k in kinds]
    return ",".join(parts)


def kinds_words(kinds: list[str]) -> str:
    words = [GROUP_WORDS.get(k, k) for k in kinds]
    if len(words) <= 1:
        return words[0] if words else "files"
    return f"{', '.join(words[:-1])} or {words[-1]}"


def page_rules(defn: dict[str, Any], files: str) -> dict[str, Any]:
    """What the answer page needs to offer the file questions it shows."""
    accept: dict[str, str] = {}
    for i in defn.get("items") or []:
        if i.get("kind") == "file_upload" and not i.get("deleted"):
            kinds = ans.file_kinds(i, files)
            if kinds:
                accept[i["id"]] = accept_attr(kinds)
    return {"mode": files, "accept": accept}


def hash_key(draft_key: str) -> str:
    return hashlib.sha256(draft_key.encode("utf-8")).hexdigest()


def _draft_ok(draft_key: Any) -> str | None:
    if isinstance(draft_key, str) and 16 <= len(draft_key) <= 100 and draft_key.isascii():
        return draft_key
    return None


async def daily_cap(db: AsyncSession, form: Form) -> int:
    """This form's 24-hour allowance, in bytes."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if form.audience == "link":
        mb = getattr(row, "forms_link_upload_cap_mb", None) or DEFAULT_LINK_DAILY_MB
    else:
        mb = getattr(row, "forms_upload_cap_mb", None) or DEFAULT_DAILY_MB
    return int(mb) * MB


async def used_today(db: AsyncSession, form_id: uuid.UUID, *, now: datetime | None = None) -> int:
    """Bytes of files this form took in the last 24 hours (sent or staged)."""
    since = (now or datetime.now(timezone.utc)) - timedelta(hours=24)
    total = await db.scalar(
        select(func.coalesce(func.sum(UserFile.size_bytes), 0))
        .select_from(FormUpload)
        .join(UserFile, UserFile.id == FormUpload.file_id)
        .where(FormUpload.form_id == form_id, FormUpload.created_at >= since)
    )
    return int(total or 0)


def _question(form: Form, question_id: str) -> dict[str, Any] | None:
    for i in (form.definition or {}).get("items") or []:
        if i.get("id") == question_id and i.get("kind") == "file_upload" and not i.get("deleted"):
            return i
    return None


# --------------------------------------------------------------------
# Taking a file (the answer page)
# --------------------------------------------------------------------
def _strip(path: Any, mime: str) -> None:
    """Drop a picture's (or video's) metadata — location first of all —
    before it's kept. Pictures through ExifTool, else Pillow; a video's
    tags through ExifTool, best effort."""
    import subprocess

    from app.files import egress
    from app.files.safety import strip_image_metadata_in_place

    if mime.startswith("image/"):
        if not (mime in egress.STRIPPABLE_MIMES and egress.strip_in_place(path)):
            strip_image_metadata_in_place(path, mime)
        return
    if mime.startswith("video/"):
        try:
            subprocess.run(
                ["exiftool", "-q", "-q", "-overwrite_original", "-all=", str(path)],
                capture_output=True,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            logger.warning("forms: couldn't strip a video's tags", exc_info=True)


async def stage(
    db: AsyncSession,
    ctx: AnswerCtx,
    user: User | None,
    *,
    question_id: str,
    draft_key: Any,
    upload: Any,
) -> dict[str, Any]:
    """Keep one file picked on the answer page, staged until the answer is
    sent. Returns ``{id, name, size, mime, image}``. Raises
    :class:`~app.forms.responses.Refusal` with the words to show. Commits."""
    from app.auth.models import User as UserModel
    from app.files import disk_guard
    from app.files.blobstore import hash_into
    from app.files.quota import get_quota
    from app.files.safety import UnsafeUploadError, sanitize_filename, sniff_and_validate
    from app.files.storage import (
        MAX_FILE_BYTES,
        absolute_path,
        copy_stream_to_disk_async,
        delete_blob,
        ensure_bucket,
        storage_path_for,
    )
    from app.forms.responses import CLOSED_MESSAGE, Refusal, gone

    if ctx.state == "gone":
        raise gone()
    form, shell = ctx.form, ctx.shell
    assert form is not None and shell is not None
    if ctx.state == "sign_in":
        raise Refusal(403, "sign_in", "Sign in to answer this form.")
    if ctx.state == "closed":
        raise Refusal(409, "closed", form.closed_message or CLOSED_MESSAGE)
    files = mode_for(form, user)
    item = _question(form, question_id)
    kinds = ans.file_kinds(item, files) if item is not None else []
    if not kinds:
        raise Refusal(403, "no_files", "This question doesn't take files from you.", question_id=question_id)
    key = _draft_ok(draft_key)
    if key is None:
        raise Refusal(400, "bad_request", "This page is out of date. Reload it to add files.")
    cfg = item.get("config") or {}
    most = int(cfg.get("max_files") or 1)
    staged_here = int(
        await db.scalar(
            select(func.count())
            .select_from(FormUpload)
            .where(
                FormUpload.form_id == form.id,
                FormUpload.question_id == question_id,
                FormUpload.response_id.is_(None),
                FormUpload.draft_key_hash == hash_key(key),
            )
        )
        or 0
    )
    if staged_here >= most:
        raise Refusal(
            409,
            "too_many",
            "You can send 1 file here. Remove it to add another." if most == 1 else f"You can send {most} files here.",
            question_id=question_id,
        )

    def refuse(status: int, code: str, message: str) -> Refusal:
        return Refusal(status, code, message, question_id=question_id)

    try:
        name = sanitize_filename(getattr(upload, "filename", None) or "file")
    except UnsafeUploadError:
        raise refuse(415, "bad_type", "That file's name can't be used. Rename it and try again.") from None
    ext = os.path.splitext(name)[1].lower()
    if ext not in allowed_exts(kinds):
        raise refuse(415, "bad_type", f"This question takes {kinds_words(kinds)} only.")

    owner = await db.get(UserModel, shell.user_id) if shell.user_id else None
    if owner is None:
        raise gone()
    quota = await get_quota(db, owner)
    if not quota.can_fit(1):
        raise refuse(507, "no_room", NOT_TAKING)
    try:
        disk_guard.ensure_room()
    except disk_guard.DiskFull:
        raise refuse(507, "no_room", NOT_TAKING) from None
    cap = await daily_cap(db, form)
    used = await used_today(db, form.id)
    if used >= cap:
        raise refuse(429, "daily_full", "This form has taken all the files it can for today. Try again tomorrow.")

    limit_mb = int(cfg.get("max_size_mb") or 10)
    limit = min(limit_mb * MB, MAX_FILE_BYTES)
    new_id = uuid.uuid4()
    rel = storage_path_for(shell.user_id, new_id, ext)
    ensure_bucket(shell.user_id)
    try:
        size = await copy_stream_to_disk_async(upload.file, rel, size_limit=limit)
    except ValueError:
        raise refuse(413, "too_big", f"That file is bigger than {limit_mb} MB. Pick a smaller one.") from None
    path = absolute_path(rel)
    try:
        if size == 0:
            raise refuse(400, "empty", "That file is empty. Pick another.")
        if used + size > cap:
            raise refuse(429, "daily_full", "This form has taken all the files it can for today. Try again tomorrow.")
        declared = (getattr(upload, "content_type", None) or "").lower() or None
        try:
            mime = await asyncio.to_thread(sniff_and_validate, path, declared_filename=name, declared_mime=declared)
        except UnsafeUploadError:
            raise refuse(
                415, "bad_type", f"That file isn't what its name says, so it can't be sent. This question takes {kinds_words(kinds)}."
            ) from None
        try:
            await asyncio.to_thread(_strip, path, mime)
        except UnsafeUploadError as exc:  # a picture too big to open safely
            raise refuse(413, "too_big", str(exc)) from None
        size = path.stat().st_size
        if not quota.can_fit(size):
            raise refuse(507, "no_room", NOT_TAKING)
    except Exception:
        delete_blob(rel)
        raise

    row = UserFile(
        id=new_id,
        user_id=shell.user_id,
        folder_id=None,
        filename=name,
        original_filename=name,
        mime_type=mime,
        size_bytes=size,
        storage_path=rel,
        source_kind=GeneratedKind.FORM_UPLOAD.value,
        source_file_id=shell.id,
    )
    await hash_into(row)
    db.add(row)
    await db.flush()
    up = FormUpload(
        id=uuid.uuid4(),
        form_id=form.id,
        question_id=question_id,
        file_id=row.id,
        draft_key_hash=hash_key(key),
    )
    db.add(up)
    await db.commit()
    image = mime.startswith("image/") and mime != "image/svg+xml"
    if image:
        # A tile for the Responses page (the media worker; never here).
        from app.tasks.queue import enqueue_media

        await enqueue_media(row.id)
    return {"id": str(up.id), "name": name, "size": size, "mime": mime, "image": image}


async def unstage(db: AsyncSession, ctx: AnswerCtx, upload_id: uuid.UUID, draft_key: Any) -> None:
    """Take back a file picked on the answer page (not yet sent). Commits."""
    from app.forms.responses import gone

    key = _draft_ok(draft_key)
    if ctx.state == "gone" or ctx.form is None or key is None:
        raise gone()
    up = await db.get(FormUpload, upload_id)
    if (
        up is None
        or up.form_id != ctx.form.id
        or up.response_id is not None
        or up.draft_key_hash != hash_key(key)
    ):
        raise gone()
    await drop(db, [up])
    await db.commit()


# --------------------------------------------------------------------
# Claiming files when the answer is sent
# --------------------------------------------------------------------
async def claim(
    db: AsyncSession,
    form: Form,
    clean: dict[str, Any],
    *,
    draft_key: Any,
    response: FormResponse | None = None,
) -> list[FormUpload]:
    """Check the file answers in ``clean`` (upload ids, from
    :func:`app.forms.answering.check_answers`) and turn each into ``[{id,
    name}]``, in place. A file must be this form's and this question's,
    and either staged by this page (its draft key) or already part of
    ``response`` (changing an answer). Returns the uploads to attach.
    Raises :class:`~app.forms.answering.AnswerError`."""
    key = _draft_ok(draft_key)
    out: list[FormUpload] = []
    for qid, value in list(clean.items()):
        item = _question(form, qid)
        if item is None or not isinstance(value, list):
            continue
        try:
            ids = [uuid.UUID(str(v)) for v in value]
        except ValueError:
            raise ans.AnswerError("A file you added isn't there any more. Add it again.", question_id=qid) from None
        rows = (
            await db.execute(
                select(FormUpload, UserFile.filename)
                .join(UserFile, UserFile.id == FormUpload.file_id)
                .where(FormUpload.id.in_(ids), FormUpload.form_id == form.id, FormUpload.question_id == qid)
            )
        ).all()
        found: dict[uuid.UUID, tuple[FormUpload, str]] = {}
        for up, name in rows:
            mine = (up.response_id is None and key is not None and up.draft_key_hash == hash_key(key)) or (
                response is not None and up.response_id == response.id
            )
            if mine:
                found[up.id] = (up, name or "file")
        if len(found) != len(ids):
            raise ans.AnswerError("A file you added isn't there any more. Add it again.", question_id=qid)
        clean[qid] = [{"id": str(i), "name": found[i][1]} for i in ids]
        out.extend(found[i][0] for i in ids)
    return out


async def attach(
    db: AsyncSession, form: Form, response: FormResponse, claimed: list[FormUpload], *, draft_key: Any
) -> None:
    """After the answer is saved: its files belong to it now; files it
    dropped (changing an answer) and files this page staged but didn't send
    are deleted."""
    keep = {u.id for u in claimed}
    for u in claimed:
        u.response_id = response.id
        u.draft_key_hash = None
    stale = list(
        (
            await db.execute(
                select(FormUpload).where(
                    FormUpload.form_id == form.id,
                    FormUpload.response_id == response.id,
                    FormUpload.id.not_in(keep) if keep else true(),
                )
            )
        ).scalars()
    )
    key = _draft_ok(draft_key)
    if key is not None:
        stale += list(
            (
                await db.execute(
                    select(FormUpload).where(
                        FormUpload.form_id == form.id,
                        FormUpload.response_id.is_(None),
                        FormUpload.draft_key_hash == hash_key(key),
                        FormUpload.id.not_in(keep) if keep else true(),
                    )
                )
            ).scalars()
        )
    await db.flush()
    await drop(db, stale)


# --------------------------------------------------------------------
# Deleting
# --------------------------------------------------------------------
async def drop(db: AsyncSession, uploads: list[FormUpload]) -> int:
    """Delete these uploads and their files (blobs tombstoned, tiles gone).
    Flushed, not committed."""
    from app.files.purge import purge_file_rows

    if not uploads:
        return 0
    file_ids = list({u.file_id for u in uploads})
    rows = list((await db.execute(select(UserFile).where(UserFile.id.in_(file_ids)))).scalars())
    await db.execute(delete(FormUpload).where(FormUpload.id.in_([u.id for u in uploads])))
    await purge_file_rows(db, rows, reason="form_upload")
    await db.flush()
    return len(uploads)


async def drop_for_response(db: AsyncSession, response_id: uuid.UUID) -> int:
    rows = list((await db.execute(select(FormUpload).where(FormUpload.response_id == response_id))).scalars())
    return await drop(db, rows)


async def drop_for_form(db: AsyncSession, form_id: uuid.UUID, *, sent_only: bool = True) -> int:
    q = select(FormUpload).where(FormUpload.form_id == form_id)
    if sent_only:
        q = q.where(FormUpload.response_id.is_not(None))
    return await drop(db, list((await db.execute(q)).scalars()))


async def sweep(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Delete files staged more than a day ago and never sent (and any left
    without an answer). Commits."""
    cutoff = (now or datetime.now(timezone.utc)) - STAGED_TTL
    rows = list(
        (
            await db.execute(
                select(FormUpload)
                .where(FormUpload.response_id.is_(None), FormUpload.created_at < cutoff)
                .limit(2000)
            )
        ).scalars()
    )
    n = await drop(db, rows)
    await db.commit()
    return n


# --------------------------------------------------------------------
# Showing them (Responses)
# --------------------------------------------------------------------
def _ver(row: UserFile) -> int:
    from app.files import media_urls

    return media_urls.version_tag(row.storage_path, row.size_bytes)


async def file_cards(
    db: AsyncSession, form: Form, user: User, upload_ids: list[str], *, outside: set[str] | None = None
) -> dict[str, dict[str, Any]]:
    """``{upload id: {id, name, size, mime, image, thumb, url}}`` for files
    in answers ``user`` may see: signed links for a few hours (``url``
    downloads; ``thumb`` is a picture's tile once it's made)."""
    from app.files import media_urls
    from app.files.models import FileMedia

    ids = []
    for u in upload_ids:
        try:
            ids.append(uuid.UUID(str(u)))
        except ValueError:
            continue
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(FormUpload, UserFile)
            .join(UserFile, UserFile.id == FormUpload.file_id)
            .where(FormUpload.id.in_(ids), FormUpload.form_id == form.id, FormUpload.response_id.is_not(None))
        )
    ).all()
    media = {
        m.file_id: m
        for m in (
            await db.execute(select(FileMedia).where(FileMedia.file_id.in_([f.id for _u, f in rows])))
        ).scalars()
    }
    out: dict[str, dict[str, Any]] = {}
    for up, f in rows:
        mime = (f.mime_type or "").lower()
        image = mime.startswith("image/") and mime != "image/svg+xml"
        thumb = None
        m = media.get(f.id)
        if image and m is not None and m.derivative_state == "ready":
            info = (m.renditions or {}).get("thumb.webp")
            if info:
                thumb = media_urls.sign(
                    f.id, user.id, user.token_version, "form_thumb", media_urls.rendition_tag("thumb.webp", info)
                )
        out[str(up.id)] = {
            "id": str(up.id),
            "name": f.filename,
            "size": int(f.size_bytes or 0),
            "mime": mime,
            "image": image,
            "thumb": thumb,
            "url": media_urls.sign(f.id, user.id, user.token_version, "form_upload", _ver(f)),
        }
    return out


def ids_in(value: Any) -> list[str]:
    """Upload ids in a stored file answer (``[{id, name}]``)."""
    if not isinstance(value, list):
        return []
    return [str(v.get("id")) for v in value if isinstance(v, dict) and v.get("id")]


async def strip_for(db: AsyncSession, form: Form, user: User, question_id: str) -> list[dict[str, Any]]:
    """The newest files sent to one question, for the summary's strip."""
    rows = (
        await db.execute(
            select(FormUpload.id, FormResponse.number, FormResponse.source)
            .join(FormResponse, FormResponse.id == FormUpload.response_id)
            .where(
                FormUpload.form_id == form.id,
                FormUpload.question_id == question_id,
                FormResponse.deleted_at.is_(None),
            )
            .order_by(FormResponse.number.desc(), FormUpload.created_at)
            .limit(STRIP)
        )
    ).all()
    cards = await file_cards(db, form, user, [str(r[0]) for r in rows])
    out = []
    for uid, number, source in rows:
        c = cards.get(str(uid))
        if c is not None:
            out.append({**c, "number": number, "outside": source == "link"})
    return out


# --------------------------------------------------------------------
# Export my library (WP-F1.7)
# --------------------------------------------------------------------
_UNSAFE = set('\\/:*?"<>|\r\n\t')


async def export_entries(db: AsyncSession, shell: UserFile) -> list[tuple[str, str, int, int]]:
    """``(name, storage path, size, mtime)`` for every file sent with a
    live answer to this form, named ``Response <n>/<file name>``."""
    from app.forms.access import form_for_shell

    form = await form_for_shell(db, shell)
    if form is None:
        return []
    rows = (
        await db.execute(
            select(FormResponse.number, UserFile.filename, UserFile.storage_path, UserFile.size_bytes, UserFile.created_at)
            .select_from(FormUpload)
            .join(FormResponse, FormResponse.id == FormUpload.response_id)
            .join(UserFile, UserFile.id == FormUpload.file_id)
            .where(FormUpload.form_id == form.id, FormResponse.deleted_at.is_(None), UserFile.storage_path.is_not(None))
            .order_by(FormResponse.number, FormUpload.created_at)
        )
    ).all()
    out = []
    for number, name, path, size, created in rows:
        safe = "".join("_" if ch in _UNSAFE else ch for ch in (name or "file"))[:150] or "file"
        out.append((f"Response {number}/{safe}", path, int(size or 0), int(created.timestamp()) if created else 0))
    return out


# --------------------------------------------------------------------
# Serving (``/m/`` claims ``form_upload`` and ``form_thumb``)
# --------------------------------------------------------------------
async def readable(db: AsyncSession, file_id: uuid.UUID, user: User) -> UserFile | None:
    """A respondent's file ``user`` may open now: sent with an answer that's
    still there, on a form that isn't in the trash and that ``user`` can
    see the answers of."""
    from app.forms.access import form_access

    row = await db.get(UserFile, file_id)
    if row is None or row.source_kind != GeneratedKind.FORM_UPLOAD.value or row.source_file_id is None:
        return None
    shell = await db.get(UserFile, row.source_file_id)
    if shell is None or shell.trashed_at is not None:
        return None
    sent = await db.scalar(
        select(func.count())
        .select_from(FormUpload)
        .join(FormResponse, FormResponse.id == FormUpload.response_id)
        .where(FormUpload.file_id == row.id, FormResponse.deleted_at.is_(None))
    )
    if not sent:
        return None
    if await form_access(db, shell, user) == "none":
        return None
    return row


async def serve(db: AsyncSession, claim: Any, user: User, request: Any) -> Any:
    """The bytes behind a ``form_upload`` / ``form_thumb`` link: the file
    always as a download, in a sandbox, never sniffed."""
    import urllib.parse

    from fastapi import HTTPException
    from fastapi.responses import FileResponse, Response

    from app.files import media_urls, storage
    from app.files.derivatives import rendition_path
    from app.files.router import _content_disposition, _safe_download_mime

    def missing() -> HTTPException:
        return HTTPException(status_code=404, detail="Link expired or not found")

    row = await readable(db, claim.file_id, user)
    if row is None or not row.storage_path:
        raise missing()
    left = max(claim.exp - int(datetime.now(timezone.utc).timestamp()), 0)
    headers = {
        "Cache-Control": f"private, max-age={left}, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    if claim.rendition == "form_thumb":
        path = rendition_path(row.id, media_urls.RENDITION_FILE["thumb"])
        media_type = "image/webp"
    else:
        path = storage.absolute_path(row.storage_path)
        media_type = _safe_download_mime(row.mime_type, row.filename)
        headers["Content-Disposition"] = _content_disposition(row.filename)
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    if not path.is_file():
        raise missing()
    if request.headers.get("x-promptly-accel") == "1":
        if claim.rendition == "form_thumb":
            rel = path.resolve().relative_to((storage.UPLOAD_ROOT / "derived").resolve()).as_posix()
            target = "/_renditions/" + rel
        else:
            rel = path.resolve().relative_to(storage.UPLOAD_ROOT.resolve()).as_posix()
            target = "/_blobs/" + rel
        headers["X-Accel-Redirect"] = urllib.parse.quote(target, safe="/")
        return Response(status_code=200, media_type=media_type, headers=headers)
    return FileResponse(path=str(path), media_type=media_type, headers=headers)


__all__ = [
    "DEFAULT_DAILY_MB",
    "DEFAULT_LINK_DAILY_MB",
    "GROUP_EXTS",
    "accept_attr",
    "allowed_exts",
    "attach",
    "claim",
    "daily_cap",
    "drop",
    "drop_for_form",
    "drop_for_response",
    "export_entries",
    "file_cards",
    "ids_in",
    "mode_for",
    "page_rules",
    "readable",
    "serve",
    "stage",
    "strip_for",
    "sweep",
    "unstage",
    "used_today",
]
