"""Stable identifiers for the ``files.source_kind`` column.

Treat these strings as part of the schema: a tool that writes a
``markdown_source`` row, an editor that updates one, and a re-render
path that overwrites the matching ``rendered_pdf`` row all key on these
values. Renaming one would require a data migration.

Kept in its own module (rather than next to the ORM model or inside
``app.chat.tools``) so the migration code, the storage helpers, the
chat tools, *and* the eventual editor router can all import it without
pulling in the larger files / chat layers.
"""
from __future__ import annotations

from enum import Enum


class GeneratedKind(str, Enum):
    """Provenance of an AI-generated file row."""

    # Source-of-truth Markdown for a document the assistant authored.
    # Edited directly by the Phase A3 side-panel editor; re-rendered to
    # the linked PDF when the user saves.
    MARKDOWN_SOURCE = "markdown_source"

    # PDF rendered from a ``MARKDOWN_SOURCE`` row. ``source_file_id``
    # on this row points back at the Markdown so the renderer can find
    # the source again on edit.
    RENDERED_PDF = "rendered_pdf"

    # Drive Document — user-authored rich-text doc backed by a Y.js
    # CRDT. The file blob on disk holds the rendered HTML snapshot
    # (kept current by the Hocuspocus snapshot endpoint); the CRDT
    # itself lives in ``document_state``. These rows *do* show up in
    # Drive listings.
    DOCUMENT = "document"

    # Inline media (image / audio) uploaded from inside a document
    # editor session. ``source_file_id`` points at the owning
    # ``DOCUMENT`` row so cascading trashes + quota accounting stay
    # sane. These rows are intentionally *hidden* from Drive listings
    # — they only resolve via the asset download URL embedded in the
    # document's HTML.
    DOCUMENT_ASSET = "document_asset"


__all__ = ["GeneratedKind"]
