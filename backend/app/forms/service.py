"""Forms: making, saving, copying and exporting forms (the owner side).

A form is an office shell (``app.files.office``): a ``files`` row with no
blob — ``<title>.form``, ``size_bytes`` = definition + answers (so quota
counts it), ``content_text`` = the questions' words, never answers — plus
its :class:`~app.forms.models.Form`. Nothing here commits; routes do.

Images in a form (the header, a question's or an option's picture) are
hidden ``form_asset`` file rows owned by the form's owner and tied to the
form by ``source_file_id``. The builder shows them through short-lived
signed links (:func:`asset_url`); the answer page will serve them only
through the form's own link.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import shutil
import time
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import Text, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.files.generated_kinds import GeneratedKind
from app.files.models import FileShareLink, UserFile
from app.forms import definition as fdef
from app.forms.models import Form, FormResponse

if TYPE_CHECKING:
    from app.auth.models import User

FORM_MIME = "application/vnd.promptly.form+json"
ASSET_MAX_BYTES = 10 * 1024 * 1024
ASSET_TTL_SECONDS = 6 * 3600

# The settings a person can change (``PATCH /api/forms/{id}/settings``)
# and a template or a copy carries over.
SETTING_FIELDS = (
    "audience",
    "accepting",
    "close_at",
    "max_responses",
    "one_per_person",
    "allow_edit",
    "collect_email",
    "show_remaining",
    "allow_uploads_from_link",
    "confirmation",
    "closed_message",
    "allow_another",
    # A quiz's settings (WP-F2.3; null = not a quiz).
    "quiz",
)


# --------------------------------------------------------------------
# The shell
# --------------------------------------------------------------------
async def answers_bytes(db: AsyncSession, form_id: uuid.UUID) -> int:
    # The answers' text length, not pg_column_size: that's after compression,
    # and quota should count what the answers really are.
    total = await db.scalar(
        select(func.coalesce(func.sum(func.octet_length(cast(FormResponse.answers, Text))), 0)).where(
            FormResponse.form_id == form_id
        )
    )
    return int(total or 0)


async def refresh_shell(db: AsyncSession, form: Form, shell: UserFile, *, rename: bool = True) -> None:
    """Keep the shell in step with the form: its name (the title), its
    search text (the questions, never answers) and its size (definition +
    answers, which quota counts)."""
    from app.files.office import shell_filename

    defn = form.definition or {}
    if rename:
        name = shell_filename(GeneratedKind.FORM.value, defn.get("title") or "Untitled form")
        if shell.filename != name:
            shell.filename = shell.original_filename = name
    shell.content_text = fdef.search_text(defn) or None
    shell.size_bytes = fdef.json_size(defn) + await answers_bytes(db, form.id)


async def create_form(
    db: AsyncSession,
    *,
    owner: User,
    title: str | None = None,
    folder_id: uuid.UUID | None = None,
    definition: dict[str, Any] | None = None,
    settings: dict[str, Any] | None = None,
    accepting: bool = True,
) -> tuple[UserFile, Form]:
    """A new form in ``owner``'s ``folder_id``: blank, or with
    ``definition`` (already validated) and ``settings``. A form made by a
    person takes answers as soon as it has a link; a draft the AI makes
    doesn't (``accepting=False``). Flushed, not committed."""
    from app.files.office import make_shell

    defn = dict(definition) if definition is not None else fdef.blank()
    if title is not None and title.strip():
        defn["title"] = title.strip()[:300]
    defn = fdef.validate_definition(defn)
    form = Form(id=uuid.uuid4(), definition=defn, data_version=1, accepting=accepting)
    for k, v in (settings or {}).items():
        if k in SETTING_FIELDS and k != "accepting":
            setattr(form, k, v)
    shell = make_shell(
        kind=GeneratedKind.FORM.value, owner_id=owner.id, folder_id=folder_id, title=defn["title"], entity=form
    )
    db.add(shell)
    await db.flush()
    form.file_id = shell.id
    db.add(form)
    await db.flush()
    await refresh_shell(db, form, shell)
    await db.flush()
    return shell, form


async def from_template(
    db: AsyncSession, *, owner: User, key: str, title: str | None = None, folder_id: uuid.UUID | None = None
) -> tuple[UserFile, Form] | None:
    from app.forms.templates import built_in

    t = built_in(key)
    if t is None:
        return None
    defn, settings = t
    return await create_form(db, owner=owner, title=title, folder_id=folder_id, definition=defn, settings=settings)


# --------------------------------------------------------------------
# Saving
# --------------------------------------------------------------------
class StaleDefinition(Exception):
    def __init__(self, form: Form) -> None:
        super().__init__("stale")
        self.form = form


async def answered_ids(db: AsyncSession, form_id: uuid.UUID) -> set[str]:
    """Question ids that have at least one answer (kept, even when trashed)."""
    rows = await db.execute(
        select(func.jsonb_object_keys(FormResponse.answers)).where(FormResponse.form_id == form_id).distinct()
    )
    return {str(r[0]) for r in rows}


async def save_definition(
    db: AsyncSession, shell: UserFile, form: Form, raw: Any, *, data_version: int
) -> Form:
    """Save the builder's definition. ``form`` must be locked (``FOR
    UPDATE``). Raises :class:`StaleDefinition` when someone saved since
    ``data_version`` and :class:`~app.forms.definition.DefinitionError` when
    it breaks a rule. Answered questions the save left out come back,
    marked deleted."""
    if data_version != form.data_version:
        raise StaleDefinition(form)
    if not isinstance(raw, dict):
        raise fdef.DefinitionError("A form's definition must be an object.")
    raw = fdef.keep_answered(raw, form.definition or {}, await answered_ids(db, form.id))
    defn = fdef.validate_definition(raw)
    await _check_assets(db, shell, defn)
    form.definition = defn
    form.data_version = (form.data_version or 0) + 1
    form.updated_at = datetime.now(timezone.utc)
    await refresh_shell(db, form, shell)
    return form


async def _check_assets(db: AsyncSession, shell: UserFile, defn: dict[str, Any]) -> None:
    """Every image the definition names must be one of this form's own."""
    wanted = fdef.asset_ids(defn)
    if not wanted:
        return
    try:
        ids = [uuid.UUID(a) for a in wanted]
    except ValueError:
        raise fdef.DefinitionError("A picture in this form isn't one of its own.") from None
    found = set(
        (
            await db.execute(
                select(UserFile.id).where(
                    UserFile.id.in_(ids),
                    UserFile.source_kind == GeneratedKind.FORM_ASSET.value,
                    UserFile.source_file_id == shell.id,
                )
            )
        ).scalars()
    )
    if len(found) != len(ids):
        raise fdef.DefinitionError("A picture in this form isn't one of its own. Add it again.")


class SettingsError(ValueError):
    pass


async def apply_settings(db: AsyncSession, form: Form, changes: dict[str, Any]) -> Form:
    """Apply validated setting changes (the route's model checked types and
    lengths); the rules that need the database are checked here."""
    from app.forms.access import link_answers_allowed

    if changes.get("audience") == "link" and form.audience != "link" and not await link_answers_allowed(db):
        raise SettingsError(
            "Your server's admin has turned off answers from people without an account."
        )
    if "quiz" in changes or "allow_edit" in changes:
        changes = _quiz_rules(form, dict(changes))
    for k, v in changes.items():
        if k in SETTING_FIELDS:
            setattr(form, k, v)
    form.updated_at = datetime.now(timezone.utc)
    # Open again: closing by itself later tells the owner again (WP-F1.4).
    from app.forms.notify import reopened

    reopened(form)
    if "audience" in changes:
        # The link's mode follows who can answer (Shared links shows it).
        shell = await db.get(UserFile, form.file_id)
        link = await live_link(db, shell) if shell is not None else None
        if link is not None:
            link.access_mode = _link_mode(form)
    return form


def _quiz_rules(form: Form, changes: dict[str, Any]) -> dict[str, Any]:
    """Quiz settings (WP-F2.3). Showing the correct answers turns "Let
    people change their answer" off (changing an answer afterwards would
    just copy the key); turning it off again, or the quiz off, puts that
    switch back the way it was (kept as ``edit_before``)."""
    from app.forms.quiz import QuizSettings

    before = form.quiz if isinstance(form.quiz, dict) else None
    showing_before = bool(before and before.get("show_answers"))
    if "quiz" in changes:
        raw = changes["quiz"]
        if raw is None:
            new = None
        else:
            try:
                new = QuizSettings.model_validate({k: v for k, v in raw.items() if k != "edit_before"}).model_dump()
            except Exception:  # noqa: BLE001 — pydantic's message isn't one to show
                raise SettingsError("Those quiz settings can't be used.") from None
        showing = bool(new and new.get("show_answers"))
        if showing and not showing_before:
            new["edit_before"] = bool(changes.get("allow_edit", form.allow_edit))
            changes["allow_edit"] = False
        elif showing and before:
            new["edit_before"] = bool(before.get("edit_before", False))
        elif showing_before and not showing:
            changes["allow_edit"] = bool(before.get("edit_before", form.allow_edit))
        changes["quiz"] = new
    elif changes.get("allow_edit") and showing_before:
        raise SettingsError(
            "People see the correct answers after sending, so they can't change their answer. "
            "Turn off “The correct answers” in Quiz first."
        )
    return changes


# --------------------------------------------------------------------
# The answer link (WP-F1.3)
# --------------------------------------------------------------------
def _link_mode(form: Form) -> str:
    # ``file_share_links.access_mode``: invite = people on this server,
    # public = anyone with the link. The form's own ``audience`` is what
    # the answer side checks; this keeps the two in step.
    return "public" if form.audience == "link" else "invite"


async def make_link(db: AsyncSession, shell: UserFile, form: Form, *, by: User, reset: bool = False) -> FileShareLink:
    """The form's answer link: the live one, or a new one. ``reset`` turns
    the old one off first, so it stops working at once. It's a
    ``FileShareLink`` with ``resource_type="form"``: nothing that serves
    files reads it, and opening it never grants access to the form.
    Flushed, not committed."""
    import secrets

    current = await live_link(db, shell)
    if current is not None and not reset:
        return current
    now = datetime.now(timezone.utc)
    if current is not None:
        await turn_off_links(db, shell, now=now)
    link = FileShareLink(
        resource_type="form",
        resource_id=shell.id,
        created_by=by.id,
        token=secrets.token_urlsafe(32),
        access_mode=_link_mode(form),
        role="view",
    )
    db.add(link)
    await db.flush()
    return link


async def turn_off_links(db: AsyncSession, shell: UserFile, *, now: datetime | None = None) -> int:
    """Turn off every live answer link of ``shell``'s form."""
    now = now or datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(FileShareLink).where(
                FileShareLink.resource_type == "form",
                FileShareLink.resource_id == shell.id,
                FileShareLink.revoked_at.is_(None),
            )
        )
    ).scalars().all()
    for link in rows:
        link.revoked_at = now
    await db.flush()
    return len(rows)


# --------------------------------------------------------------------
# Copies and templates
# --------------------------------------------------------------------
async def copy_assets(db: AsyncSession, src_shell: UserFile, new_shell: UserFile) -> dict[str, str]:
    """Copy ``src_shell``'s images under ``new_shell`` (rows and blobs) —
    a copy never points at the original's pictures. Old id → new id."""
    from app.files.storage import absolute_path, storage_path_for

    rows = (
        await db.execute(
            select(UserFile).where(
                UserFile.source_file_id == src_shell.id,
                UserFile.source_kind == GeneratedKind.FORM_ASSET.value,
            )
        )
    ).scalars().all()
    mapping: dict[str, str] = {}
    for a in rows:
        src_path = absolute_path(a.storage_path)
        if not src_path.exists():
            continue
        new_id = uuid.uuid4()
        rel = storage_path_for(new_shell.user_id, new_id, os.path.splitext(a.filename or "")[1].lower())
        dest = absolute_path(rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, src_path, dest)
        db.add(
            UserFile(
                id=new_id,
                user_id=new_shell.user_id,
                folder_id=None,
                filename=a.filename,
                original_filename=a.filename,
                mime_type=a.mime_type,
                size_bytes=a.size_bytes,
                storage_path=rel,
                source_kind=GeneratedKind.FORM_ASSET.value,
                source_file_id=new_shell.id,
                content_sha256=a.content_sha256,
                sha1=a.sha1,
                md5=a.md5,
                verified_at=a.verified_at,
            )
        )
        mapping[str(a.id).lower()] = str(new_id)
    await db.flush()
    return mapping


async def copy_form(
    db: AsyncSession, src_shell: UserFile, *, owner: User, folder_id: uuid.UUID | None, title: str
) -> UserFile:
    """Make a copy / Save as template / New from your template: the
    questions, theme and settings — never the answers, the link, the
    linked Sheet or the linked event. The copy takes answers once it has a
    link, like any new form. Flushed, not committed."""
    from app.forms.access import form_for_shell

    src = await form_for_shell(db, src_shell)
    if src is None:
        raise ValueError("not a form")
    settings = {k: getattr(src, k) for k in SETTING_FIELDS if k != "accepting"}
    # Draft definition first (no pictures), then its own copies of them.
    defn = fdef.remap_assets(src.definition or {}, {})
    shell, form = await create_form(
        db, owner=owner, folder_id=folder_id, definition=defn, settings=settings, title=title
    )
    mapping = await copy_assets(db, src_shell, shell)
    if mapping:
        d = fdef.remap_assets(src.definition or {}, mapping)
        d["title"] = form.definition.get("title")
        form.definition = fdef.validate_definition(d)
        await refresh_shell(db, form, shell)
    await db.flush()
    return shell


# --------------------------------------------------------------------
# Images
# --------------------------------------------------------------------
def _asset_sig(form_file_id: uuid.UUID, asset_id: uuid.UUID, exp: int) -> str:
    key = get_settings().SECRET_KEY.encode("utf-8")
    msg = f"form-asset:v1:{form_file_id}:{asset_id}:{exp}".encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def asset_url(form_file_id: uuid.UUID, asset_id: uuid.UUID | str) -> str:
    """A link to one of a form's images that works for a few hours
    (rounded to the hour, so it stays browser-cached)."""
    aid = uuid.UUID(str(asset_id))
    exp = (int(time.time()) // 3600 + 1) * 3600 + ASSET_TTL_SECONDS
    return f"/api/forms/{form_file_id}/assets/{aid}?exp={exp}&sig={_asset_sig(form_file_id, aid, exp)}"


def verify_asset(form_file_id: uuid.UUID, asset_id: uuid.UUID, exp: int, sig: str) -> bool:
    if exp < time.time():
        return False
    return hmac.compare_digest(_asset_sig(form_file_id, asset_id, exp), sig or "")


def asset_urls(shell: UserFile, defn: dict[str, Any]) -> dict[str, str]:
    return {a: asset_url(shell.id, a) for a in sorted(fdef.asset_ids(defn))}


class AssetError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


async def add_asset(db: AsyncSession, shell: UserFile, upload: Any) -> UserFile:
    """Store an uploaded picture for ``shell``'s form: sniffed and checked
    (images only), converted to JPEG when browsers can't show it, its
    metadata stripped (a form's pictures are public through its link), and
    counted against the form owner's storage. Flushed, not committed."""
    from app.auth.models import User
    from app.files import egress
    from app.files.blobstore import hash_into
    from app.files.imaging import BROWSER_IMAGE_MIMES, to_jpeg_in_place
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
        copy_stream_to_disk_async,
        delete_blob,
        ensure_bucket,
        storage_path_for,
    )

    try:
        clean = sanitize_filename(getattr(upload, "filename", None) or "image")
    except UnsafeUploadError as exc:
        raise AssetError(str(exc)) from None
    declared = (getattr(upload, "content_type", None) or "").lower()
    if not declared.startswith("image/"):
        raise AssetError("Only pictures can go in a form.")
    owner = await db.get(User, shell.user_id) if shell.user_id else None
    if owner is None:
        raise AssetError("This form has no owner.", status_code=404)
    quota = await get_quota(db, owner)
    if not quota.can_fit(1):
        raise AssetError("There's no storage space left for pictures.", status_code=413)

    new_id = uuid.uuid4()
    ext = os.path.splitext(clean)[1].lower()
    rel = storage_path_for(shell.user_id, new_id, ext)
    ensure_bucket(shell.user_id)
    try:
        size = await copy_stream_to_disk_async(upload.file, rel, size_limit=min(ASSET_MAX_BYTES, MAX_FILE_BYTES))
    except ValueError:
        raise AssetError(
            f"That picture is too big (at most {ASSET_MAX_BYTES // (1024 * 1024)} MB).", status_code=413
        ) from None
    if size == 0:
        delete_blob(rel)
        raise AssetError("That picture was empty.")
    path = absolute_path(rel)
    try:
        mime = await asyncio.to_thread(sniff_and_validate, path, declared_filename=clean, declared_mime=declared)
    except UnsafeUploadError as exc:
        delete_blob(rel)
        raise AssetError(str(exc)) from None
    if not mime.startswith("image/") or mime == "image/svg+xml":
        delete_blob(rel)
        raise AssetError("Only pictures (JPEG, PNG, WebP, GIF, HEIC) can go in a form.")
    if mime not in BROWSER_IMAGE_MIMES:
        try:
            await asyncio.to_thread(to_jpeg_in_place, path)
        except Exception:  # noqa: BLE001 — Pillow raises broadly on odd files
            delete_blob(rel)
            raise AssetError("That picture can't be used. Save it as a JPEG or PNG first.") from None
        mime = "image/jpeg"
        clean = os.path.splitext(clean)[0] + ".jpg"
    try:
        if not (mime in egress.STRIPPABLE_MIMES and await asyncio.to_thread(egress.strip_in_place, path)):
            await asyncio.to_thread(strip_image_metadata_in_place, path, mime)
    except UnsafeUploadError as exc:
        delete_blob(rel)
        raise AssetError(str(exc)) from None
    except Exception:
        delete_blob(rel)
        raise
    size = path.stat().st_size
    if not quota.can_fit(size):
        delete_blob(rel)
        raise AssetError("There's no storage space left for this picture.", status_code=413)
    row = UserFile(
        id=new_id,
        user_id=shell.user_id,
        folder_id=None,
        filename=clean,
        original_filename=clean,
        mime_type=mime,
        size_bytes=size,
        storage_path=rel,
        source_kind=GeneratedKind.FORM_ASSET.value,
        source_file_id=shell.id,
    )
    await hash_into(row)
    db.add(row)
    await db.flush()
    return row


async def asset_row(db: AsyncSession, shell_id: uuid.UUID, asset_id: uuid.UUID) -> UserFile | None:
    row = await db.get(UserFile, asset_id)
    if row is None or row.source_kind != GeneratedKind.FORM_ASSET.value or row.source_file_id != shell_id:
        return None
    return row


# --------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------
def settings_of(form: Form) -> dict[str, Any]:
    out = {k: getattr(form, k) for k in SETTING_FIELDS}
    out["close_at"] = form.close_at.isoformat() if form.close_at else None
    return out


def state_of(shell: UserFile, form: Form) -> str:
    from app.forms.access import is_closed

    if shell.trashed_at is not None:
        return "trashed"
    return "closed" if is_closed(form) else "open"


async def live_link(db: AsyncSession, shell: UserFile) -> FileShareLink | None:
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(FileShareLink)
            .where(
                FileShareLink.resource_type == "form",
                FileShareLink.resource_id == shell.id,
                FileShareLink.revoked_at.is_(None),
            )
            .order_by(FileShareLink.created_at.desc())
        )
    ).scalars().all()
    for link in rows:
        if link.expires_at is None or link.expires_at > now:
            return link
    return None


def form_view(shell: UserFile, form: Form) -> dict[str, Any]:
    return {
        "id": str(form.id),
        "file_id": str(shell.id),
        "definition": form.definition,
        "data_version": form.data_version,
        "settings": settings_of(form),
        "state": state_of(shell, form),
        "response_count": form.response_count or 0,
        "last_response_at": form.last_response_at.isoformat() if form.last_response_at else None,
        "event_id": str(form.event_id) if form.event_id else None,
        "sheet_file_id": str(form.sheet_file_id) if form.sheet_file_id else None,
        "created_at": form.created_at.isoformat() if form.created_at else None,
        "updated_at": form.updated_at.isoformat() if form.updated_at else None,
    }


LIMITS = {
    "max_items": fdef.MAX_ITEMS,
    "max_sections": fdef.MAX_SECTIONS,
    "max_options": fdef.MAX_OPTIONS,
    "max_json_bytes": fdef.MAX_JSON_BYTES,
    "max_asset_bytes": ASSET_MAX_BYTES,
}


# --------------------------------------------------------------------
# Download
# --------------------------------------------------------------------
async def export_zip(db: AsyncSession, shell: UserFile, form: Form) -> tuple[bytes, str, str]:
    """(zip bytes, filename, MIME): ``form.json`` + ``responses.csv``."""
    from app.auth.models import User
    from app.forms.export import form_zip

    responses = (
        await db.execute(
            select(FormResponse)
            .where(FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))
            .order_by(FormResponse.number)
        )
    ).scalars().all()
    ids = {r.respondent_id for r in responses if r.respondent_id}
    who: dict[Any, str] = {}
    if ids:
        for uid, username in (await db.execute(select(User.id, User.username).where(User.id.in_(ids)))).all():
            who[uid] = username
    data = await asyncio.to_thread(form_zip, form.definition or {}, responses, who=who)
    base = (shell.filename or "Untitled form").rsplit(".", 1)[0] or "Untitled form"
    return data, f"{base}.form.zip", "application/zip"


# --------------------------------------------------------------------
# Permanent delete
# --------------------------------------------------------------------
async def purge_forms(db: AsyncSession, shell_ids: list[uuid.UUID]) -> list[UserFile]:
    """Before form shells are deleted for good: delete their forms (the
    answers, counters and staged uploads go with them) and return their
    images and respondents' files, which go with the shells."""
    from sqlalchemy import delete

    if not shell_ids:
        return []
    await db.execute(delete(Form).where(Form.file_id.in_(shell_ids)))
    # Their answer links go too (Shared links would list them as deleted).
    await db.execute(
        delete(FileShareLink).where(FileShareLink.resource_type == "form", FileShareLink.resource_id.in_(shell_ids))
    )
    return list(
        (
            await db.execute(
                select(UserFile).where(
                    UserFile.source_file_id.in_(shell_ids),
                    UserFile.source_kind.in_(
                        [GeneratedKind.FORM_ASSET.value, GeneratedKind.FORM_UPLOAD.value]
                    ),
                )
            )
        ).scalars()
    )


__all__ = [
    "ASSET_MAX_BYTES",
    "FORM_MIME",
    "LIMITS",
    "SETTING_FIELDS",
    "AssetError",
    "SettingsError",
    "StaleDefinition",
    "add_asset",
    "apply_settings",
    "asset_row",
    "asset_url",
    "asset_urls",
    "copy_form",
    "create_form",
    "export_zip",
    "form_view",
    "from_template",
    "live_link",
    "make_link",
    "purge_forms",
    "turn_off_links",
    "refresh_shell",
    "save_definition",
    "settings_of",
    "verify_asset",
]
