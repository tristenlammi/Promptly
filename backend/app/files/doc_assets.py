"""Inline document images and audio: stable references, short-lived links
(WP-4.6, R-228).

An uploaded picture used to be embedded as
``/api/documents/{doc}/assets/{asset}?sig=HMAC(SECRET_KEY)`` — a permanent
credential baked into the document. Rotating the key broke every image on
the instance, a copied note pointed at the original's assets (and stopped
working for anyone who couldn't open the original), and a former
collaborator's copy of the link worked forever.

Now the document holds only the *path* (``/api/documents/{doc}/assets/
{asset}``) and whoever displays it gets a short-lived signed link:

* the editor and previews ask :func:`sign_paths` (via
  ``POST /api/documents/asset-links``), authorised by read access to the
  document the asset belongs to;
* share pages and exports sign (or inline) server-side.

Old links already in documents keep working (their ``?sig=`` still
verifies) and are re-signed the same way. An asset's identity is its path;
whatever query string a stored URL carries is ignored when it's resolved.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time
import uuid
from typing import Any

from app.config import get_settings

settings = get_settings()

# Any URL of a document asset, with or without a query string.
ASSET_URL_RE = re.compile(
    r"/api/documents/(?P<doc>[0-9a-fA-F-]{36})/assets/(?P<asset>[0-9a-fA-F-]{36})(?P<query>\?[^\"'\s<>)]*)?"
)
SIGNED_TTL_SECONDS = 6 * 3600


def stable_path(document_id: uuid.UUID | str, asset_id: uuid.UUID | str) -> str:
    return f"/api/documents/{document_id}/assets/{asset_id}"


def _legacy_sig(asset_id: uuid.UUID, document_id: uuid.UUID) -> str:
    message = f"asset:{asset_id}:{document_id}".encode("utf-8")
    return hmac.new(settings.SECRET_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _sig(asset_id: uuid.UUID, document_id: uuid.UUID, exp: int) -> str:
    message = f"asset:v2:{asset_id}:{document_id}:{exp}".encode("utf-8")
    return hmac.new(settings.SECRET_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()


def signed_url(document_id: uuid.UUID, asset_id: uuid.UUID, *, ttl: int = SIGNED_TTL_SECONDS) -> str:
    """A link that works for ``ttl`` seconds (rounded up to the hour, so the
    same asset gets the same URL for a while and stays browser-cached)."""
    exp = (int(time.time()) // 3600 + 1) * 3600 + ttl
    return f"{stable_path(document_id, asset_id)}?exp={exp}&sig={_sig(asset_id, document_id, exp)}"


def verify(document_id: uuid.UUID, asset_id: uuid.UUID, sig: str, exp: int | None) -> bool:
    if exp is None:
        # A link minted before R-228 — permanent, until the key changes.
        return hmac.compare_digest(_legacy_sig(asset_id, document_id), sig or "")
    if exp < time.time():
        return False
    return hmac.compare_digest(_sig(asset_id, document_id, exp), sig or "")


def sign_in_html(html_text: str, document_id: uuid.UUID) -> str:
    """Give every asset link of *this* document a fresh short-lived
    signature (for share pages, where there's no signed-in reader)."""
    doc = str(document_id).lower()

    def repl(m: re.Match) -> str:
        if m["doc"].lower() != doc:
            return m.group(0)
        try:
            return signed_url(uuid.UUID(m["doc"]), uuid.UUID(m["asset"]))
        except ValueError:
            return m.group(0)

    return ASSET_URL_RE.sub(repl, html_text or "")


# ------------------------------------------------------------------ copies


def _rewrite(text: str, src_doc: str, new_doc: str, mapping: dict[str, str]) -> str:
    def repl(m: re.Match) -> str:
        if m["doc"].lower() != src_doc:
            return m.group(0)
        new_asset = mapping.get(m["asset"].lower())
        return stable_path(new_doc, new_asset) if new_asset else m.group(0)

    return ASSET_URL_RE.sub(repl, text)


def rewrite_update(update: bytes, src_doc: uuid.UUID, new_doc: uuid.UUID, mapping: dict[str, str]) -> bytes:
    """The Y.Doc ``update`` with every ``src`` pointing at ``src_doc``'s
    assets re-pointed at the copies under ``new_doc``."""
    if not update or not mapping:
        return update
    from pycrdt import Doc, XmlElement, XmlFragment

    doc = Doc()
    doc.apply_update(update)
    frag = doc.get("default", type=XmlFragment)
    s, n = str(src_doc).lower(), str(new_doc).lower()

    def walk(node: Any) -> None:
        for child in list(getattr(node, "children", []) or []):
            if isinstance(child, XmlElement):
                src = child.attributes.get("src") if hasattr(child.attributes, "get") else None
                if isinstance(src, str) and ASSET_URL_RE.search(src):
                    new = _rewrite(src, s, n, mapping)
                    if new != src:
                        child.attributes["src"] = new
                walk(child)

    walk(frag)
    return doc.get_update()


async def copy_assets(db, src_doc_id: uuid.UUID, new_doc) -> dict[str, str]:
    """Copy ``src_doc_id``'s live assets under ``new_doc`` (rows and blobs).
    Returns old asset id → new asset id. Flushed, not committed."""
    import shutil

    from sqlalchemy import select

    from app.files.generated_kinds import GeneratedKind
    from app.files.models import UserFile
    from app.files.storage import absolute_path, storage_path_for

    rows = (
        await db.execute(
            select(UserFile).where(
                UserFile.source_file_id == src_doc_id,
                UserFile.source_kind == GeneratedKind.DOCUMENT_ASSET.value,
                UserFile.trashed_at.is_(None),
            )
        )
    ).scalars().all()
    mapping: dict[str, str] = {}
    for a in rows:
        src_path = absolute_path(a.storage_path)
        if not src_path.exists():
            continue
        import os

        new_id = uuid.uuid4()
        storage = storage_path_for(new_doc.user_id, new_id, os.path.splitext(a.filename or "")[1].lower())
        dest = absolute_path(storage)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_path, dest)
        copy = UserFile(
            id=new_id,
            user_id=new_doc.user_id,
            folder_id=None,
            filename=a.filename,
            original_filename=a.filename,
            mime_type=a.mime_type,
            size_bytes=a.size_bytes,
            storage_path=storage,
            source_kind=GeneratedKind.DOCUMENT_ASSET.value,
            source_file_id=new_doc.id,
            content_sha256=a.content_sha256,
            sha1=a.sha1,
            md5=a.md5,
            verified_at=a.verified_at,
        )
        db.add(copy)
        await db.flush()
        mapping[str(a.id).lower()] = str(copy.id)
    return mapping


async def relink_copy(db, src_doc_id: uuid.UUID, new_doc) -> None:
    """After a document is copied (state + HTML already written): give the
    copy its own assets, so it works for people who can't open the
    original, and survives the original being deleted."""
    from app.files.models import DocumentState
    from app.files.storage import absolute_path

    mapping = await copy_assets(db, src_doc_id, new_doc)
    if not mapping:
        return
    state = await db.get(DocumentState, new_doc.id)
    if state is not None and state.yjs_update:
        state.yjs_update = rewrite_update(bytes(state.yjs_update), src_doc_id, new_doc.id, mapping)
    path = absolute_path(new_doc.storage_path)
    try:
        html_text = path.read_text(encoding="utf-8")
    except OSError:
        return
    path.write_text(_rewrite(html_text, str(src_doc_id).lower(), str(new_doc.id).lower(), mapping), encoding="utf-8")


__all__ = [
    "ASSET_URL_RE",
    "relink_copy",
    "sign_in_html",
    "signed_url",
    "stable_path",
    "verify",
]
