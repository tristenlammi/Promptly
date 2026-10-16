"""ORM models for the Files feature.

Two tables that mirror each other on ownership: `FileFolder` and `UserFile`.
Every row is owned by exactly one user (`user_id` is non-null). The legacy
admin-managed "shared pool" (`user_id IS NULL`) was retired in migration
``0042_resource_grants``; sharing is now per-resource via `ResourceGrant`,
which lets any owner grant read (optionally read+copy) access to up to
`MAX_GRANTS_PER_RESOURCE` other Promptly users.

Folders form a tree via `parent_id`. Files live either at a folder's root
(when `folder_id` is set) or at the owner's Drive root (when `folder_id`
IS NULL). System folders (`system_kind`) — Chat Uploads / Generated Files /
Generated Media — exist for every owner and are intentionally non-shareable.
"""
from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy import Uuid
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, UUIDPKMixin


class FileFolder(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "file_folders"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_folders.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # NULL = regular user-created folder. Non-NULL marks the row as a
    # system folder (e.g. "Chat Uploads"); the API blocks rename / delete /
    # move on those so the auto-routing helpers can rely on them existing.
    # See ``app.files.system_folders.SystemKind`` for the enum.
    system_kind: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    # Left out of Photos, with everything inside it (WP-9.1).
    hide_from_photos: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    # Soft-delete pointer for the Drive "Trash" view. NULL = live, any
    # non-null timestamp means the row is in the trash and should be
    # filtered out of normal browse results. The empty-trash endpoint
    # walks rows where this is non-null and does the real DB + blob
    # delete. Added in migration ``0035_files_trash_starred``.
    trashed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Who sent it to the trash, and from which session (0200, WP-7.2) — what
    # the mass-delete guard counts and "restore everything this device
    # deleted" puts back.
    trashed_by: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    trashed_credential: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Per-user "Starred" flag; non-null = pinned in the Starred view,
    # value is when it was starred. Also used as a tiebreaker in the
    # default folder ordering.
    starred_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Drives the Recent view. Maintained by the ``files_set_updated_at``
    # trigger so we don't have to remember to bump it on every
    # mutation path.
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    def __repr__(self) -> str:
        return f"<FileFolder id={self.id} name={self.name!r} owner={self.user_id}>"


class UserFile(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "files"

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_folders.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Relative path under /app/uploads. Resolved by the router with a safe
    # join so a caller can never escape the upload root.
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    # Provenance hint for AI-generated artefacts. NULL for ordinary user
    # uploads. Currently used values:
    #
    #   "markdown_source"  – authoritative Markdown for a renderable doc
    #                        (the editor in Phase A3 mutates this row).
    #   "rendered_pdf"     – PDF rendered from a markdown_source row;
    #                        ``source_file_id`` points at that source.
    #
    # Treat the strings as part of the schema: see
    # ``app.files.generated_kinds.GeneratedKind`` for the canonical enum.
    source_kind: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    # When this row is a *rendered* artefact (e.g. a PDF rendered from
    # Markdown), this points at the source-of-truth file. Editing the
    # source + re-running the renderer should overwrite this row's blob
    # so a download from chat always reflects the latest source. The
    # ON DELETE SET NULL keeps the rendered file alive even if the
    # source gets deleted out from under it (the user just can't
    # re-render anymore).
    source_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # --- Drive stage 1 additions (migration 0035) ---
    # See ``FileFolder`` for semantics. Same columns live on both
    # tables so the list views / filters / trigger are symmetric.
    trashed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Who sent it to the trash, and from which session (0200, WP-7.2) — what
    # the mass-delete guard counts and "restore everything this device
    # deleted" puts back.
    trashed_by: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    trashed_credential: Mapped[str | None] = mapped_column(String(64), nullable=True)
    starred_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    # Plain-text content extracted at upload time (or source-save
    # time) for the full-text search index. NULL for binary uploads
    # that carry no extractable text. Capped at ~256KB in the
    # extraction helper to keep the tsvector size reasonable; see
    # migration ``0036_files_fts`` for the generated ``content_tsv``
    # derived from this column.
    content_text: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )
    # When the *content* last changed (0188, R-209). ``updated_at`` moves on
    # every UPDATE — a star or a move — so "Modified" and Recent used it
    # wrongly. Bumped by the flush hook below when the bytes change.
    modified_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    # Office files: bumped when a version is restored (WP-6.2) — collab
    # tokens carry it, and an editor from an older generation reloads
    # instead of merging the replaced state back in.
    collab_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    # The bytes' identity (0199, WP-7.1): hashes of canonical blobs, what the
    # integrity scrubber last found (ready / ingesting / missing / damaged)
    # and when it last checked them.
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sha1: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # For WebDAV sync clients — rclone's owncloud mode checks MD5 (WP-8.4).
    md5: Mapped[str | None] = mapped_column(String(32), nullable=True)
    blob_state: Mapped[str] = mapped_column(String(16), nullable=False, default="ready", server_default="ready")
    verified_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Modified time on the device it was uploaded from (0201, WP-7.3) — the
    # fallback "taken" date for a photo without one.
    client_mtime: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return f"<UserFile id={self.id} name={self.filename!r} owner={self.user_id}>"


# Columns whose change means the file's content changed.
_CONTENT_COLUMNS = ("storage_path", "size_bytes", "content_text")


def _bump_modified_at(session, _ctx, _instances) -> None:
    from sqlalchemy import inspect as _inspect

    now = _dt.datetime.now(_dt.timezone.utc)
    for obj in session.dirty:
        if not isinstance(obj, UserFile):
            continue
        state = _inspect(obj)
        if any(state.attrs[c].history.has_changes() for c in _CONTENT_COLUMNS):
            if not state.attrs["modified_at"].history.has_changes():
                obj.modified_at = now


class FileShareLink(UUIDPKMixin, CreatedAtMixin, Base):
    """A signed, optionally password-protected share link to a file or folder.

    Polymorphic pointer via ``(resource_type, resource_id)`` so the
    same table holds both. Not a FK because Postgres doesn't do
    polymorphic FKs; orphaned links 404 on resolve, which is fine.
    Added in migration ``0037_file_share_links``.
    """

    __tablename__ = "file_share_links"

    # ``'file'`` or ``'folder'``. Validated by a DB check constraint.
    resource_type: Mapped[str] = mapped_column(String(16), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 43-char URL-safe base64 of 32 random bytes. Unique across the
    # table; we also have a partial UNIQUE on live rows.
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # ``'public'`` = anyone with URL (password/expiry gated).
    # ``'invite'`` = auth'd Promptly user; first visit creates a
    # ``FileShareGrant`` row for that user.
    access_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    # Optional bcrypt hash. NULL = no password required.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Serve photos with their location and camera metadata? Off: the link
    # gets a metadata-free copy (the stored original keeps it) — D13.
    keep_location: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # NULL = never expires.
    expires_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Soft-delete; revoked links 410 Gone rather than 404 so the
    # UI can explain what happened.
    revoked_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    access_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    last_accessed_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # ``view`` / ``comment`` / ``edit`` (0198, WP-6.6). Comment and edit
    # links are always ``invite`` — opening one signed in grants that role
    # (a ``ResourceGrant`` with ``via_link_id``).
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="view", server_default="view")

    def is_alive(self) -> bool:
        now = _dt.datetime.now(_dt.timezone.utc)
        return self.revoked_at is None and (self.expires_at is None or self.expires_at > now)

    def __repr__(self) -> str:
        return (
            f"<FileShareLink id={self.id} "
            f"{self.resource_type}={self.resource_id} mode={self.access_mode}>"
        )


class FileShareGrant(UUIDPKMixin, CreatedAtMixin, Base):
    """Recorded claim of an ``access_mode='invite'`` link by a user.

    Lets a returning authenticated user skip the "you've been invited
    to view this" nudge — we look up ``(link_id, user_id)`` and if it
    exists, go straight through to the resource.
    """

    __tablename__ = "file_share_grants"

    link_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("file_share_links.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        return f"<FileShareGrant link={self.link_id} user={self.user_id}>"


class DocumentState(Base):
    """Y.js CRDT state for a Drive Document.

    One row per document (1:1 with ``UserFile``). The Hocuspocus
    collab service reads + writes this table via its Database
    extension — every idle batch of edits flushes the full merged
    Y.Doc here so a container restart never loses in-flight work and
    every Hocuspocus replica agrees on the same state.

    The file blob on disk holds the *rendered* HTML snapshot (kept
    in sync by the snapshot endpoint the collab server calls) so
    preview, download, and full-text search continue to work without
    any Y.js awareness. The ORM row on ``UserFile`` is what the rest
    of Drive (listings, quota, share links, trash) interacts with;
    this table is an implementation detail of the editor.

    Added in migration ``0038_document_state``.
    """

    __tablename__ = "document_state"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    # Full merged Y.Doc state (not a delta) — overwritten on every
    # store. Cap is implicit via Postgres BYTEA (1 GB) but real docs
    # will stay in the tens-of-KB range.
    yjs_update: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Monotonic store counter bumped by the collab server. Lets the
    # backend snapshot endpoint ignore an out-of-order POST if two
    # replicas ever race.
    version: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
    )

    def __repr__(self) -> str:
        return f"<DocumentState file={self.file_id} v={self.version}>"


class DocumentVersion(UUIDPKMixin, Base):
    """A point-in-time HTML snapshot of a Drive Document (Phase 9).

    Captured on the collab snapshot path (throttled + content-hash
    deduped so a burst of idle-flushes doesn't store dozens of near-
    identical rows) and on every explicit manual save. Restore is a
    client-side operation (``editor.setContent`` of a version's HTML,
    which flows back through Yjs) so the backend only stores + serves
    these — no CRDT surgery.

    ``content_hash`` lets capture skip an unchanged snapshot; the row
    count per document is capped (oldest auto-versions pruned) so a
    long-lived doc can't grow versions unbounded.

    Added in migration ``0130_document_versions``.
    """

    __tablename__ = "document_versions"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Full sanitised HTML at capture time.
    html: Mapped[str] = mapped_column(Text, nullable=False)
    # Plain text preview (first-N chars rendered client-side).
    plain_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("0")
    )
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Who triggered this version. NULL for collab-path auto-captures
    # (the snapshot POST is authenticated by the internal bearer, not a
    # user) and when the author account is later deleted.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # ``auto`` (collab snapshot), ``manual`` (explicit save), or
    # ``restore`` (a restore's resulting save).
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'auto'")
    )
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
    )

    def __repr__(self) -> str:
        return f"<DocumentVersion file={self.file_id} at={self.created_at}>"


class ResourceGrant(UUIDPKMixin, CreatedAtMixin, Base):
    """Per-user access grant on a Drive file or folder.

    Polymorphic via ``(resource_type, resource_id)`` so a single
    table covers both files and folders — same shape as
    :class:`FileShareLink`. The unique constraint on
    ``(resource_type, resource_id, grantee_user_id)`` keeps grants
    de-duped; the no-self-grant check stops an owner accidentally
    granting themselves access (which would corrupt the "is the
    caller the owner?" question elsewhere in the router).

    Cascading semantics:

    * Folder grants implicitly cover every descendant (subfolders +
      files) at lookup time. We do NOT explode the ACL into a row
      per descendant — recipients see the subtree by joining
      against ancestor folder ids on every read.
    * File grants are leaf-only and apply to that single file.
    * The owner is identified by ``files.user_id`` /
      ``file_folders.user_id``. ``granted_by_user_id`` records
      *who* issued the grant — usually the owner, but kept
      separately so an admin-issued or migration-seeded grant is
      distinguishable.

    Quotas: a grant never affects storage accounting. The blob
    counts against the owner; "Copy to my files" creates a brand-
    new ``UserFile`` owned by the recipient and bumps **their**
    quota at copy time.

    Added in migration ``0042_resource_grants``.
    """

    __tablename__ = "resource_grants"

    resource_type: Mapped[str] = mapped_column(String(16), nullable=False)
    resource_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    grantee_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    granted_by_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    can_copy: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Stage 5.1: write access. Currently only meaningful on
    # ``resource_type='file'`` rows that point at a Drive Document
    # (``UserFile.source_kind == 'document'``). The router refuses
    # ``can_edit=true`` on folder grants and on non-document files
    # so we never end up with a stored permission that the rest of
    # the stack can't honour. ``can_copy`` and ``can_edit`` are
    # independent booleans (not a single enum) so a future
    # "Editor + copy" tier doesn't need another migration — the UI
    # currently presents them as mutually-exclusive radios but the
    # storage layer leaves room.
    can_edit: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Comment without editing (0198, WP-6.6) — Docs, Sheets, Whiteboards.
    can_comment: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    # Set when the grant came from opening a comment / edit share link: it
    # lasts while the link does (revoked → deleted; expired → ignored).
    via_link_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_share_links.id", ondelete="CASCADE"), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "resource_type IN ('file', 'folder')",
            name="resource_grants_resource_type_check",
        ),
        CheckConstraint(
            "grantee_user_id <> granted_by_user_id",
            name="resource_grants_no_self_grant",
        ),
        UniqueConstraint(
            "resource_type",
            "resource_id",
            "grantee_user_id",
            name="resource_grants_unique",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<ResourceGrant {self.resource_type}={self.resource_id} "
            f"grantee={self.grantee_user_id} "
            f"can_copy={self.can_copy} can_edit={self.can_edit}>"
        )


class BlobTombstone(UUIDPKMixin, CreatedAtMixin, Base):
    """A blob waiting to be unlinked — deletion is deferred, never immediate.

    Every path that permanently deletes user bytes (Delete forever, Empty
    trash, folder purge, user deletion) records the blob here in the same
    transaction as the row delete, instead of unlinking it. A daily sweep
    unlinks it once ``purge_after`` has passed, and only if nothing
    references the path again. That leaves a 14-day window in which a
    mistaken purge can be undone from the nightly database dump plus the
    still-present bytes.

    ``is_dir`` marks a whole bucket (a deleted user's ``u_<id>``): the sweep
    removes only the files inside it that no row references.

    No FK to users — the owner is usually gone by the time this matters.
    """

    __tablename__ = "blob_tombstones"

    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    size_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    reason: Mapped[str] = mapped_column(String(32), nullable=False)
    is_dir: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    purge_after: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )



class FileVersion(Base):
    """A snapshot of an office file's editor state (0190, WP-3.3).

    Written by the collab server (``auto`` every ~10 minutes of editing and
    on last disconnect, ``shrink_guard`` before a much smaller state
    replaces the current one) and by the backend (``pre_ai``, ``import``,
    ``restore``, ``manual``). ``yjs_state`` is zlib-compressed; ``data`` is
    a sheet's workbook JSON. Recovery is an admin script for now
    (``python -m app.cli versions``); the restore UI comes later.
    """

    __tablename__ = "file_versions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    yjs_state: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    data: Mapped[object | None] = mapped_column(JSONB, nullable=True)
    preview: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    author_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, default=list, server_default=text("'{}'::uuid[]")
    )
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    keep_forever: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # A PDF version's bytes (0197, WP-6.5) — a blob in the owner's bucket.
    storage_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

class FileMedia(Base):
    """A photo's or video's metadata (0201, WP-7.3) — see the migration."""

    __tablename__ = "file_media"

    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    taken_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    taken_at_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    tz_offset: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    orientation: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    make: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(96), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    codec: Mapped[str | None] = mapped_column(String(32), nullable=True)
    content_identifier: Mapped[str | None] = mapped_column(String(64), nullable=True)
    live_pair_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    motion_video_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    motion_embedded: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    thumbhash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    derivative_state: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", server_default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    taken_at_override: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lat_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon_override: Mapped[float | None] = mapped_column(Float, nullable=True)
    location_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=text("false"))
    extracted_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The media worker's renditions (0202, WP-7.4) under derived/<file_id>/.
    renditions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    derived_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default=text("0"))
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default=text("0"))
    processing_started_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StorageCheck(Base):
    """One run of the integrity scrubber (0200, WP-7.2)."""

    __tablename__ = "storage_checks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    started_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    finished_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # running → ok | problems (something missing / damaged) | failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, default="nightly")
    checked: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    verified: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bytes_verified: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    missing: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    damaged: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    recovered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quarantined: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class FileActivity(Base):
    """When a user last opened / edited a file (0191, WP-3.4) — one row per
    user, file and kind, upserted. Drives Recent, so files shared with you
    and workspace files you worked on show up there too."""

    __tablename__ = "file_activity"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )


class DocumentComment(UUIDPKMixin, CreatedAtMixin, Base):
    """A comment on a Drive document or workspace note (0192, WP-4.5,
    R-227). A thread is a root comment plus its replies (``parent_id``).

    ``anchor`` holds two base64 Yjs relative positions (``{"from", "to"}``)
    into the document's Y.Doc, so the highlight follows the text through
    everyone's edits; ``quote`` keeps the words it was about, for when that
    text is deleted. Resolving applies to the thread (the root row)."""

    __tablename__ = "document_comments"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("document_comments.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # SET NULL keeps a departed member's comments readable.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    anchor: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    resolved_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    edited_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DriveIndexState(Base):
    """What Ask your Drive indexed from each file (0193, WP-5.1): the text
    hash and embedding model it was built from, so a background pass only
    re-embeds what changed. ``skipped`` = nothing to index (an image, an
    empty file)."""

    __tablename__ = "drive_index_state"

    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    chunks: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    indexed_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )


from sqlalchemy import event as _event  # noqa: E402
from sqlalchemy.orm import Session as _Session  # noqa: E402

_event.listen(_Session, "before_flush", _bump_modified_at)
