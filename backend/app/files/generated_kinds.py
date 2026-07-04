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

    # Backing text file for a workspace canvas (Phase 2). Holds the
    # flattened shape text the client pushes so the canvas can be
    # embedded into ``knowledge_chunks`` like any other workspace file.
    # Lives in the workspace's ``Canvases/`` Drive folder.
    CANVAS_TEXT = "canvas_text"

    # Backing text file for a workspace chat the user opted into context
    # (0090). Holds the flattened conversation transcript so the chat can
    # be embedded into ``knowledge_chunks`` like a note. Lives in the
    # workspace's ``Chats/`` Drive folder; trashed when the user turns the
    # chat's "Use as workspace context" toggle back off.
    CHAT_TRANSCRIPT = "chat_transcript"

    # Backing text file for a workspace board (Phase 0+). Holds the
    # flattened task list (title / status / priority / due) so the board
    # feeds ``knowledge_chunks`` like a note. Lives in the workspace's
    # ``Boards/`` Drive folder; re-written whenever the board's tasks
    # change. Keyed off the board ``WorkspaceItem.ref_id``.
    BOARD_TEXT = "board_text"

    # Backing text file for a workspace sheet. Holds the client-flattened
    # cell text so the spreadsheet feeds ``knowledge_chunks`` like a note.
    # Lives in the workspace's ``Sheets/`` Drive folder; re-written on save.
    # Keyed off ``Spreadsheet.text_file_id``.
    SHEET_TEXT = "sheet_text"

    # Backing text file for a workspace's *automations* index (Phase 10).
    # Holds a rendered summary of every scheduled Task homed in the
    # workspace (name / schedule / prompt / flow node summary) so chats can
    # retrieve "what runs on a schedule here?". Lives in the workspace's
    # ``Automations/`` Drive folder; keyed off ``Workspace.automations_text_file_id``.
    AUTOMATIONS_TEXT = "automations_text"


__all__ = ["GeneratedKind"]
