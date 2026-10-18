"""WebDAV at ``/dav/`` (WP-8.4, Part C §5.7).

Your own Drive ("My files") for sync clients and mounts — Finder, rclone,
FolderSync, PhotoSync — signed in with an app password (Account → Devices):
``dav:read`` to look and download, ``dav:write`` to change anything.

A native async subset, over the same functions the web app uses, so the
trash, versions, quota, allowlist and workspace rules are the web app's:

* ``PROPFIND`` at depth 0 or 1 (infinity is refused), ``GET``/``HEAD``
  (nginx serves the bytes, Range included), ``PUT`` streamed to disk,
  ``MKCOL``, ``MOVE``, ``COPY``, ``DELETE`` (to the trash), ``PROPPATCH``
  for the modified time, ``LOCK``/``UNLOCK`` (kept in this process — one
  worker — so Finder mounts read-write).
* A ``PUT`` over a file keeps the old bytes as a version; ``If-Match`` on
  the ETag (the SHA-256) refuses a stale write with 412. ``MOVE`` onto a
  file — how editors and rclone save safely — does the same.
* ``X-OC-Mtime`` (rclone's owncloud vendor) and ``Win32LastModifiedTime``
  set the modified time; ``oc:checksums`` gives the SHA-1, and an
  ``OC-Checksum`` sent with a PUT is checked.
* Docs, Sheets and Whiteboards are read-only exports (.html, .xlsx,
  .excalidraw): a client can never write over the live document. Workspace
  folders are read-only too — the workspace owns them.
* Never shown: the AI's text mirrors and a document's pictures
  (``HIDDEN_KINDS``), and Finder's ``._*`` / ``.DS_Store``, which are
  accepted and dropped.

Each device's deletes are its own (the mass-delete guard can undo them) —
and only happen when its app password has ``dav:delete``. Without it a
``DELETE`` is answered as done but the file stays: a phone that clears
space (or a sync app told to mirror deletions) never takes the copy here
with it. A mounted drive (Finder, ``rclone mount``) wants ``dav:delete``.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import unicodedata
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import get_db
from app.files.generated_kinds import HIDDEN_KINDS, GeneratedKind
from app.files.models import FileFolder, UserFile

logger = logging.getLogger("promptly.files.dav")

router = APIRouter()

PREFIX = "/dav"
DAV_NS = "DAV:"
OC_NS = "http://owncloud.org/ns"
MS_NS = "urn:schemas-microsoft-com:"
ET.register_namespace("d", DAV_NS)
ET.register_namespace("oc", OC_NS)

METHODS = ["OPTIONS", "PROPFIND", "PROPPATCH", "GET", "HEAD", "PUT", "DELETE", "MKCOL", "MOVE", "COPY", "LOCK", "UNLOCK"]
_READ_METHODS = {"PROPFIND", "GET", "HEAD"}
# Accepted and dropped: macOS resource forks and folder settings.
_JUNK = re.compile(r"^(\._.*|\.DS_Store)$")
_SHELL_EXT = {GeneratedKind.SHEET.value: ".xlsx", GeneratedKind.WHITEBOARD.value: ".excalidraw"}
# A folder copied whole: past this it's refused rather than tying up the worker.
COPY_MAX_ITEMS = 2000
LOCK_DEFAULT_SECONDS = 600
LOCK_MAX_SECONDS = 3600


class DavError(Exception):
    def __init__(self, status: int, message: str = "", *, condition: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.condition = condition


# ---------------------------------------------------------------- the tree


@dataclass
class Node:
    """A resource: the root, a folder, or a file under its WebDAV name."""

    kind: str  # "root" | "folder" | "file"
    segs: list[str]
    folder: FileFolder | None = None
    file: UserFile | None = None
    in_workspace: bool = False

    @property
    def is_collection(self) -> bool:
        return self.kind != "file"

    @property
    def folder_id(self) -> uuid.UUID | None:
        return self.folder.id if self.folder is not None else None

    @property
    def href(self) -> str:
        return href_for(self.segs, self.is_collection)

    @property
    def read_only(self) -> bool:
        """Content can't be written: an export, or the workspace's."""
        if self.in_workspace:
            return True
        return self.file is not None and self.file.source_kind is not None


def href_for(segs: list[str], collection: bool) -> str:
    path = PREFIX + "/" + "/".join(urllib.parse.quote(s, safe="") for s in segs)
    if collection and not path.endswith("/"):
        path += "/"
    return path


def split_path(path: str) -> list[str]:
    segs = [unicodedata.normalize("NFC", s) for s in path.split("/") if s]
    if any(s in (".", "..") for s in segs):
        raise DavError(400, "Bad path.")
    return segs


def display_name(row: UserFile) -> str:
    ext = _SHELL_EXT.get(row.source_kind or "")
    if ext:
        return (row.filename or "Untitled").rsplit(".", 1)[0] + ext
    return row.filename


def _visible_files(user: User, parent_id: uuid.UUID | None):
    return select(UserFile).where(
        UserFile.user_id == user.id,
        UserFile.folder_id == parent_id if parent_id is not None else UserFile.folder_id.is_(None),
        UserFile.trashed_at.is_(None),
        or_(UserFile.source_kind.is_(None), UserFile.source_kind.not_in(sorted(HIDDEN_KINDS))),
    )


def _child_folders(user: User, parent_id: uuid.UUID | None):
    return select(FileFolder).where(
        FileFolder.user_id == user.id,
        FileFolder.parent_id == parent_id if parent_id is not None else FileFolder.parent_id.is_(None),
        FileFolder.trashed_at.is_(None),
    )


async def children(db: AsyncSession, user: User, parent_id: uuid.UUID | None) -> list[tuple[str, Any]]:
    """A folder's contents as (name, FileFolder | UserFile). Names are
    unique without regard to case — a second "x.txt" is "x (2).txt", in
    the order they were added."""
    folders = (await db.execute(_child_folders(user, parent_id).order_by(FileFolder.created_at, FileFolder.id))).scalars().all()
    files = (await db.execute(_visible_files(user, parent_id).order_by(UserFile.created_at, UserFile.id))).scalars().all()
    taken: set[str] = set()
    out: list[tuple[str, Any]] = []

    def unique(name: str) -> str:
        if name.lower() not in taken:
            return name
        stem, dot, ext = name.rpartition(".")
        if not dot or not stem:
            stem, ext = name, ""
        i = 2
        while True:
            cand = f"{stem} ({i}).{ext}" if ext else f"{stem} ({i})"
            if cand.lower() not in taken:
                return cand
            i += 1

    for f in folders:
        name = unique(f.name)
        taken.add(name.lower())
        out.append((name, f))
    for row in files:
        name = display_name(row)
        if _JUNK.match(name):
            continue
        name = unique(name)
        taken.add(name.lower())
        out.append((name, row))
    return out


def _pick(name: str, entries: list[tuple[str, Any]]) -> Any | None:
    exact = [e for n, e in entries if n == name]
    if exact:
        return exact[0]
    low = [e for n, e in entries if n.lower() == name.lower()]
    return low[0] if low else None


class Tree:
    """Name lookups for one request (and which folders are a workspace's)."""

    def __init__(self, db: AsyncSession, user: User, *, can_delete: bool = True):
        self.db = db
        self.user = user
        # The app password may delete (``dav:delete``); otherwise a DELETE
        # leaves the file where it is.
        self.can_delete = can_delete
        self._roots: set[uuid.UUID] | None = None

    async def workspace_roots(self) -> set[uuid.UUID]:
        if self._roots is None:
            from app.chat.models import Workspace
            from app.files.system_folders import SystemKind

            ids = set((await self.db.execute(select(Workspace.root_folder_id).where(Workspace.root_folder_id.is_not(None)))).scalars())
            ids |= set(
                (
                    await self.db.execute(
                        select(FileFolder.id).where(
                            FileFolder.user_id == self.user.id, FileFolder.system_kind == SystemKind.WORKSPACES_ROOT.value
                        )
                    )
                ).scalars()
            )
            self._roots = ids
        return self._roots

    async def _child(self, parent_id: uuid.UUID | None, name: str) -> Any | None:
        folders = (
            await self.db.execute(_child_folders(self.user, parent_id).where(func.lower(FileFolder.name) == name.lower()))
        ).scalars().all()
        if folders:
            return next((f for f in folders if f.name == name), folders[0])
        if _JUNK.match(name):
            return None
        # Usually the name is the filename and there's one: no listing needed.
        rows = (
            await self.db.execute(_visible_files(self.user, parent_id).where(func.lower(UserFile.filename) == name.lower()))
        ).scalars().all()
        if len(rows) == 1 and display_name(rows[0]).lower() == name.lower():
            return rows[0]
        return _pick(name, await children(self.db, self.user, parent_id))

    async def resolve(self, segs: list[str]) -> Node | None:
        if not segs:
            return Node("root", [])
        roots = await self.workspace_roots()
        parent: FileFolder | None = None
        in_ws = False
        for i, seg in enumerate(segs):
            hit = await self._child(parent.id if parent else None, seg)
            if hit is None:
                return None
            last = i == len(segs) - 1
            if isinstance(hit, FileFolder):
                in_ws = in_ws or hit.id in roots
                if last:
                    return Node("folder", segs, folder=hit, in_workspace=in_ws)
                parent = hit
            else:
                if not last:
                    return None
                return Node("file", segs, folder=parent, file=hit, in_workspace=in_ws)
        return None

    async def parent_of(self, segs: list[str]) -> Node:
        """The folder a new resource at ``segs`` would go in: 409 when it
        doesn't exist."""
        node = await self.resolve(segs[:-1])
        if node is None or not node.is_collection:
            raise DavError(409, "The folder it would go in doesn't exist.")
        return node


def _container(node: Node) -> uuid.UUID | None:
    """The folder id a collection node stands for (None = the root)."""
    return node.folder.id if node.kind == "folder" and node.folder else None


# ---------------------------------------------------------------- props


def etag(node: Node) -> str | None:
    if node.kind == "file" and node.file is not None:
        row = node.file
        if row.source_kind in _SHELL_EXT:
            stamp = int((row.updated_at or row.modified_at).timestamp() * 1000)
            return f'"{row.id.hex}-{stamp}-{row.collab_epoch or 0}"'
        if row.content_sha256 and row.source_kind is None:
            return f'"{row.content_sha256}"'
        return f'"{row.id.hex}-{row.size_bytes}-{int(row.modified_at.timestamp() * 1000)}"'
    if node.kind == "folder" and node.folder is not None:
        return f'"{node.folder.id.hex}-{int(node.folder.updated_at.timestamp() * 1000)}"'
    return None


def mtime(node: Node) -> datetime:
    if node.file is not None:
        return node.file.client_mtime or node.file.modified_at or node.file.created_at
    if node.folder is not None:
        return node.folder.updated_at or node.folder.created_at
    return datetime.now(timezone.utc)


def _http_date(dt: datetime) -> str:
    return format_datetime(dt.astimezone(timezone.utc), usegmt=True)


def _mime(node: Node) -> str | None:
    row = node.file
    if row is None:
        return None
    if row.source_kind == GeneratedKind.SHEET.value:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if row.source_kind == GeneratedKind.WHITEBOARD.value:
        return "application/json"
    return row.mime_type or "application/octet-stream"


def _size(node: Node) -> int | None:
    row = node.file
    if row is None or row.source_kind in _SHELL_EXT:
        return None  # exported on demand: not known until then
    return int(row.size_bytes or 0)


def _q(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


ALLPROP = [
    _q(DAV_NS, n)
    for n in ("displayname", "resourcetype", "getcontentlength", "getcontenttype", "getlastmodified", "creationdate", "getetag", "supportedlock", "lockdiscovery")
] + [_q(OC_NS, "checksums"), _q(OC_NS, "fileid")]


def prop_value(node: Node, name: str, ctx: dict[str, Any]) -> ET.Element | None:
    """The property as an element, or None if this resource hasn't it."""
    el = ET.Element(name)
    if name == _q(DAV_NS, "displayname"):
        el.text = node.segs[-1] if node.segs else "My files"
    elif name == _q(DAV_NS, "resourcetype"):
        if node.is_collection:
            ET.SubElement(el, _q(DAV_NS, "collection"))
    elif name == _q(DAV_NS, "getcontentlength"):
        size = _size(node)
        if size is None:
            return None
        el.text = str(size)
    elif name == _q(DAV_NS, "getcontenttype"):
        mime = _mime(node)
        if mime is None:
            return None
        el.text = mime
    elif name == _q(DAV_NS, "getlastmodified"):
        el.text = _http_date(mtime(node))
    elif name == _q(DAV_NS, "creationdate"):
        made = node.file.created_at if node.file else node.folder.created_at if node.folder else None
        if made is None:
            return None
        el.text = made.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    elif name == _q(DAV_NS, "getetag"):
        tag = etag(node)
        if tag is None:
            return None
        el.text = tag
    elif name == _q(DAV_NS, "supportedlock"):
        for scope in ("exclusive", "shared"):
            entry = ET.SubElement(el, _q(DAV_NS, "lockentry"))
            ET.SubElement(ET.SubElement(entry, _q(DAV_NS, "lockscope")), _q(DAV_NS, scope))
            ET.SubElement(ET.SubElement(entry, _q(DAV_NS, "locktype")), _q(DAV_NS, "write"))
    elif name == _q(DAV_NS, "lockdiscovery"):
        for lock in locks.covering(ctx["user_id"], node.segs):
            el.append(lock.active_xml())
    elif name in (_q(DAV_NS, "quota-used-bytes"), _q(DAV_NS, "quota-available-bytes")):
        quota = ctx.get("quota")
        if not node.is_collection or quota is None:
            return None
        if name == _q(DAV_NS, "quota-used-bytes"):
            el.text = str(quota.used_bytes)
        else:
            if quota.cap_bytes is None:
                return None
            el.text = str(max(quota.cap_bytes - quota.used_bytes, 0))
    elif name == _q(OC_NS, "checksums"):
        row = node.file
        if row is None or not row.sha1 or row.source_kind is not None:
            return None
        # One element, space-separated — how ownCloud and rclone read it.
        ET.SubElement(el, _q(OC_NS, "checksum")).text = f"SHA1:{row.sha1}" + (f" MD5:{row.md5}" if row.md5 else "")
    elif name == _q(OC_NS, "fileid"):
        rid = node.file.id if node.file else node.folder.id if node.folder else None
        if rid is None:
            return None
        el.text = rid.hex
    else:
        return None
    return el


def response_for(node: Node, names: list[str] | None, ctx: dict[str, Any], *, names_only: bool = False) -> ET.Element:
    resp = ET.Element(_q(DAV_NS, "response"))
    ET.SubElement(resp, _q(DAV_NS, "href")).text = node.href
    found, missing = [], []
    for name in names if names is not None else ALLPROP:
        value = prop_value(node, name, ctx)
        if value is None:
            if names is not None:
                missing.append(ET.Element(name))
            continue
        if names_only:
            value = ET.Element(name)
        found.append(value)
    for props, status in ((found, "200 OK"), (missing, "404 Not Found")):
        if not props:
            continue
        stat = ET.SubElement(resp, _q(DAV_NS, "propstat"))
        prop = ET.SubElement(stat, _q(DAV_NS, "prop"))
        prop.extend(props)
        ET.SubElement(stat, _q(DAV_NS, "status")).text = f"HTTP/1.1 {status}"
    return resp


def multistatus(responses: list[ET.Element]) -> Response:
    root = ET.Element(_q(DAV_NS, "multistatus"))
    root.extend(responses)
    body = b'<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding="utf-8")
    return Response(content=body, status_code=207, media_type="application/xml; charset=utf-8")


def _parse(body: bytes) -> ET.Element | None:
    if not body.strip():
        return None
    from defusedxml.ElementTree import fromstring

    try:
        return fromstring(body)
    except Exception:  # noqa: BLE001 — any parse failure is the client's
        raise DavError(400, "That XML couldn't be read.") from None


# ---------------------------------------------------------------- locks


@dataclass
class Lock:
    token: str
    user_id: uuid.UUID
    segs: list[str]
    exclusive: bool
    infinite: bool
    owner: bytes | None
    expires: float
    timeout: int
    key: list[str] = field(default_factory=list)

    def covers(self, key: list[str]) -> bool:
        return key == self.key or (self.infinite and key[: len(self.key)] == self.key and len(key) > len(self.key))

    def active_xml(self) -> ET.Element:
        act = ET.Element(_q(DAV_NS, "activelock"))
        ET.SubElement(ET.SubElement(act, _q(DAV_NS, "locktype")), _q(DAV_NS, "write"))
        ET.SubElement(ET.SubElement(act, _q(DAV_NS, "lockscope")), _q(DAV_NS, "exclusive" if self.exclusive else "shared"))
        ET.SubElement(act, _q(DAV_NS, "depth")).text = "infinity" if self.infinite else "0"
        if self.owner:
            try:
                from defusedxml.ElementTree import fromstring

                act.append(fromstring(self.owner))
            except Exception:  # noqa: BLE001
                pass
        ET.SubElement(act, _q(DAV_NS, "timeout")).text = f"Second-{self.timeout}"
        ET.SubElement(ET.SubElement(act, _q(DAV_NS, "locktoken")), _q(DAV_NS, "href")).text = self.token
        ET.SubElement(ET.SubElement(act, _q(DAV_NS, "lockroot")), _q(DAV_NS, "href")).text = href_for(self.segs, False)
        return act


def _key(segs: list[str]) -> list[str]:
    return [s.lower() for s in segs]


class LockTable:
    """Write locks, in this process (the API runs one worker). Finder won't
    mount read-write without them."""

    def __init__(self) -> None:
        self._locks: dict[str, Lock] = {}

    def _live(self) -> list[Lock]:
        now = time.monotonic()
        for t in [t for t, lk in self._locks.items() if lk.expires <= now]:
            del self._locks[t]
        return list(self._locks.values())

    def get(self, token: str) -> Lock | None:
        self._live()
        return self._locks.get(token)

    def covering(self, user_id: uuid.UUID, segs: list[str]) -> list[Lock]:
        k = _key(segs)
        return [lk for lk in self._live() if lk.user_id == user_id and lk.covers(k)]

    def under(self, user_id: uuid.UUID, segs: list[str]) -> list[Lock]:
        """Locks on ``segs`` or anything inside it."""
        k = _key(segs)
        return [lk for lk in self._live() if lk.user_id == user_id and lk.key[: len(k)] == k]

    def add(self, lock: Lock) -> None:
        self._live()
        lock.key = _key(lock.segs)
        self._locks[lock.token] = lock

    def remove(self, token: str) -> None:
        self._locks.pop(token, None)

    def move(self, user_id: uuid.UUID, segs: list[str]) -> None:
        """A moved or deleted resource takes its locks with it."""
        for lk in self.under(user_id, segs):
            self.remove(lk.token)

    def clear(self) -> None:
        self._locks.clear()


locks = LockTable()


def _timeout(header: str | None) -> int:
    for part in (header or "").split(","):
        part = part.strip()
        if part.lower().startswith("second-"):
            try:
                return max(1, min(int(part[7:]), LOCK_MAX_SECONDS))
            except ValueError:
                continue
        if part.lower() == "infinite":
            return LOCK_MAX_SECONDS
    return LOCK_DEFAULT_SECONDS


# ------------------------------------------------------ If header (RFC 4918 §10.4)

_IF_TOKEN = re.compile(r"<[^>]*>|\(|\)|\[[^\]]*\]|Not", re.IGNORECASE)


def _parse_if(header: str) -> list[tuple[str | None, list[list[tuple[bool, str, str]]]]]:
    """[(resource href or None, [list of (negated, 'token'|'etag', value)])]"""
    groups: list[tuple[str | None, list[list[tuple[bool, str, str]]]]] = []
    current: tuple[str | None, list] | None = None
    in_list = False
    negate = False
    cond: list[tuple[bool, str, str]] = []
    for tok in _IF_TOKEN.findall(header):
        if tok == "(":
            if current is None:
                current = (None, [])
                groups.append(current)
            in_list, cond, negate = True, [], False
        elif tok == ")":
            if current is not None:
                current[1].append(cond)
            in_list = False
        elif tok.lower() == "not":
            negate = True
        elif tok.startswith("<"):
            if in_list:
                cond.append((negate, "token", tok[1:-1]))
                negate = False
            else:
                current = (tok[1:-1], [])
                groups.append(current)
        elif tok.startswith("["):
            cond.append((negate, "etag", tok[1:-1]))
            negate = False
    if not groups or any(not lists for _r, lists in groups):
        raise DavError(400, "That If header couldn't be read.")
    return groups


async def check_if(request: Request, tree: Tree, node: Node | None, segs: list[str]) -> set[str]:
    """Evaluate the If header (412 when false). Returns the lock tokens it
    submitted."""
    header = request.headers.get("if")
    if not header:
        return set()
    groups = _parse_if(header)
    submitted = {v for _r, lists in groups for cond in lists for _n, kind, v in cond if kind == "token"}
    user_id = tree.user.id
    ok = False
    for resource, lists in groups:
        r_segs, r_node = segs, node
        if resource is not None:
            r_path = urllib.parse.urlparse(resource).path
            r_segs = split_path(_strip_prefix(urllib.parse.unquote(r_path)))
            r_node = await tree.resolve(r_segs)
        r_tag = etag(r_node) if r_node is not None else None
        live = {lk.token for lk in locks.covering(user_id, r_segs)}
        for cond in lists:
            if all(((v in live) if kind == "token" else (v == r_tag)) != negated for negated, kind, v in cond):
                ok = True
                break
        if ok:
            break
    if not ok:
        raise DavError(412, "A condition in the If header wasn't met.")
    return submitted


def require_unlocked(user_id: uuid.UUID, segs: list[str], tokens: set[str], *, inside: bool = False) -> None:
    """423 when someone else's lock (one whose token wasn't sent) covers
    ``segs`` — or, for a whole folder, anything in it."""
    held = locks.under(user_id, segs) if inside else []
    for lk in locks.covering(user_id, segs) + held:
        if lk.token not in tokens:
            raise DavError(423, "It's locked.", condition="lock-token-submitted")


# ---------------------------------------------------------------- helpers


def _strip_prefix(path: str) -> str:
    if path == PREFIX or path.startswith(PREFIX + "/"):
        return path[len(PREFIX):]
    raise DavError(502, "That destination isn't on this server.")


def _destination(request: Request) -> list[str]:
    dest = request.headers.get("destination")
    if not dest:
        raise DavError(400, "MOVE and COPY need a Destination.")
    path = urllib.parse.unquote(urllib.parse.urlparse(dest).path)
    return split_path(_strip_prefix(path))


def _overwrite(request: Request) -> bool:
    return (request.headers.get("overwrite") or "T").strip().upper() != "F"


def _clean_name(name: str) -> str:
    """A new name must be stored as given — a sync client looks for it there."""
    from app.files.safety import UnsafeUploadError, sanitize_filename

    try:
        clean = sanitize_filename(name)
    except UnsafeUploadError as e:
        raise DavError(400, str(e)) from None
    if clean != name:
        raise DavError(400, f"“{name}” can't be used as a name here (it would be stored as “{clean}”).")
    return name


def _writable_parent(parent: Node) -> None:
    if parent.in_workspace:
        raise DavError(403, "That folder belongs to a workspace — change it from the workspace.")


def _http(e: HTTPException, *, quota_is_507: bool = False) -> DavError:
    """The web app's refusal, as WebDAV says it."""
    if isinstance(e.detail, dict):
        detail = str(e.detail.get("message") or e.detail.get("detail") or "")
    else:
        detail = str(e.detail or "")
    code = e.status_code
    if code == 413 and quota_is_507:
        code = 507  # Insufficient Storage: over the quota
    elif code == 409:
        code = 403  # a workspace's or a system folder's
    return DavError(code, detail)


async def _quota(db: AsyncSession, user: User):  # noqa: ANN202
    from app.files.quota import get_quota

    return await get_quota(db, user)


async def _parse_mtime(request: Request) -> int | None:
    """``X-OC-Mtime`` (seconds), as ms."""
    raw = request.headers.get("x-oc-mtime")
    if not raw:
        return None
    try:
        secs = float(raw)
    except ValueError:
        return None
    return int(secs * 1000) if secs > 0 else None


# ---------------------------------------------------------------- handlers


async def do_options(request: Request) -> Response:
    return Response(
        status_code=200,
        headers={
            "DAV": "1, 2",
            "MS-Author-Via": "DAV",
            "Allow": ", ".join(METHODS),
            "Accept-Ranges": "bytes",
        },
    )


async def do_propfind(request: Request, tree: Tree, segs: list[str]) -> Response:
    depth = (request.headers.get("depth") or "1").strip().lower()
    if depth not in ("0", "1"):
        raise DavError(403, "Listing a whole tree at once isn't allowed — use Depth: 1.", condition="propfind-finite-depth")
    if not segs:
        # A device's first look: Camera Uploads is there to point a phone at.
        from app.files.system_folders import ensure_camera_uploads

        await ensure_camera_uploads(tree.db, tree.user)
        await tree.db.commit()
    node = await tree.resolve(segs)
    if node is None:
        raise DavError(404)
    doc = _parse(await request.body())
    names: list[str] | None = None
    names_only = False
    if doc is not None:
        if doc.tag != _q(DAV_NS, "propfind"):
            raise DavError(400, "Expected a propfind.")
        prop = doc.find(_q(DAV_NS, "prop"))
        if prop is not None:
            names = [c.tag for c in prop]
        elif doc.find(_q(DAV_NS, "propname")) is not None:
            names_only = True
    want_quota = names is not None and any("quota-" in n for n in names)
    ctx = {"user_id": tree.user.id, "quota": await _quota(tree.db, tree.user) if want_quota else None}
    responses = [response_for(node, names, ctx, names_only=names_only)]
    if depth == "1" and node.is_collection:
        for name, child in await children(tree.db, tree.user, _container(node)):
            in_ws = node.in_workspace or (isinstance(child, FileFolder) and child.id in await tree.workspace_roots())
            sub = (
                Node("folder", segs + [name], folder=child, in_workspace=in_ws)
                if isinstance(child, FileFolder)
                else Node("file", segs + [name], folder=node.folder, file=child, in_workspace=node.in_workspace)
            )
            responses.append(response_for(sub, names, ctx, names_only=names_only))
    return multistatus(responses)


async def do_get(request: Request, tree: Tree, segs: list[str], *, head: bool) -> Response:
    node = await tree.resolve(segs)
    if node is None:
        raise DavError(404)
    if node.is_collection:
        if head:
            return Response(status_code=200, media_type="text/html; charset=utf-8")
        return await _listing_page(tree, node)
    row = node.file
    assert row is not None
    tag = etag(node)
    headers = {
        "Last-Modified": _http_date(mtime(node)),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Accept-Ranges": "bytes",
    }
    if tag:
        headers["ETag"] = tag
        if request.headers.get("if-none-match", "").strip() in (tag, "*"):
            return Response(status_code=304, headers=headers)
    if row.source_kind in _SHELL_EXT:
        from app.files.office import content_for_shell, export_for_download

        entity = await content_for_shell(tree.db, row)
        if entity is None:
            raise DavError(404)
        data, _name, mime = await asyncio.to_thread(export_for_download, row, entity)
        return Response(content=b"" if head else data, media_type=mime, headers={**headers, "Content-Length": str(len(data))})

    from app.files import storage
    from app.files.router import _safe_download_mime

    if not row.storage_path:
        raise DavError(404)
    path = storage.absolute_path(row.storage_path)
    if not path.is_file():
        raise DavError(404, "The file's data is missing.")
    mime = _safe_download_mime(row.mime_type, row.filename)
    if head:
        return Response(status_code=200, media_type=mime, headers={**headers, "Content-Length": str(path.stat().st_size)})
    if request.headers.get("x-promptly-accel") == "1":
        # nginx serves the bytes from its read-only mount: Range, sendfile,
        # nothing through this worker.
        rel = path.resolve().relative_to(storage.UPLOAD_ROOT.resolve()).as_posix()
        headers["X-Accel-Redirect"] = urllib.parse.quote("/_blobs/" + rel, safe="/")
        return Response(status_code=200, media_type=mime, headers=headers)
    return FileResponse(path=str(path), media_type=mime, headers=headers)


async def _listing_page(tree: Tree, node: Node) -> Response:
    """A folder opened in a browser: a plain list (the app is the place to browse)."""
    import html

    items = await children(tree.db, tree.user, _container(node))
    lines = [
        f'<li><a href="{html.escape(href_for(node.segs + [n], isinstance(c, FileFolder)))}">{html.escape(n)}{"/" if isinstance(c, FileFolder) else ""}</a></li>'
        for n, c in items
    ]
    title = html.escape("/" + "/".join(node.segs))
    body = f"<!doctype html><meta charset=utf-8><title>{title}</title><h1>{title}</h1><ul>{''.join(lines)}</ul>"
    return Response(content=body, media_type="text/html; charset=utf-8", headers={"Content-Security-Policy": "default-src 'none'"})


async def do_put(request: Request, tree: Tree, segs: list[str]) -> Response:
    from app.files import blobstore, disk_guard
    from app.files.router import ingest_staged
    from app.files.tus_hooks import large_max_bytes

    if not segs:
        raise DavError(405, "That's a folder.")
    if request.headers.get("content-range"):
        raise DavError(400, "Partial PUTs aren't supported.")
    name = segs[-1]
    parent = await tree.parent_of(segs)
    node = await tree.resolve(segs)
    if _JUNK.match(name):
        # Finder's resource forks and folder settings: taken and dropped.
        async for _chunk in request.stream():
            pass
        return Response(status_code=201)
    if node is not None and node.is_collection:
        raise DavError(405, "That's a folder.")
    if node is not None and node.read_only:
        raise DavError(403, "This is an export of a document, sheet or whiteboard — edit it in Promptly.")
    _writable_parent(parent)
    tokens = await check_if(request, tree, node, segs)
    if node is not None:
        tag = etag(node)
        if_match = request.headers.get("if-match")
        if if_match and if_match.strip() != "*" and tag not in [t.strip() for t in if_match.split(",")]:
            raise DavError(412, "It changed since you last read it.")
        if request.headers.get("if-none-match", "").strip() == "*":
            raise DavError(412, "It already exists.")
    elif request.headers.get("if-match"):
        raise DavError(412, "There's nothing there to match.")
    require_unlocked(tree.user.id, segs, tokens)
    if node is None:
        _clean_name(name)

    cap = await large_max_bytes(tree.db)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > cap:
        raise DavError(413, f"That's larger than the {cap / 1024 ** 3:.3g} GB limit for one upload.")
    try:
        disk_guard.ensure_room(int(declared) if declared and declared.isdigit() else 0)
    except disk_guard.DiskFull as e:
        raise DavError(507, str(e)) from None
    try:
        staged = await blobstore.stage_body(request.stream(), size_limit=cap)
    except blobstore.BlobTooLarge:
        raise DavError(413, f"That's larger than the {cap / 1024 ** 3:.3g} GB limit for one upload.") from None
    try:
        _verify_checksum(request, staged)
        mtime_ms = await _parse_mtime(request)
        if node is not None and node.file.content_sha256 == staged.sha256 and node.file.size_bytes == staged.size:
            # The same bytes again (a reinstalled phone app re-sending its
            # camera roll): nothing to store, no version — keep the date.
            if mtime_ms is not None:
                from app.files.router import client_mtime_from

                node.file.client_mtime = client_mtime_from(mtime_ms)
                await tree.db.commit()
            headers = {"OC-FileId": node.file.id.hex, "ETag": f'"{staged.sha256}"'}
            if mtime_ms is not None:
                headers["X-OC-MTime"] = "accepted"
            return Response(status_code=204, headers=headers)
        try:
            out = await ingest_staged(
                tree.db, request=request, user=tree.user, staged=staged, filename=name if node is None else node.file.filename,
                declared_mime=request.headers.get("content-type"), scope="mine", folder_id=_container(parent),
                route=None, on_conflict="allow", workspace_id=None, last_modified=mtime_ms,
                replace_row=node.file if node is not None else None, version_source="dav", allow_empty=True,
                exact_folder=True,
            )
        except HTTPException as e:
            raise _http(e, quota_is_507=True) from None
    finally:
        blobstore.blobstore.discard(staged)
    row = await tree.db.get(UserFile, out.id)
    headers = {"OC-FileId": out.id.hex}
    if row is not None and row.content_sha256:
        headers["ETag"] = f'"{row.content_sha256}"'
    if mtime_ms is not None:
        headers["X-OC-MTime"] = "accepted"
    return Response(status_code=201 if node is None else 204, headers=headers)


def _verify_checksum(request: Request, staged) -> None:  # noqa: ANN001 — blobstore.Staged
    """``OC-Checksum: SHA1:<hex>`` (rclone, ownCloud clients): what arrived
    must be what was sent."""
    raw = request.headers.get("oc-checksum")
    if not raw:
        return
    for part in raw.split():
        algo, _, value = part.partition(":")
        mine = {"sha1": staged.sha1, "sha256": staged.sha256, "md5": staged.md5}.get(algo.strip().lower())
        if mine is not None and value.strip().lower() != mine:
            raise DavError(400, f"The {algo} checksum doesn't match what arrived.")


async def do_mkcol(request: Request, tree: Tree, segs: list[str]) -> Response:
    from app.files.router import create_folder
    from app.files.schemas import FolderCreateRequest

    if await request.body():
        raise DavError(415, "MKCOL takes no body.")
    if not segs or await tree.resolve(segs) is not None:
        raise DavError(405, "Something's already there.")
    parent = await tree.parent_of(segs)
    _writable_parent(parent)
    tokens = await check_if(request, tree, None, segs)
    require_unlocked(tree.user.id, segs, tokens)
    name = _clean_name(segs[-1])
    try:
        await create_folder(FolderCreateRequest(name=name, parent_id=_container(parent), scope="mine"), db=tree.db, user=tree.user)
    except HTTPException as e:
        raise _http(e) from None
    return Response(status_code=201)


async def do_delete(request: Request, tree: Tree, segs: list[str]) -> Response:
    from app.files.router import trash_file, trash_folder

    if not segs:
        raise DavError(403, "That's your whole drive.")
    if _JUNK.match(segs[-1]):
        return Response(status_code=204)
    node = await tree.resolve(segs)
    if node is None:
        raise DavError(404)
    if not tree.can_delete:
        # Kept: deleting on the device only frees space there.
        return Response(status_code=204)
    if node.in_workspace or (node.kind == "file" and node.read_only):
        raise DavError(403, "Delete this in Promptly.")
    tokens = await check_if(request, tree, node, segs)
    require_unlocked(tree.user.id, segs, tokens, inside=node.is_collection)
    try:
        if node.kind == "folder":
            await trash_folder(node.folder.id, db=tree.db, user=tree.user)
        else:
            await trash_file(node.file.id, db=tree.db, user=tree.user)
    except HTTPException as e:
        raise _http(e) from None
    locks.move(tree.user.id, segs)
    return Response(status_code=204)


async def do_move_copy(request: Request, tree: Tree, segs: list[str], *, copy: bool) -> Response:
    if not segs:
        raise DavError(403, "That's your whole drive.")
    src = await tree.resolve(segs)
    if src is None:
        raise DavError(404)
    dst_segs = _destination(request)
    if not dst_segs or dst_segs == segs:
        raise DavError(403, "The source and destination are the same.")
    if src.is_collection and _key(dst_segs)[: len(segs)] == _key(segs) and len(dst_segs) > len(segs):
        raise DavError(403, "A folder can't go inside itself.")
    dst_parent = await tree.parent_of(dst_segs)
    _writable_parent(dst_parent)
    dst = await tree.resolve(dst_segs)
    if dst is not None and dst.file is not None and src.file is not None and dst.file.id == src.file.id:
        dst = None  # only the case of the name changes
    if dst is not None and not _overwrite(request):
        raise DavError(412, "Something's already there.")
    if not copy and (src.in_workspace or (src.kind == "file" and src.read_only)):
        raise DavError(403, "Move this in Promptly.")
    tokens = await check_if(request, tree, src, segs)
    if not copy:
        require_unlocked(tree.user.id, segs, tokens, inside=src.is_collection)
    require_unlocked(tree.user.id, dst_segs, tokens, inside=dst is not None and dst.is_collection)
    if dst is not None and dst.read_only:
        raise DavError(403, "That's an export of a document, sheet or whiteboard — it can't be replaced.")
    new_name = dst_segs[-1]
    if dst is None:
        _clean_name(new_name)

    try:
        if copy:
            await _copy(request, tree, src, dst, dst_parent, new_name)
        else:
            await _move(tree, src, dst, dst_parent, new_name)
    except HTTPException as e:
        raise _http(e, quota_is_507=True) from None
    if not copy:
        locks.move(tree.user.id, segs)
    return Response(status_code=204 if dst is not None else 201)


async def _trash(tree: Tree, node: Node) -> None:
    from app.files.router import trash_file, trash_folder

    if node.kind == "folder":
        await trash_folder(node.folder.id, db=tree.db, user=tree.user)
    else:
        await trash_file(node.file.id, db=tree.db, user=tree.user)
    locks.move(tree.user.id, node.segs)


async def _move(tree: Tree, src: Node, dst: Node | None, dst_parent: Node, new_name: str) -> None:
    from app.files.router import update_file, update_folder
    from app.files.schemas import FileUpdateRequest, FolderUpdateRequest

    if dst is not None and dst.kind == "file" and src.kind == "file":
        # Saving safely — write a temp file, move it over the real one: the
        # real file keeps its history, shares and links; its old bytes
        # become a version.
        await _take_bytes(tree, target=dst.file, donor=src.file)
        return
    if dst is not None:
        await _trash(tree, dst)
    target = _container(dst_parent)
    if src.kind == "folder":
        payload = FolderUpdateRequest(
            name=new_name if new_name != src.folder.name else None,
            parent_id=target, move_to_root=target is None and src.folder.parent_id is not None,
        )
        if payload.parent_id == src.folder.parent_id:
            payload.parent_id, payload.move_to_root = None, False
        await update_folder(src.folder.id, payload, db=tree.db, user=tree.user)
    else:
        payload = FileUpdateRequest(
            filename=new_name if new_name != src.file.filename else None,
            folder_id=target if target != src.file.folder_id else None,
            move_to_root=target is None and src.file.folder_id is not None,
        )
        await update_file(src.file.id, payload, db=tree.db, user=tree.user)


async def _take_bytes(tree: Tree, *, target: UserFile, donor: UserFile) -> None:
    """``target`` takes ``donor``'s bytes as its new version; ``donor``'s row
    goes (its blob is now the target's — nothing is deleted)."""
    from app.files.blob_versions import refresh_after_change, replace_bytes
    from app.files.purge import purge_file_rows

    if donor.source_kind is not None:
        raise DavError(403, "Only an uploaded file can replace another.")
    # No new bytes: the donor's are already counted, and the target's old
    # ones were too — now as a version.
    sha256, sha1, md5 = donor.content_sha256, donor.sha1, donor.md5
    await replace_bytes(
        tree.db, target, new_path=donor.storage_path, size=donor.size_bytes, source="dav",
        author_id=tree.user.id, mime=donor.mime_type,
    )
    if sha256:
        target.content_sha256, target.sha1, target.md5 = sha256, sha1, md5
    target.client_mtime = donor.client_mtime or target.client_mtime
    await purge_file_rows(tree.db, [donor])
    await tree.db.commit()
    await refresh_after_change(target)
    await tree.db.commit()


async def _copy(request: Request, tree: Tree, src: Node, dst: Node | None, dst_parent: Node, new_name: str) -> None:
    if src.kind == "file":
        if dst is not None and dst.is_collection:
            await _trash(tree, dst)
            dst = None
        await _copy_file(request, tree, src.file, _container(dst_parent), new_name, replace=dst.file if dst else None)
        return
    depth = (request.headers.get("depth") or "infinity").strip().lower()
    if depth not in ("0", "infinity"):
        raise DavError(400, "A folder is copied with Depth: 0 or infinity.")
    if dst is not None:
        await _trash(tree, dst)
    plan = await _copy_plan(tree, src.folder.id, whole=depth == "infinity")
    await _copy_tree(request, tree, plan, _container(dst_parent), new_name)


async def _copy_file(request: Request, tree: Tree, row: UserFile, folder_id, name: str, *, replace: UserFile | None) -> None:  # noqa: ANN001
    from app.files import blobstore, storage
    from app.files.router import ingest_staged

    if row.source_kind is not None or not row.storage_path:
        return  # an export: not something a copy can make (copy it in Promptly)
    path = storage.absolute_path(row.storage_path)

    def stage():  # noqa: ANN202
        with open(path, "rb") as fh:
            return blobstore.blobstore.stage_stream(fh, size_limit=int(row.size_bytes or 0) + 1)

    staged = await asyncio.to_thread(stage)
    try:
        await ingest_staged(
            tree.db, request=request, user=tree.user, staged=staged, filename=replace.filename if replace else name,
            declared_mime=row.mime_type, scope="mine", folder_id=folder_id, route=None, on_conflict="allow",
            workspace_id=None, last_modified=int(row.client_mtime.timestamp() * 1000) if row.client_mtime else None,
            replace_row=replace, version_source="dav", allow_empty=True, exact_folder=True,
        )
    finally:
        blobstore.blobstore.discard(staged)


async def _copy_plan(tree: Tree, folder_id: uuid.UUID, *, whole: bool) -> list[tuple[list[str], Any]]:
    """Everything under a folder as (relative path, row), folders first."""
    out: list[tuple[list[str], Any]] = []
    frontier = [([], folder_id)]
    while frontier and whole:
        rel, fid = frontier.pop(0)
        for name, child in await children(tree.db, tree.user, fid):
            out.append((rel + [name], child))
            if isinstance(child, FileFolder):
                frontier.append((rel + [name], child.id))
            if len(out) > COPY_MAX_ITEMS:
                raise DavError(507, f"That folder has more than {COPY_MAX_ITEMS} things in it — copy it in parts.")
    return out


async def _copy_tree(request: Request, tree: Tree, plan, parent_id, name: str) -> None:  # noqa: ANN001
    from app.files.router import create_folder
    from app.files.schemas import FolderCreateRequest

    top = await create_folder(FolderCreateRequest(name=name, parent_id=parent_id, scope="mine"), db=tree.db, user=tree.user)
    made: dict[tuple[str, ...], uuid.UUID] = {(): top.id}
    for rel, row in plan:
        into = made[tuple(rel[:-1])]
        if isinstance(row, FileFolder):
            sub = await create_folder(FolderCreateRequest(name=row.name, parent_id=into, scope="mine"), db=tree.db, user=tree.user)
            made[tuple(rel)] = sub.id
        else:
            await _copy_file(request, tree, row, into, row.filename, replace=None)


async def do_proppatch(request: Request, tree: Tree, segs: list[str]) -> Response:
    node = await tree.resolve(segs)
    if node is None:
        raise DavError(404)
    tokens = await check_if(request, tree, node, segs)
    require_unlocked(tree.user.id, segs, tokens)
    doc = _parse(await request.body())
    if doc is None or doc.tag != _q(DAV_NS, "propertyupdate"):
        raise DavError(400, "Expected a propertyupdate.")
    results: list[tuple[str, str]] = []
    when: datetime | None = None
    for action in doc:
        prop = action.find(_q(DAV_NS, "prop"))
        if prop is None:
            continue
        for p in prop:
            if p.tag in (_q(DAV_NS, "getlastmodified"), _q(MS_NS, "Win32LastModifiedTime")) and action.tag == _q(DAV_NS, "set"):
                when = _parse_http_date(p.text or "")
                results.append((p.tag, "200 OK" if when is not None else "409 Conflict"))
            elif p.tag.startswith("{" + MS_NS + "}"):
                results.append((p.tag, "200 OK"))  # Windows' other times and attributes: taken, not kept
            else:
                results.append((p.tag, "403 Forbidden"))
    failed = any(not s.startswith("200") for _t, s in results)
    if failed:
        results = [(t, s if not s.startswith("200") else "424 Failed Dependency") for t, s in results]
    elif when is not None and node.file is not None and not node.read_only:
        node.file.client_mtime = when
        await tree.db.commit()
    resp = ET.Element(_q(DAV_NS, "response"))
    ET.SubElement(resp, _q(DAV_NS, "href")).text = node.href
    for status in sorted({s for _t, s in results}):
        stat = ET.SubElement(resp, _q(DAV_NS, "propstat"))
        prop_el = ET.SubElement(stat, _q(DAV_NS, "prop"))
        for t, s in results:
            if s == status:
                ET.SubElement(prop_el, t)
        ET.SubElement(stat, _q(DAV_NS, "status")).text = f"HTTP/1.1 {status}"
    return multistatus([resp])


def _parse_http_date(text: str) -> datetime | None:
    from email.utils import parsedate_to_datetime

    try:
        dt = parsedate_to_datetime(text.strip())
    except (TypeError, ValueError, IndexError):
        try:
            dt = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def do_lock(request: Request, tree: Tree, segs: list[str]) -> Response:
    node = await tree.resolve(segs)
    doc = _parse(await request.body())
    timeout = _timeout(request.headers.get("timeout"))
    user_id = tree.user.id
    if doc is None:
        # A refresh: the lock named in the If header.
        header = request.headers.get("if") or ""
        token = next((v for _r, lists in _parse_if(header) for c in lists for _n, k, v in c if k == "token"), None) if header else None
        lock = locks.get(token) if token else None
        if lock is None or lock.user_id != user_id or not lock.covers(_key(segs)):
            raise DavError(412, "That lock isn't held here.", condition="lock-token-matches-request-uri")
        lock.timeout = timeout
        lock.expires = time.monotonic() + timeout
        return _lock_response(lock, status=200)
    if doc.tag != _q(DAV_NS, "lockinfo"):
        raise DavError(400, "Expected a lockinfo.")
    scope = doc.find(_q(DAV_NS, "lockscope"))
    exclusive = scope is None or scope.find(_q(DAV_NS, "shared")) is None
    owner_el = doc.find(_q(DAV_NS, "owner"))
    owner = ET.tostring(owner_el, encoding="utf-8") if owner_el is not None else None
    infinite = (request.headers.get("depth") or "infinity").strip().lower() == "infinity"
    if node is None:
        await tree.parent_of(segs)  # 409 if there's nowhere for it
    if node is not None and node.in_workspace:
        raise DavError(403, "That belongs to a workspace.")
    for other in locks.covering(user_id, segs) + (locks.under(user_id, segs) if infinite else []):
        if exclusive or other.exclusive:
            raise DavError(423, "It's already locked.", condition="no-conflicting-lock")
    lock = Lock(
        token=f"opaquelocktoken:{uuid.uuid4()}", user_id=user_id, segs=segs, exclusive=exclusive,
        infinite=infinite and (node is None or node.is_collection), owner=owner,
        expires=time.monotonic() + timeout, timeout=timeout,
    )
    locks.add(lock)
    # An unmapped URL is locked without making anything (a lock-null
    # resource); the PUT that follows makes the file.
    return _lock_response(lock, status=201 if node is None else 200)


def _lock_response(lock: Lock, *, status: int) -> Response:
    prop = ET.Element(_q(DAV_NS, "prop"))
    ET.SubElement(prop, _q(DAV_NS, "lockdiscovery")).append(lock.active_xml())
    body = b'<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(prop, encoding="utf-8")
    return Response(content=body, status_code=status, media_type="application/xml; charset=utf-8", headers={"Lock-Token": f"<{lock.token}>"})


async def do_unlock(request: Request, tree: Tree, segs: list[str]) -> Response:
    token = (request.headers.get("lock-token") or "").strip().strip("<>")
    lock = locks.get(token) if token else None
    if lock is None or lock.user_id != tree.user.id or not lock.covers(_key(segs)):
        raise DavError(409, "That lock isn't held here.", condition="lock-token-matches-request-uri")
    locks.remove(token)
    return Response(status_code=204)


# ---------------------------------------------------------------- the route


def _error(e: DavError) -> Response:
    headers = {}
    if e.condition:
        root = ET.Element(_q(DAV_NS, "error"))
        ET.SubElement(root, _q(DAV_NS, e.condition))
        body = b'<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding="utf-8")
        return Response(content=body, status_code=e.status, media_type="application/xml; charset=utf-8", headers=headers)
    return Response(content=e.message or "", status_code=e.status, media_type="text/plain; charset=utf-8", headers=headers)


@router.api_route("", methods=METHODS, include_in_schema=False)
@router.api_route("/{path:path}", methods=METHODS, include_in_schema=False)
async def dav(request: Request, path: str = "", db: AsyncSession = Depends(get_db)) -> Response:
    from app.auth.basic import client_ip, user_from_basic

    method = request.method.upper()
    if method == "OPTIONS":
        return await do_options(request)
    user, password = await user_from_basic(
        db, request.headers.get("authorization"), scope="dav:read" if method in _READ_METHODS else "dav:write",
        ip=client_ip(request), with_password=True,
    )
    tree = Tree(db, user, can_delete="dav:delete" in (password.scopes or []))
    try:
        segs = split_path(path)
        if method == "PROPFIND":
            return await do_propfind(request, tree, segs)
        if method in ("GET", "HEAD"):
            return await do_get(request, tree, segs, head=method == "HEAD")
        if method == "PUT":
            return await do_put(request, tree, segs)
        if method == "MKCOL":
            return await do_mkcol(request, tree, segs)
        if method == "DELETE":
            return await do_delete(request, tree, segs)
        if method in ("MOVE", "COPY"):
            return await do_move_copy(request, tree, segs, copy=method == "COPY")
        if method == "PROPPATCH":
            return await do_proppatch(request, tree, segs)
        if method == "LOCK":
            return await do_lock(request, tree, segs)
        if method == "UNLOCK":
            return await do_unlock(request, tree, segs)
    except DavError as e:
        if e.status >= 500 and e.status != 507:
            logger.warning("dav %s %s -> %s %s", method, path, e.status, e.message)
        return _error(e)
    return Response(status_code=405)


__all__ = ["PREFIX", "locks", "router"]
