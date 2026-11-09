"""Items — create, read, save, act (the one write path).

Every change to an item file goes through :func:`save_data`: validated by
the kind's model, refused when it's from an older revision (the client gets
the newer state and replays its change), sized against the kind's limit and
the owner's quota, then the shell's size and search text, the reminders and
a throttled version are brought up to date.
"""
from __future__ import annotations

import inspect
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.files.models import FileVersion, UserFile
from app.items.models import ItemDocument, ItemInstall, ItemReminder, ItemState
from app.items.registry import all_specs, get_spec
from app.items.spec import REMINDER_HORIZON, ActionError, ActionOutcome, ItemContext, ItemSpec

logger = logging.getLogger("promptly.items.service")

ITEM_KIND = "item"
ITEM_MIME = "application/vnd.promptly.item+json"
MAX_TEXT_CHARS = 200_000
# A save keeps the state it replaces as a version at most this often (the
# AI's changes always keep one — that's its Undo).
VERSION_EVERY = timedelta(minutes=10)


class ItemError(Exception):
    """Refused, with a message for the person (→ 400)."""


class ItemNotFound(Exception):
    """→ 404 (also for "not yours": existence isn't probeable)."""


@dataclass
class ItemExists(Exception):
    """One app = one file: this person already has it (the archive files an
    app splits off don't count)."""

    row: UserFile
    doc: ItemDocument


ARCHIVE_KEY = "archive"


@dataclass
class Conflict(Exception):
    """A save from an older revision (→ 409 with the current state)."""

    doc: ItemDocument


# ------------------------------------------------------------------ context


def zone_for(user: User) -> ZoneInfo:
    name = ((getattr(user, "settings", None) or {}).get("timezone") or "").strip()
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except Exception:  # noqa: BLE001 — a bad zone name falls back to UTC
        return ZoneInfo("UTC")


def make_context(db: AsyncSession, user: User, file_id: uuid.UUID | None, spec: ItemSpec | None = None) -> ItemContext:
    tz = zone_for(user)

    async def read_item(kind: str):
        if spec is None or kind not in spec.reads:
            return None
        return await latest_of_kind(db, user, kind)

    return ItemContext(db=db, user=user, file_id=file_id, now=datetime.now(tz), tz=tz, read_item=read_item)


async def latest_of_kind(db: AsyncSession, user: User, kind: str) -> tuple[uuid.UUID, str, dict] | None:
    """This person's most recently changed (own, live) file of ``kind``."""
    row = (
        await db.execute(
            select(UserFile, ItemDocument)
            .join(ItemDocument, ItemDocument.file_id == UserFile.id)
            .where(
                UserFile.user_id == user.id,
                UserFile.trashed_at.is_(None),
                ItemDocument.kind == kind,
            )
            .order_by(UserFile.modified_at.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    f, doc = row
    return f.id, title_of(f), doc.data


# --------------------------------------------------------------------- names


def title_of(row: UserFile) -> str:
    name = row.filename or "Untitled"
    spec = get_spec(kind_from_row(row))
    if spec and name.lower().endswith(spec.suffix.lower()):
        name = name[: -len(spec.suffix)]
    elif "." in name:
        name = name.rsplit(".", 1)[0]
    return name or "Untitled"


def kind_from_row(row: UserFile) -> str | None:
    from app.items.registry import kind_for_filename

    return kind_for_filename(row.filename)


def filename_for(spec: ItemSpec, title: str) -> str:
    from app.files.safety import sanitize_filename

    clean = (title or "").strip()[:200] or spec.name
    try:
        return sanitize_filename(f"{clean}{spec.suffix}")
    except Exception:  # noqa: BLE001 — an odd title still gets a name
        return f"{spec.name}{spec.suffix}"


# -------------------------------------------------------------------- store


async def installed_kinds(db: AsyncSession, user: User) -> set[str]:
    rows = (await db.execute(select(ItemInstall.kind).where(ItemInstall.user_id == user.id))).scalars().all()
    return set(rows)


async def disabled_kinds(db: AsyncSession) -> set[str]:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    return set(getattr(row, "disabled_items", None) or [])


async def available_specs(db: AsyncSession) -> dict[str, ItemSpec]:
    off = await disabled_kinds(db)
    return {k: s for k, s in all_specs().items() if not s.hidden and k not in off}


async def ensure_apps_layout(db: AsyncSession, user: User) -> None:
    """The Apps folder exists, and — once per person — app files made before
    it existed move into ``Apps/<App>``. (Run once so a file someone later
    moves elsewhere on purpose stays where they put it.) Flushed."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.files.system_folders import app_folder, ensure_apps_root

    await ensure_apps_root(db, user)
    u = await db.get(User, user.id)
    settings = dict(u.settings or {})
    if settings.get("apps_layout") == 2:
        return
    first = settings.get("apps_layout") != 1
    seen: dict[str, UserFile] = {}
    for row, doc in await list_items(db, user, limit=5000, archives=False):
        spec = get_spec(doc.kind)
        if spec is None or spec.hidden:
            continue
        target = await app_folder(db, user, spec.name)
        if doc.kind in seen:
            # One app = one file. An extra copy that was never touched goes
            # to the trash; one with data becomes an archive (never deleted).
            if doc.revision <= 1:
                row.trashed_at = datetime.now(timezone.utc)
            else:
                await set_state(db, row.id, ARCHIVE_KEY, {"of": str(seen[doc.kind].id), "before": None})
            continue
        # Newest first, so the most recently used copy stays the app's file.
        seen[doc.kind] = row
        if first and row.folder_id != target.id:
            row.folder_id = target.id
    settings["apps_layout"] = 2
    u.settings = settings
    flag_modified(u, "settings")
    await db.flush()


async def install(db: AsyncSession, user: User, kind: str) -> None:
    if kind not in await available_specs(db) and not (get_spec(kind) and get_spec(kind).hidden):
        raise ItemNotFound()
    if get_spec(kind) is None:
        raise ItemNotFound()
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    # Idempotent: two "Get"s / launches at once mustn't collide.
    await db.execute(
        pg_insert(ItemInstall).values(user_id=user.id, kind=kind).on_conflict_do_nothing()
    )


# Apps every new account starts with (they can still remove them).
DEFAULT_KINDS = ("tasks",)


async def install_defaults(db: AsyncSession, user: User) -> None:
    """Add the default apps for a new account; the caller commits."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    for kind in DEFAULT_KINDS:
        if get_spec(kind) is not None:
            await db.execute(pg_insert(ItemInstall).values(user_id=user.id, kind=kind).on_conflict_do_nothing())


async def uninstall(db: AsyncSession, user: User, kind: str) -> None:
    """Removes it from New menus. The person's files stay where they are."""
    await db.execute(delete(ItemInstall).where(ItemInstall.user_id == user.id, ItemInstall.kind == kind))


# ------------------------------------------------------------------- create


def _serialised(data: dict) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def text_for(spec: ItemSpec, title: str, data: dict, user: User | None = None) -> str:
    """The file's search / chat text. ``spec.text_now()`` inside ``to_text``
    is "now" in ``user``'s time zone."""
    from app.items.spec import _TEXT_NOW

    token = _TEXT_NOW.set(datetime.now(zone_for(user)) if user is not None else None)
    try:
        body = spec.to_text(data) or ""
    except Exception:  # noqa: BLE001 — a to_text bug mustn't block saves
        logger.exception("to_text failed for %s", spec.kind)
        body = ""
    finally:
        _TEXT_NOW.reset(token)
    return f"{title} ({spec.name})\n{body}"[:MAX_TEXT_CHARS]


async def create_item(
    db: AsyncSession,
    user: User,
    kind: str,
    *,
    title: str | None = None,
    folder_id: uuid.UUID | None = None,
    data: dict | None = None,
    installed_check: bool = True,
    extra: bool = False,
) -> tuple[UserFile, ItemDocument]:
    """A new item file in ``user``'s ``folder_id`` (flushed, not committed).
    The kind must be one they've added (or a hidden internal one)."""
    from app.files.storage import storage_path_for

    spec = get_spec(kind)
    if spec is None:
        raise ItemNotFound()
    if not spec.hidden and installed_check:
        if kind in await disabled_kinds(db):
            raise ItemNotFound()
        if kind not in await installed_kinds(db, user):
            raise ItemError(f"Add {spec.name} from the Item Store first.")
    if not spec.hidden and not extra:
        # One file per app per person. The lock makes two launches at once
        # (a double-tap, two devices) agree on a single file.
        from sqlalchemy import text as _sql

        await db.execute(_sql("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"item:{user.id}:{kind}"})
        existing = await primary_file(db, user, kind)
        if existing is not None:
            raise ItemExists(*existing)
    if folder_id is not None:
        from app.files.models import FileFolder

        folder = await db.get(FileFolder, folder_id)
        if folder is None or folder.user_id != user.id or folder.trashed_at is not None:
            raise ItemNotFound()
    else:
        # Apps live in ``My files/Apps/<App>``.
        from app.files.system_folders import app_folder

        folder_id = (await app_folder(db, user, spec.name)).id
    ctx = make_context(db, user, None, spec)
    raw = data if data is not None else spec.template(ctx)
    if data is None:
        # A new Health / Macros / Workout starts with what the others know.
        from app.items.body import prefill

        raw = await prefill(db, user, kind, raw)
        from app.items.shared import prefill as _shared_prefill

        raw = await _shared_prefill(user, kind, raw)
    try:
        clean = spec.validate(raw)
    except ValidationError as e:
        raise ItemError(f"That {spec.name} file isn't valid: {e.errors()[0].get('msg')}") from e
    size = len(_serialised(clean))
    if size > spec.max_bytes:
        raise ItemError(f"That's too big for one {spec.name} file.")
    await _check_room(db, user, size)
    new_id = uuid.uuid4()
    name = filename_for(spec, title or spec.name)
    shown = name[: -len(spec.suffix)] if name.endswith(spec.suffix) else name
    row = UserFile(
        id=new_id,
        user_id=user.id,
        folder_id=folder_id,
        filename=name,
        original_filename=name,
        mime_type=ITEM_MIME,
        size_bytes=size,
        storage_path=storage_path_for(user.id, new_id, ".item.export"),
        source_kind=ITEM_KIND,
        content_text=text_for(spec, shown, clean, user),
    )
    db.add(row)
    await db.flush()
    doc = ItemDocument(
        file_id=new_id, kind=kind, schema_version=spec.version, revision=1, data=clean, updated_by=user.id
    )
    db.add(doc)
    await db.flush()
    await refresh_reminders(db, row, doc, user)
    from app.tags.items_sync import sync_file as _sync_tags

    await _sync_tags(db, row.id, row.user_id, doc.kind, doc.data)
    return row, doc


async def _check_room(db: AsyncSession, user: User, size: int, previous: int = 0) -> None:
    """The owner's quota, for ``size`` replacing ``previous`` bytes."""
    if size <= previous:
        return
    from app.files.quota import get_quota

    quota = await get_quota(db, user)
    if not quota.can_fit(size - previous):
        raise ItemError("You're out of storage. Delete some files or ask an admin to raise your quota.")


# --------------------------------------------------------------------- load


async def load(
    db: AsyncSession, user: User, file_id: uuid.UUID, *, need: str = "read", lock: bool = False
) -> tuple[UserFile, ItemDocument, str]:
    """(file, document, access) — ``access`` is "read" / "comment" / "edit".
    Raises :class:`ItemNotFound` when ``user`` can't reach it (or can't
    ``need`` "edit")."""
    from app.files.office import get_office_access

    row = await db.get(UserFile, file_id)
    if row is None or row.source_kind != ITEM_KIND:
        raise ItemNotFound()
    access = await get_office_access(db, row, user)
    if access == "none" or (need == "edit" and access != "edit"):
        raise ItemNotFound()
    q = select(ItemDocument).where(ItemDocument.file_id == file_id)
    if lock:
        # Locked = about to write: read what's stored now, not what this
        # session loaded earlier (the AI panel's turn holds one session).
        q = q.with_for_update().execution_options(populate_existing=True)
    doc = (await db.execute(q)).scalar_one_or_none()
    if doc is None:
        raise ItemNotFound()
    await upgrade(db, doc)
    return row, doc, access


async def upgrade(db: AsyncSession, doc: ItemDocument) -> None:
    """Bring an old file up to its kind's current shape (in place)."""
    spec = get_spec(doc.kind)
    if spec is None or doc.schema_version >= spec.version or spec.migrate is None:
        return
    try:
        doc.data = spec.validate(spec.migrate(dict(doc.data or {}), doc.schema_version))
        doc.schema_version = spec.version
    except Exception:  # noqa: BLE001 — keep serving the old data rather than fail
        logger.exception("migrating %s %s from v%s failed", doc.kind, doc.file_id, doc.schema_version)


# --------------------------------------------------------------------- save


async def save_data(
    db: AsyncSession,
    user: User | None,
    row: UserFile,
    doc: ItemDocument,
    data: Any,
    *,
    base_revision: int | None,
    source: str = "edit",
    keep_version: bool = False,
    version_label: str | None = None,
    trash_removed: bool = True,
) -> FileVersion | None:
    """Validate and store ``data`` as the file's new content (flushed, not
    committed). Returns the version kept of the state it replaced, if any.

    Tasks / contacts the change drops go to the trash (``trash_removed``;
    off for archiving and version restores, which keep their own copy).

    ``base_revision`` is the revision the change was made against; None
    means "whatever is there" (server-side writers holding the row lock)."""
    spec = get_spec(doc.kind)
    if spec is None:
        raise ItemError("This item isn't available on this server any more.")
    if base_revision is not None and base_revision != doc.revision:
        raise Conflict(doc)
    try:
        clean = spec.validate(data)
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise ItemError(f"That change isn't valid ({where}: {first.get('msg', 'invalid')}).") from e
    if clean == doc.data:
        return None
    size = len(_serialised(clean))
    if size > spec.max_bytes:
        raise ItemError(f"That's more than one {spec.name} file can hold.")
    if user is not None and row.user_id == user.id:
        await _check_room(db, user, size, int(row.size_bytes or 0))
    version = await _maybe_version(db, row, doc, user, force=keep_version, source=source, label=version_label)
    if trash_removed:
        from app.trash.service import capture_item_removals

        await capture_item_removals(db, row, doc.kind, doc.data, clean, user.id if user is not None else None)
    before = doc.data
    doc.data = clean
    doc.revision = (doc.revision or 0) + 1
    doc.updated_by = user.id if user is not None else doc.updated_by
    doc.updated_at = datetime.now(timezone.utc)
    row.size_bytes = size
    row.content_text = text_for(spec, title_of(row), clean, user)
    row.modified_at = datetime.now(timezone.utc)
    await db.flush()
    if doc.kind == "journal":
        # Mentions in entries ("Mentioned in" on the things they name).
        from app.links.service import sync_journal

        await sync_journal(db, row.id, clean, user_id=user.id if user is not None else None)
    owner = user if (user is not None and user.id == row.user_id) else await db.get(User, row.user_id)
    if owner is not None:
        await refresh_reminders(db, row, doc, owner)
    from app.tags.items_sync import sync_file as _sync_tags

    await _sync_tags(db, row.id, row.user_id, doc.kind, doc.data)
    # Health / Macros / Workout share the person's body details and weigh-ins.
    from app.items.body import after_save as _body_after_save

    await _body_after_save(db, user, row, doc.kind, before or {}, clean)
    # …and food, currency and time format with the account and each other.
    from app.items.shared import after_save as _shared_after_save

    await _shared_after_save(db, user, row, doc.kind, before or {}, clean)
    # Notes: a reminder on a note is a task here (app/notes/reminders.py).
    if doc.kind == "tasks":
        from app.notes.reminders import after_tasks_save as _notes_after_save

        await _notes_after_save(db, row.id, before or {}, clean)
    return version


async def _maybe_version(
    db: AsyncSession,
    row: UserFile,
    doc: ItemDocument,
    user: User | None,
    *,
    force: bool,
    source: str,
    label: str | None,
) -> FileVersion | None:
    """Keep the current state as a version — always when ``force``, else at
    most every :data:`VERSION_EVERY`."""
    from app.files.versions import snapshot_file

    if not force:
        last = (
            await db.execute(
                select(FileVersion.created_at)
                .where(FileVersion.file_id == row.id)
                .order_by(FileVersion.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if last is not None and datetime.now(timezone.utc) - last < VERSION_EVERY:
            return None
    vsource = "pre_ai" if source == "ai" else ("auto" if source == "edit" else source)
    if vsource not in ("auto", "manual", "restore", "import", "pre_ai", "edit"):
        vsource = "auto"
    return await snapshot_file(
        db, row, source=vsource, label=label, author_id=user.id if user is not None else None
    )


# ------------------------------------------------------------------ actions


async def run_action(
    ctx: ItemContext, spec: ItemSpec, data: dict, name: str, args: Any
) -> ActionOutcome:
    """Run action ``name`` on ``data`` (in place). Validates ``args``; an
    :class:`ActionError` comes back as is, anything else as a generic
    failure (and is logged)."""
    action = spec.action(name)
    if action is None:
        raise ActionError(f"There's no action called {name!r}.")
    # Pydantic drops keys it doesn't know — an AI's ``first_name`` for
    # ``first`` would silently lose data. Refuse it, naming what's allowed.
    unknown = unknown_keys(action_schema(action), args or {})
    if unknown:
        raise ActionError(unknown)
    try:
        params = action.params.model_validate(args or {})
    except ValidationError as e:
        first = e.errors()[0] if e.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        # Say what it takes, so an AI can fix the call and retry.
        props = action_schema(action).get("properties", {})
        req = action_schema(action).get("required", [])
        takes = ", ".join(f"{k}{' (required)' if k in req else ''}" for k in props)
        raise ActionError(f"Bad arguments for {name} ({where}: {first.get('msg', 'invalid')}). It takes: {takes}.") from e
    try:
        out = action.run(ctx, data, params)
        if inspect.isawaitable(out):
            out = await out
    except ActionError:
        raise
    except (KeyError, ValueError, TypeError, IndexError) as e:
        logger.info("item action %s.%s refused: %r", spec.kind, name, e)
        raise ActionError(f"That didn't work: {e}") from e
    except Exception as e:  # noqa: BLE001
        logger.exception("item action %s.%s crashed", spec.kind, name)
        raise ActionError("That action failed unexpectedly.") from e
    if not isinstance(out, ActionOutcome):
        out = ActionOutcome(summary=str(out or "Done"))
    return out


_SCHEMAS: dict[int, dict] = {}


def action_schema(action: Any) -> dict:
    """The action's parameter JSON Schema with refs inlined (cached)."""
    key = id(action.params)
    if key not in _SCHEMAS:
        from app.items.ai import _inline_refs

        _SCHEMAS[key] = _inline_refs(action.params.model_json_schema())
    return _SCHEMAS[key]


def unknown_keys(schema: dict, value: Any, where: str = "") -> str | None:
    """A message for the first key in ``value`` the schema doesn't have, or
    None. Follows objects, arrays and anyOf/oneOf; free-form objects (no
    ``properties``) accept anything."""
    if not isinstance(schema, dict):
        return None
    for alt in ("anyOf", "oneOf"):
        if alt in schema:
            options = [o for o in schema[alt] if isinstance(o, dict)]
            results = [unknown_keys(o, value, where) for o in options if _fits(o, value)]
            if results and all(r is not None for r in results):
                return results[0]
            return None
    if isinstance(value, dict) and isinstance(schema.get("properties"), dict):
        props = schema["properties"]
        extra = schema.get("additionalProperties")
        for k, v in value.items():
            if k in props:
                msg = unknown_keys(props[k], v, f"{where}.{k}" if where else k)
                if msg:
                    return msg
            elif extra in (None, False):
                allowed = ", ".join(list(props)[:40])
                at = f" in {where}" if where else ""
                return f"Unknown field {k!r}{at}. Allowed: {allowed}."
            elif isinstance(extra, dict):
                msg = unknown_keys(extra, v, f"{where}.{k}" if where else k)
                if msg:
                    return msg
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, v in enumerate(value):
            msg = unknown_keys(schema["items"], v, f"{where}[{i}]")
            if msg:
                return msg
    return None


def _fits(schema: dict, value: Any) -> bool:
    t = schema.get("type")
    return (
        t is None
        or (t == "object" and isinstance(value, dict))
        or (t == "array" and isinstance(value, list))
        or (t == "null" and value is None)
        or (t in ("string", "integer", "number", "boolean") and not isinstance(value, (dict, list)) and value is not None)
    )


# ---------------------------------------------------------------- reminders


async def refresh_reminders(db: AsyncSession, row: UserFile, doc: ItemDocument, owner: User) -> None:
    """Replace the file's unsent reminders with what its data asks for now
    (one already sent with the same key isn't sent again)."""
    spec = get_spec(doc.kind)
    if spec is None or spec.reminders is None:
        return
    ctx = make_context(db, owner, row.id, spec)
    try:
        wanted = spec.reminders(doc.data, ctx) or []
    except Exception:  # noqa: BLE001
        logger.exception("reminders failed for %s %s", doc.kind, row.id)
        return
    horizon = ctx.now + REMINDER_HORIZON
    wanted = [r for r in wanted if r.due_at.tzinfo is not None and r.due_at <= horizon]
    recipients = [owner.id]
    if spec.remind_collaborators:
        recipients += [u for u in await _editors(db, row) if u != owner.id]
    sent = set(
        (
            await db.execute(
                select(ItemReminder.user_id, ItemReminder.key).where(
                    ItemReminder.file_id == row.id, ItemReminder.sent_at.is_not(None)
                )
            )
        ).all()
    )
    # A snoozed one ("Snooze 1 hour" on a push) isn't the data's to drop.
    await db.execute(
        delete(ItemReminder).where(
            ItemReminder.file_id == row.id, ItemReminder.sent_at.is_(None), ~ItemReminder.key.startswith("snooze:")
        )
    )
    for uid in recipients:
        seen: set[str] = set()
        for r in wanted[:200]:
            if (uid, r.key[:200]) in sent or r.key in seen:
                continue
            seen.add(r.key)
            db.add(
                ItemReminder(
                    file_id=row.id,
                    user_id=uid,
                    key=r.key[:200],
                    due_at=r.due_at.astimezone(timezone.utc),
                    title=r.title[:200],
                    body=(r.body or "")[:1000],
                )
            )
    await db.flush()


async def _editors(db: AsyncSession, row: UserFile) -> list[uuid.UUID]:
    """People the file (or a folder above it) is shared with for editing."""
    from app.files.models import ResourceGrant
    from app.files.sharing import ancestor_folder_ids

    folders = await ancestor_folder_ids(db, row.folder_id) if row.folder_id else []
    q = select(ResourceGrant.grantee_user_id).where(
        ResourceGrant.can_edit.is_(True),
        (
            (ResourceGrant.resource_type == "file") & (ResourceGrant.resource_id == row.id)
        )
        | ((ResourceGrant.resource_type == "folder") & (ResourceGrant.resource_id.in_(list(folders) or [uuid.uuid4()]))),
    )
    return list(dict.fromkeys((await db.execute(q)).scalars().all()))[:20]


# -------------------------------------------------------------------- state


async def get_state(db: AsyncSession, file_id: uuid.UUID, key: str, *, secret: bool = False) -> Any:
    row = await db.get(ItemState, (file_id, key))
    if row is None:
        return None
    if row.secret:
        if not secret:
            return None
        from app.auth.utils import decrypt_secret

        try:
            return json.loads(decrypt_secret((row.value or {}).get("v", "")))
        except Exception:  # noqa: BLE001 — a key rotation makes it unreadable
            return None
    return row.value


async def set_state(db: AsyncSession, file_id: uuid.UUID, key: str, value: Any, *, secret: bool = False) -> None:
    """Store (``value`` None deletes). ``secret`` encrypts it at rest and
    hides it from every read that doesn't ask for it."""
    row = await db.get(ItemState, (file_id, key))
    if value is None:
        if row is not None:
            await db.delete(row)
        return
    stored: Any = value
    if secret:
        from app.auth.utils import encrypt_secret

        stored = {"v": encrypt_secret(json.dumps(value))}
    if row is None:
        db.add(ItemState(file_id=file_id, key=key, value=stored, secret=secret))
    else:
        row.value = stored
        row.secret = secret
        row.updated_at = datetime.now(timezone.utc)
    await db.flush()


# ---------------------------------------------------------------- listings


async def list_items(
    db: AsyncSession, user: User, kind: str | None = None, limit: int = 200, *, archives: bool = True
) -> list[tuple[UserFile, ItemDocument]]:
    """This person's own live item files, most recently changed first
    (``archives=False``: only each app's own file, not archives)."""
    q = (
        select(UserFile, ItemDocument)
        .join(ItemDocument, ItemDocument.file_id == UserFile.id)
        .where(UserFile.user_id == user.id, UserFile.trashed_at.is_(None))
        .order_by(UserFile.modified_at.desc())
        .limit(limit)
    )
    if kind:
        q = q.where(ItemDocument.kind == kind)
    if not archives:
        q = q.where(
            ~select(ItemState.file_id)
            .where(ItemState.file_id == UserFile.id, ItemState.key == ARCHIVE_KEY)
            .exists()
        )
    return [(f, d) for f, d in (await db.execute(q)).all()]


async def primary_file(db: AsyncSession, user: User, kind: str) -> tuple[UserFile, ItemDocument] | None:
    """The app's one file for this person (not an archive)."""
    rows = await list_items(db, user, kind, limit=1, archives=False)
    return rows[0] if rows else None


async def open_app(db: AsyncSession, user: User, kind: str) -> tuple[UserFile, bool]:
    """The app's file, made (once) if there isn't one. Flushed."""
    from sqlalchemy import text as _sql

    # Serialise launches of one app for one person (a double tap, two devices).
    await db.execute(_sql("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"item:{user.id}:{kind}"})
    found = await primary_file(db, user, kind)
    if found is not None:
        return found[0], False
    await install(db, user, kind)
    try:
        row, _doc = await create_item(db, user, kind)
        return row, True
    except ItemExists as e:  # made meanwhile by another launch
        return e.row, False


async def restore(db: AsyncSession, user: User, row: UserFile, doc: ItemDocument, version: FileVersion) -> None:
    """Make ``version`` current again (the AI panel's Undo, version history's
    Restore), keeping what it replaces as a version first. Flushed."""
    if version.file_id != row.id or version.kind != "item" or version.data is None:
        raise ItemNotFound()
    data = version.data
    stamp = version.created_at.strftime("%d %b %Y, %H:%M") if version.created_at else "earlier"
    await save_data(
        db, user, row, doc, data, base_revision=None, source="restore",
        keep_version=True, version_label=f"Before restoring the version from {stamp}", trash_removed=False,
    )
    spec = get_spec(doc.kind)
    if spec is not None and spec.after_restore is not None:
        try:
            await spec.after_restore(db, row.id)
        except Exception:  # noqa: BLE001 — the restore itself succeeded
            logger.exception("after_restore failed for %s %s", doc.kind, row.id)


async def archive(
    db: AsyncSession, user: User, row: UserFile, doc: ItemDocument, before_day: str
) -> UserFile:
    """Move data older than ``before_day`` into a new file next to this one
    (the kind decides what "older" means). Returns the archive file."""
    spec = get_spec(doc.kind)
    if spec is None or spec.archive is None:
        raise ItemError("This item can't archive older data.")
    ctx = make_context(db, user, row.id, spec)
    try:
        kept, archived = spec.archive(dict(doc.data), ctx, before_day)
    except ActionError as e:
        raise ItemError(str(e)) from e
    title = f"{title_of(row)} — up to {before_day}"
    owner = await db.get(User, row.user_id) or user
    from app.files.system_folders import _child_folder

    archive_folder = await _child_folder(db, owner.id, row.folder_id, "Archive") if row.folder_id else None
    new_row, _new_doc = await create_item(
        db, owner, doc.kind, title=title, folder_id=archive_folder.id if archive_folder else None,
        data=archived, installed_check=False, extra=True,
    )
    await set_state(db, new_row.id, ARCHIVE_KEY, {"of": str(row.id), "before": before_day})
    await save_data(
        db, user, row, doc, kept, base_revision=None, source="manual",
        keep_version=True, version_label=f"Before archiving up to {before_day}", trash_removed=False,
    )
    return new_row


def export_json(row: UserFile, doc: ItemDocument) -> bytes:
    """What a download holds: the whole file, readable anywhere."""
    payload = {
        "promptly_item": doc.kind,
        "schema_version": doc.schema_version,
        "title": title_of(row),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "data": doc.data,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")


__all__ = [
    "ActionError",
    "Conflict",
    "ITEM_KIND",
    "ITEM_MIME",
    "ItemError",
    "ItemNotFound",
    "create_item",
    "export_json",
    "get_state",
    "install",
    "installed_kinds",
    "list_items",
    "load",
    "make_context",
    "run_action",
    "save_data",
    "set_state",
    "title_of",
    "uninstall",
]
