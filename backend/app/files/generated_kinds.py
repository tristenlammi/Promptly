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


__all__ = ["GeneratedKind"]
