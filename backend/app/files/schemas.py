"""Pydantic schemas for the Files API."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.files.safety import UnsafeUploadError, sanitize_filename

Scope = Literal["mine", "shared"]
# Drive stage 1 list surfaces. Deep-linkable so the eventual "Promptly
# Drive" PWA (stage 3) can pick a start_url without forking.
FileListView = Literal["mine", "shared", "starred", "recent", "trash", "search"]
ShareAccessMode = Literal["public", "invite"]
ShareResourceType = Literal["file", "folder"]


class GranteeBrief(BaseModel):
    """One entry in a resource's grantee pill / share modal list.

    ``can_copy`` is the per-grantee permission flag (false = view only,
    true = view + "Copy to my files"). The user fields are denormalised
    on read so the frontend can render avatars / pills without a
    second round trip.
    """

    model_config = ConfigDict(from_attributes=True)

    grant_id: uuid.UUID
    user_id: uuid.UUID
    username: str
    email: str | None = None
    can_copy: bool


class GrantSummary(BaseModel):
    """Compact grant info attached to every shareable file/folder row.

    ``role`` tells the client which actions to render: an ``owner``
    sees the manage-grants modal trigger, a ``grantee`` sees only
    read-only / copy actions and the read-only badge. ``grantees``
    lists everyone *other than the caller* who can see this resource
    so the pill can render names directly. ``owner`` is set on rows
    where the caller is a grantee (otherwise the caller IS the owner
    and doesn't need a chip about themselves).
    """

    role: Literal["owner", "grantee"]
    grantees: list[GranteeBrief] = Field(default_factory=list)
    can_copy: bool = False  # only meaningful when role == "grantee"
    owner: "GranteeBrief | None" = None


class FolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    scope: Scope
    created_at: datetime
    # NULL = ordinary folder. Non-NULL = system-managed folder (e.g.
    # "chat_uploads"); the frontend uses this to swap the icon and hide
    # rename / delete actions.
    system_kind: str | None = None
    # Drive stage 1 timestamps — populated on every read path so the
    # Trash / Starred / Recent views share one shape with the default
    # browse view.
    updated_at: datetime | None = None
    starred_at: datetime | None = None
    trashed_at: datetime | None = None
    # Per-user share grants. ``None`` on rows where neither the
    # caller nor anyone else has a grant — keeps the wire payload
    # tiny on the common "private folder" case. See
    # :class:`GrantSummary` for shape + role semantics.
    sharing: GrantSummary | None = None


class FileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    folder_id: uuid.UUID | None
    filename: str
    mime_type: str
    size_bytes: int
    scope: Scope
    created_at: datetime
    # See ``FolderResponse`` for semantics; same three columns live on
    # both tables.
    updated_at: datetime | None = None
    starred_at: datetime | None = None
    trashed_at: datetime | None = None
    # Provenance hint surfaced to the client so the preview / edit
    # routing can decide "this is a Drive Document, open the TipTap
    # editor" vs "this is an AI-generated PDF, open the Markdown side
    # panel" vs "this is an ordinary user upload, open the plain
    # preview". Mirrors ``GeneratedKind`` on the backend and stays
    # nullable for ordinary uploads.
    source_kind: str | None = None
    source_file_id: uuid.UUID | None = None
    # Same shape + semantics as ``FolderResponse.sharing``.
    sharing: GrantSummary | None = None


GrantSummary.model_rebuild()


class BreadcrumbEntry(BaseModel):
    id: uuid.UUID | None  # null = scope root
    name: str


class BrowseResponse(BaseModel):
    scope: Scope
    folder: FolderResponse | None
    breadcrumbs: list[BreadcrumbEntry]
    folders: list[FolderResponse]
    files: list[FileResponse]
    writable: bool


def _clean_name(raw: str) -> str:
    """Validator helper that funnels every name field through ``sanitize_filename``."""
    try:
        return sanitize_filename(raw)
    except UnsafeUploadError as e:
        raise ValueError(str(e)) from e


class FolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    scope: Scope = "mine"

    @field_validator("name")
    @classmethod
    def _check_name(cls, raw: str) -> str:
        return _clean_name(raw)


class FolderUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    parent_id: uuid.UUID | None = None
    # When True, `parent_id=None` means "move to scope root" instead of
    # "leave unchanged". Pydantic can't distinguish omitted vs. explicit
    # null on its own.
    move_to_root: bool = False

    @field_validator("name")
    @classmethod
    def _check_name(cls, raw: str | None) -> str | None:
        return _clean_name(raw) if raw is not None else None


class FileUpdateRequest(BaseModel):
    filename: str | None = Field(default=None, min_length=1, max_length=512)
    folder_id: uuid.UUID | None = None
    move_to_root: bool = False

    @field_validator("filename")
    @classmethod
    def _check_filename(cls, raw: str | None) -> str | None:
        # Renames must clear the same bar as fresh uploads — no
        # control bytes, no path separators, no reserved Windows
        # device names.
        return _clean_name(raw) if raw is not None else None


class StorageQuotaResponse(BaseModel):
    """``GET /api/files/quota`` payload.

    All three values are byte counts. ``cap_bytes`` and
    ``remaining_bytes`` are nullable to express "no limit applies".
    """

    cap_bytes: int | None
    used_bytes: int
    remaining_bytes: int | None


class AttachmentDescriptor(BaseModel):
    """Snapshot of a file at the moment it was attached to a chat message."""

    id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int


class SourceContentResponse(BaseModel):
    """Payload for ``GET /api/files/{id}/source``.

    Returns the editable source backing a rendered artefact. For Phase
    A3 the only supported pair is ``rendered_pdf`` -> ``markdown_source``,
    but the fields are kept generic so the eventual image-source flow
    fits the same shape.
    """

    rendered_file_id: uuid.UUID
    rendered_filename: str
    source_file_id: uuid.UUID
    source_filename: str
    source_mime_type: str
    source_size_bytes: int
    content: str
    # When the rendered child or the source itself was last modified.
    # The editor uses this to display "edited X minutes ago" and (in a
    # future phase) to refuse a stale save.
    rendered_size_bytes: int


class SourceUpdateRequest(BaseModel):
    """Body for ``PUT /api/files/{id}/source``.

    Just the new Markdown content. The editor sends the entire body
    on every save (no diff) — keeps the wire protocol trivial and
    matches the user's mental model of "I saved this version."
    """

    content: str = Field(min_length=0, max_length=200_000)


# --------------------------------------------------------------------
# Drive stage 1 — search / list / share-link DTOs
# --------------------------------------------------------------------
class FileSearchHit(BaseModel):
    """One row of the Drive FTS results feed.

    ``snippet`` is the ``ts_headline`` output with the matched term(s)
    wrapped in ``<mark>...</mark>``. Pre-sanitised: nothing else is
    allowed through, so the frontend can render it with
    ``dangerouslySetInnerHTML``.
    """

    model_config = ConfigDict(from_attributes=True)

    file: FileResponse
    rank: float
    snippet: str | None = None
    # Short, human-readable folder trail like ``"My Drive › Invoices"``.
    # Helps disambiguate identically-named files in a flat list.
    breadcrumb: str | None = None


class FileSearchResponse(BaseModel):
    query: str
    hits: list[FileSearchHit]


class RecentFilesResponse(BaseModel):
    files: list[FileResponse]


class StarredListResponse(BaseModel):
    """Combined starred feed. Folders first, then files."""

    folders: list[FolderResponse]
    files: list[FileResponse]


class TrashListResponse(BaseModel):
    """Combined trash feed. Both tables share the same timestamp
    column so the client merges them by ``trashed_at`` for the UI.
    """

    folders: list[FolderResponse]
    files: list[FileResponse]


class ShareLinkCreateRequest(BaseModel):
    """Body for ``POST /api/files/{id}/share-links``.

    ``access_mode`` ``public`` = anyone-with-link (optionally
    password-gated). ``invite`` = must authenticate as a Promptly
    user; the first authed visit records a grant and subsequent
    visits skip the auth nudge.
    """

    access_mode: ShareAccessMode = "public"
    password: str | None = Field(default=None, min_length=4, max_length=128)
    expires_in_days: int | None = Field(default=None, ge=1, le=365)


class ShareLinkResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    resource_type: ShareResourceType
    resource_id: uuid.UUID
    token: str
    access_mode: ShareAccessMode
    has_password: bool
    expires_at: datetime | None
    revoked_at: datetime | None
    access_count: int
    last_accessed_at: datetime | None
    created_at: datetime
    # Full URL suitable for copy-to-clipboard. The backend doesn't
    # know the origin so the frontend overwrites this when it
    # serialises the response; we still include the ``/s/{token}``
    # path here so CLI callers see something useful.
    path: str


class ShareLinkListResponse(BaseModel):
    links: list[ShareLinkResponse]


class ShareLinkMetaResponse(BaseModel):
    """``GET /s/{token}/meta`` — surfaces just enough info for the
    landing page to decide whether to prompt for a password.

    We deliberately don't leak the filename / size until after the
    password has been unlocked. The ``resource_type`` + ``created_at``
    fields are fine to expose because the token itself is
    unguessable.
    """

    resource_type: ShareResourceType
    access_mode: ShareAccessMode
    requires_password: bool
    requires_auth: bool
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    # Only set once unlocked / not-gated.
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None


class ShareLinkUnlockRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class ShareLinkUnlockResponse(BaseModel):
    # Short-lived JWT-ish token that the landing page hands back on
    # ``/s/{token}/download`` so the user doesn't re-enter the
    # password for every click.
    unlock_token: str


class ShareFolderBrowseResponse(BaseModel):
    """``GET /s/{token}/browse`` — cut-down browse payload for a
    folder share link. Scoped to the shared subtree only; the
    caller can't traverse up.
    """

    folder: FolderResponse
    breadcrumbs: list[BreadcrumbEntry]
    folders: list[FolderResponse]
    files: list[FileResponse]


# --------------------------------------------------------------------
# Drive stage 4 — Documents (TipTap + Y.js collab)
# --------------------------------------------------------------------
class DocumentCreateRequest(BaseModel):
    """``POST /api/documents`` payload.

    Creates a brand new Drive Document — a ``UserFile`` row with
    ``source_kind="document"`` and a matching ``document_state`` row
    holding an empty Y.Doc. The caller is the author.

    ``name`` is optional; when omitted the server picks the default
    localised title ("Untitled document") so the Drive list doesn't
    show an empty string before the user types anything.
    """

    scope: Scope = "mine"
    folder_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def _check_name(cls, raw: str | None) -> str | None:
        return _clean_name(raw) if raw is not None else None


class CollabTokenResponse(BaseModel):
    """``GET /api/documents/{id}/collab-token`` payload.

    ``token`` is a short-lived HS256 JWT carrying ``{document_id,
    user_id, perm}``. The editor passes it to Hocuspocus as the
    websocket auth token (see ``onAuthenticate`` on the collab
    server). Expires quickly (~5 minutes) so a copied URL loses
    access fast.
    """

    token: str
    # Unix timestamp. The client uses this to schedule a refresh a
    # few seconds before the old token stops working so an edit
    # session never drops.
    expires_at: int
    # Echo the user's display name / colour back so the caller can
    # pre-fill the collaboration-cursor awareness state without a
    # separate ``/me`` round trip.
    user: "CollabTokenUser"


class CollabTokenUser(BaseModel):
    id: uuid.UUID
    name: str
    color: str


CollabTokenResponse.model_rebuild()


class ManualDocumentSaveRequest(BaseModel):
    """``POST /api/documents/{id}/save`` payload.

    Lets the user-side "Save" button persist the editor's current
    HTML straight to the file blob, bypassing the Hocuspocus collab
    snapshot path. Two reasons we want this even though the collab
    service writes snapshots automatically:

    1. **Fallback when collab is broken.** Cloudflare tunnels, lazy
       proxies, or a stopped collab container all manifest as the
       file silently staying at 0 bytes. A manual save lets the
       owner force a write without waiting on the WS pipeline.
    2. **Explicit "I'm done" affordance.** Closing the laptop on a
       half-typed paragraph shouldn't gamble on whether the 3-second
       collab debounce flushed before the network died.

    The body is the editor's full ``editor.getHTML()`` output. The
    backend re-sanitises with the same allowlist as the collab
    snapshot path so a hostile client can't smuggle in extra HTML
    by going around Hocuspocus.
    """

    # Cap matches the per-document content guard the snapshot path
    # already enforces in spirit (Y.Docs over a few MB of inline
    # text aren't a great experience anyway). 4 MB of plain HTML is
    # comfortably more than the editor will ever produce in a
    # legitimate session.
    html: str = Field(default="", max_length=4 * 1024 * 1024)


# --------------------------------------------------------------------
# Drive stage 5 — peer-to-peer share grants
# --------------------------------------------------------------------
class UserSearchResult(BaseModel):
    """One row from the share-modal user autocomplete."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    email: str | None = None
    # Convenience flag used by the picker to disable a row that's
    # already on the grant list — saves the modal a separate diff.
    already_granted: bool = False


class UserSearchResponse(BaseModel):
    results: list[UserSearchResult]


class GrantsListResponse(BaseModel):
    """``GET /api/files/{file|folder}/{id}/grants`` payload.

    Owner-only endpoint. ``can_share`` is echoed back so the modal
    can render correctly (in v1 only the owner can manage grants;
    we still return the field to leave room for a future "delegate
    grant management" affordance without a wire change).
    """

    grants: list[GranteeBrief]
    can_share: bool


class CreateGrantRequest(BaseModel):
    grantee_user_id: uuid.UUID
    can_copy: bool = False


class UpdateGrantRequest(BaseModel):
    can_copy: bool


# Hard cap from the product spec — refused at the API layer rather
# than the DB so the error message stays readable. Bumping it would
# need a UX pass on the pill (currently truncates after a few
# names).
MAX_GRANTS_PER_RESOURCE: Final[int] = 10


class CopyToMineResponse(BaseModel):
    """``POST /api/files/files/{file_id}/copy-to-mine`` payload.

    Returns the freshly-cloned ``UserFile`` row owned by the caller
    so the Drive UI can update the listing without a refetch.
    """

    file: FileResponse


class DocumentAssetResponse(BaseModel):
    """``POST /api/documents/{id}/assets`` payload.

    Returned when the editor uploads an inline image or audio clip
    from inside a doc. ``url`` is the authenticated download path
    the TipTap node uses as its ``src`` attribute.
    """

    id: uuid.UUID
    filename: str
    mime_type: str
    size_bytes: int
    url: str
