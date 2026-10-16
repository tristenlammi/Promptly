"""Finding files for the assistant (WP-5.3): filters shared by the chat tools.

``search_my_files`` narrows its passages with these, and ``list_my_files``
lists what matches. Every query starts from the one read rule
(:func:`app.files.access.readable_predicate`) — your files, files shared
with you, files inside folders shared with you — so a filter can only
narrow, never widen, what the assistant sees.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.access import readable_predicate

# What the assistant can ask for, in people's words.
FILE_TYPES = ("document", "sheet", "whiteboard", "pdf", "office", "image", "text", "audio", "video")
OWNERS = ("anyone", "me", "shared")

_OFFICE_RE = r"\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$"
_TEXT_RE = r"\.(txt|md|markdown|csv|tsv|json|log|xml|ya?ml)$"
_TYPE_SQL = {
    "document": "{a}.source_kind = 'document'",
    "sheet": "{a}.source_kind = 'sheet'",
    "whiteboard": "{a}.source_kind = 'whiteboard'",
    "pdf": "(lower({a}.mime_type) = 'application/pdf' OR {a}.filename ILIKE '%.pdf')",
    "office": f"({{a}}.source_kind IS NULL AND {{a}}.filename ~* '{_OFFICE_RE}')",
    "image": "lower({a}.mime_type) LIKE 'image/%'",
    "text": f"({{a}}.source_kind IS NULL AND (lower({{a}}.mime_type) LIKE 'text/%' OR {{a}}.filename ~* '{_TEXT_RE}'))",
    "audio": "lower({a}.mime_type) LIKE 'audio/%'",
    "video": "lower({a}.mime_type) LIKE 'video/%'",
}


class FilterError(ValueError):
    """A filter the assistant gave that doesn't resolve (a folder or a
    person that doesn't exist, a bad date) — its message is for the model."""


@dataclass
class FileFilters:
    type: str | None = None
    folder_id: uuid.UUID | None = None
    owner: str = "anyone"
    owner_id: uuid.UUID | None = None
    modified_after: datetime | None = None
    modified_before: datetime | None = None
    name: str | None = None
    labels: list[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.type or self.folder_id or self.owner != "anyone" or self.owner_id
                    or self.modified_after or self.modified_before or self.name)

    def sql(self, alias: str = "f") -> tuple[str, dict[str, Any]]:
        """Extra ``AND`` clauses on ``files AS <alias>`` (bound params are
        prefixed ``ff_`` so they can't clash with the caller's)."""
        a = alias
        parts: list[str] = []
        params: dict[str, Any] = {}
        if self.type:
            parts.append(_TYPE_SQL[self.type].format(a=a))
        if self.folder_id is not None:
            parts.append(
                f"""{a}.folder_id IN (
                    WITH RECURSIVE ff_sub(id) AS (
                        SELECT CAST(:ff_folder AS uuid)
                        UNION
                        SELECT c.id FROM file_folders AS c JOIN ff_sub ON c.parent_id = ff_sub.id
                    ) SELECT id FROM ff_sub)"""
            )
            params["ff_folder"] = str(self.folder_id)
        if self.owner_id is not None:
            parts.append(f"{a}.user_id = :ff_owner")
            params["ff_owner"] = str(self.owner_id)
        elif self.owner == "me":
            parts.append(f"{a}.user_id = :ff_reader")
        elif self.owner == "shared":
            parts.append(f"{a}.user_id <> :ff_reader")
        if self.modified_after is not None:
            parts.append(f"{a}.modified_at >= :ff_after")
            params["ff_after"] = self.modified_after
        if self.modified_before is not None:
            parts.append(f"{a}.modified_at < :ff_before")
            params["ff_before"] = self.modified_before
        if self.name:
            parts.append(f"{a}.filename ILIKE :ff_name")
            params["ff_name"] = "%" + self.name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        return " AND ".join(parts), params


def _day(raw: str, what: str) -> date:
    try:
        return date.fromisoformat(raw.strip()[:10])
    except ValueError as exc:
        raise FilterError(f"`{what}` must be a date like 2026-03-31.") from exc


async def folder_by_path(db: AsyncSession, owner_id: uuid.UUID, path: str) -> Any | None:
    """One of ``owner_id``'s live folders by its path from My files
    ("Taxes/2025"; case-insensitive), or ``None``."""
    from app.files.models import FileFolder

    parent: uuid.UUID | None = None
    folder = None
    for seg in [s.strip() for s in path.strip().strip("/").split("/") if s.strip()]:
        q = select(FileFolder).where(
            FileFolder.user_id == owner_id,
            FileFolder.trashed_at.is_(None),
            func.lower(FileFolder.name) == seg.lower(),
            FileFolder.parent_id == parent if parent is not None else FileFolder.parent_id.is_(None),
        )
        folder = (await db.execute(q.limit(1))).scalars().first()
        if folder is None:
            return None
        parent = folder.id
    return folder


async def folder_path(db: AsyncSession, folder: Any | None) -> str:
    """"Taxes/2025" for a folder; "" for My files."""
    from app.files.models import FileFolder

    names: list[str] = []
    cur = folder
    for _ in range(64):
        if cur is None:
            break
        names.append(cur.name)
        cur = await db.get(FileFolder, cur.parent_id) if cur.parent_id else None
    return "/".join(reversed(names))


async def resolve_folder(db: AsyncSession, reader_id: uuid.UUID, ref: str) -> Any:
    """A folder the reader can see, from what the assistant said: an id, a
    path of their own ("Taxes/2025"), or a folder name that's unique among
    their own and shared folders."""
    from app.files.models import FileFolder, ResourceGrant

    ref = (ref or "").strip()
    if not ref:
        raise FilterError("`folder` is empty.")
    try:
        fid = uuid.UUID(ref)
    except ValueError:
        fid = None
    if fid is not None:
        folder = await db.get(FileFolder, fid)
        if folder is not None and folder.trashed_at is None and await _can_see_folder(db, folder, reader_id):
            return folder
        raise FilterError("No folder with that id that you can open.")
    if "/" in ref.strip("/"):
        folder = await folder_by_path(db, reader_id, ref)
        if folder is None:
            raise FilterError(f"No folder at {ref!r} in My files.")
        return folder
    name = ref.strip("/")
    shared_ids = select(ResourceGrant.resource_id).where(
        ResourceGrant.grantee_user_id == reader_id, ResourceGrant.resource_type == "folder"
    )
    rows = (
        await db.execute(
            select(FileFolder).where(
                FileFolder.trashed_at.is_(None),
                func.lower(FileFolder.name) == name.lower(),
                (FileFolder.user_id == reader_id) | FileFolder.id.in_(shared_ids),
            ).limit(5)
        )
    ).scalars().all()
    if not rows:
        raise FilterError(f"No folder called {name!r}.")
    if len(rows) > 1:
        paths = [await folder_path(db, r) for r in rows]
        raise FilterError(
            f"Several folders are called {name!r} ({'; '.join(paths)}) — give the path or the id."
        )
    return rows[0]


async def _can_see_folder(db: AsyncSession, folder: Any, reader_id: uuid.UUID) -> bool:
    from app.files.models import FileFolder, ResourceGrant

    if folder.user_id == reader_id:
        return True
    cur = folder
    for _ in range(64):
        if cur is None:
            return False
        granted = await db.scalar(
            select(func.count()).select_from(ResourceGrant).where(
                ResourceGrant.grantee_user_id == reader_id,
                ResourceGrant.resource_type == "folder",
                ResourceGrant.resource_id == cur.id,
            )
        )
        if granted:
            return True
        cur = await db.get(FileFolder, cur.parent_id) if cur.parent_id else None
    return False


async def resolve_person(db: AsyncSession, ref: str) -> Any:
    from app.auth.models import User

    ref = ref.strip().lstrip("@")
    q = select(User).where(
        (func.lower(User.username) == ref.lower()) | (func.lower(User.email) == ref.lower())
    )
    u = (await db.execute(q.limit(1))).scalars().first()
    if u is None:
        raise FilterError(f"No one called {ref!r} here.")
    return u


async def build_filters(db: AsyncSession, reader_id: uuid.UUID, args: dict[str, Any]) -> FileFilters:
    """Tool arguments → :class:`FileFilters` (raises :class:`FilterError`)."""
    f = FileFilters()
    t = args.get("type")
    if t:
        if t not in FILE_TYPES:
            raise FilterError(f"`type` must be one of: {', '.join(FILE_TYPES)}.")
        f.type = t
        f.labels.append(t)
    folder_ref = args.get("folder")
    if folder_ref:
        folder = await resolve_folder(db, reader_id, str(folder_ref))
        f.folder_id = folder.id
        f.labels.append(f"in {await folder_path(db, folder) or folder.name}")
    owner = str(args.get("owner") or "anyone").strip()
    if owner.lower() in OWNERS:
        f.owner = owner.lower()
    else:
        person = await resolve_person(db, owner)
        f.owner_id = person.id
    if f.owner != "anyone" or f.owner_id:
        f.labels.append(f"owner {owner}")
    if args.get("modified_after"):
        d = _day(str(args["modified_after"]), "modified_after")
        f.modified_after = datetime.combine(d, time.min, tzinfo=timezone.utc)
        f.labels.append(f"since {d.isoformat()}")
    if args.get("modified_before"):
        d = _day(str(args["modified_before"]), "modified_before")
        f.modified_before = datetime.combine(d + timedelta(days=1), time.min, tzinfo=timezone.utc)
        f.labels.append(f"until {d.isoformat()}")
    name = str(args.get("name") or "").strip()
    if name:
        f.name = name[:200]
        f.labels.append(f"name has {name!r}")
    return f


def listing_where(alias: str = "f") -> str:
    """Files a person would see in Drive: readable, not an editor's inline
    asset or other hidden kind."""
    from app.files.generated_kinds import HIDDEN_KINDS

    hidden = ", ".join(f"'{k}'" for k in sorted(HIDDEN_KINDS))
    return (
        f"{readable_predicate(alias, param='ff_reader')} "
        f"AND ({alias}.source_kind IS NULL OR {alias}.source_kind NOT IN ({hidden}))"
    )


async def list_files(
    db: AsyncSession, reader_id: uuid.UUID, filters: FileFilters, *, limit: int = 30
) -> tuple[list[dict[str, Any]], int]:
    """Matching files, newest first: (rows, total)."""
    extra, params = filters.sql("f")
    where = listing_where("f") + (f" AND {extra}" if extra else "")
    params = {**params, "ff_reader": str(reader_id)}
    total = (await db.execute(text(f"SELECT count(*) FROM files AS f WHERE {where}"), params)).scalar() or 0
    rows = (
        await db.execute(
            text(
                f"""SELECT f.id, f.filename, f.mime_type, f.size_bytes, f.source_kind, f.folder_id,
                           f.user_id, f.modified_at, u.username
                    FROM files AS f LEFT JOIN users AS u ON u.id = f.user_id
                    WHERE {where}
                    ORDER BY f.modified_at DESC
                    LIMIT :ff_limit"""
            ),
            {**params, "ff_limit": limit},
        )
    ).all()
    from app.files.models import FileFolder

    out = []
    paths: dict[Any, str] = {}
    for r in rows:
        if r.folder_id not in paths:
            folder = await db.get(FileFolder, r.folder_id) if r.folder_id else None
            paths[r.folder_id] = await folder_path(db, folder)
        out.append({
            "id": str(r.id),
            "name": r.filename,
            "kind": kind_label(r.source_kind, r.mime_type, r.filename),
            "folder": paths[r.folder_id],
            "owner": "you" if r.user_id == reader_id else (r.username or "someone"),
            "modified": r.modified_at.date().isoformat() if r.modified_at else None,
            "size_bytes": r.size_bytes,
        })
    return out, int(total)


def kind_label(source_kind: str | None, mime: str | None, filename: str | None) -> str:
    if source_kind in ("document", "sheet", "whiteboard"):
        return source_kind
    import re

    name = (filename or "").lower()
    mime = (mime or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if re.search(_OFFICE_RE, name):
        return "office"
    for prefix in ("image", "audio", "video", "text"):
        if mime.startswith(prefix + "/"):
            return prefix
    return "file"


__all__ = [
    "FILE_TYPES",
    "FileFilters",
    "FilterError",
    "build_filters",
    "folder_by_path",
    "folder_path",
    "kind_label",
    "list_files",
    "listing_where",
    "resolve_folder",
]
