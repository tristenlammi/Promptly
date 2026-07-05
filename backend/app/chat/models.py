"""Chat conversations + messages ORM models."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import CreatedAtMixin, TimestampMixin, UUIDPKMixin


class Conversation(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "conversations"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Model reference is stored as a free-form identifier (e.g. "anthropic/claude-3.5-sonnet")
    # so we can keep conversations around even if a provider is deleted.
    model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True
    )

    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    starred: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    # Three-mode preference (Phase D1):
    #   "off"    — never search the web on this conversation
    #   "auto"   — expose the ``web_search`` tool, model decides per turn
    #   "always" — synthesise a forced ``web_search`` call before every
    #              assistant reply (the search appears in the chat as a
    #              tool chip, identical to the auto-mode UX)
    # Stored as a short string instead of a Postgres ENUM so we can add
    # new modes (``"deep"`` etc.) without DDL pain. The router defends
    # against unknown values by falling back to ``"off"``.
    web_search_mode: Mapped[str] = mapped_column(
        String(8), nullable=False, default="off", server_default="off"
    )

    # DeepSeek-only reasoning knob. The chat router attaches
    # ``thinking`` + ``reasoning_effort`` request fields to the
    # outbound payload when the active provider is DeepSeek and this
    # column is non-NULL; otherwise it stays out of the wire shape so
    # non-DeepSeek providers don't choke on unknown params.
    #   * NULL    — fall back to the provider's API-side default. Also
    #               the right state for every non-DeepSeek conversation.
    #   * "off"   — send ``thinking: {"type": "disabled"}`` (fast,
    #               non-thinking V4).
    #   * "low" / "medium" / "high" — send ``thinking: enabled`` plus
    #               the matching ``reasoning_effort`` value.
    # Free-form ``varchar(8)`` instead of a Postgres ENUM so a future
    # DeepSeek API revision (or a different provider that adopts the
    # same shape) can introduce new effort levels without DDL.
    reasoning_effort: Mapped[str | None] = mapped_column(
        String(8), nullable=True, default=None
    )

    # Phase 1 — per-conversation custom instructions / system prompt.
    # A free-text steer ("answer concisely", "you're a Rust expert")
    # the owner can set without spinning up a Project. Merged into the
    # outbound system prompt by the chat router (it takes precedence
    # over the project-level prompt but sits under tool/personal-context
    # layers). NULL / blank = no per-chat steer.
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Phase 9 — per-conversation memory capture pause. When True, the
    # auto-capture pass is skipped for this chat. Existing memories are
    # still injected normally; this only stops new facts being extracted.
    memory_capture_paused: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # When True the user has renamed the conversation themselves and the
    # server must not auto-regenerate the title after subsequent turns. Set
    # by the title-PATCH endpoint; cleared only if we reset the conversation.
    title_manually_set: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # True once we've re-generated the title with deeper context (around
    # the 5-message mark). One-shot: the first auto-title fires after the
    # opening exchange off thin context; this lets us sharpen it once the
    # conversation has a real shape, without re-titling on every turn.
    title_refined: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Phase 4c — branching. Populated when this chat was forked from
    # another via ``POST /conversations/{id}/branch``. ``ON DELETE
    # SET NULL`` on both FKs (declared in the migration) keeps the
    # branch alive if the source chat is later deleted; the UI just
    # hides the "branched from" chip in that case.
    parent_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    parent_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )
    branched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Phase 2.6 — in-thread regeneration versioning. Points at the
    # currently-visible leaf message; the visible thread is reconstructed
    # by walking ``Message.parent_id`` from this leaf up to the root and
    # reversing. NULL on legacy/empty conversations, in which case the
    # readers fall back to plain ``created_at`` ordering. Self-heals via
    # the 0054 backfill migration. ``SET NULL`` on delete so dropping the
    # leaf row never dangles the FK.
    active_leaf_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Temporary chats (Phase Z1):
    #   * NULL          — permanent (the default; existing chats are all NULL).
    #   * "ephemeral"   — deleted as soon as the user navigates away.
    #                     Hidden from the sidebar listing entirely so they
    #                     can't be re-opened. A 24h backstop ``expires_at``
    #                     guards against orphans if the cleanup DELETE fails.
    #   * "one_hour"    — auto-deleted 1 hour after the last message.
    #                     Visible in the sidebar with a clock badge so the
    #                     user can find them while they're alive. The router
    #                     slides ``expires_at`` forward on every send.
    # Free-text VARCHAR rather than a Postgres ENUM so we can add modes
    # (``"one_day"``? ``"private_session"``?) without DDL pain. Unknown
    # values are treated as permanent at the API boundary.
    temporary_mode: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Workspaces (0027). When non-NULL, this conversation belongs
    # to a workspace: the workspace's system prompt + pinned files are
    # mixed into the context on every send, and the chat shows up
    # under that workspace in the sidebar. NULL means "top-level chat"
    # (today's default). ``ON DELETE SET NULL`` so deleting a workspace
    # doesn't nuke chat history — the chats resurface at top level.
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Compare mode (0029). Non-NULL for every column of a side-by-
    # side comparison; each column is a real conversation driven by
    # the normal send/stream pipeline, just linked together into a
    # group. The sidebar filters non-crowned compare columns out so
    # the main conversation list isn't cluttered with pre-crown
    # drafts. ``ON DELETE SET NULL`` so deleting the group detaches
    # columns rather than cascade-deleting history.
    compare_group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("compare_groups.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Phase C summary cache (migration 0030). Populated lazily by
    # :func:`app.chat.summariser.get_or_generate_summary` the first
    # time another chat references this one via ``@[title](id)``.
    # Treated as stale when the latest message's ``created_at`` is
    # newer than ``summary_generated_at``; the resolver regenerates
    # in-place at that point.
    summary_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Archive (0082). Soft-hide a chat from the main sidebar + global
    # search without deleting it. NULL = active; a set timestamp moves
    # the chat to the dedicated Archive page where it can be read,
    # restored, or permanently deleted.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Chat-as-workspace-context (0090). Opt-in: when a chat lives in a
    # workspace, the user can flip it ON to feed its transcript into the
    # workspace RAG pool (default OFF — chats are scratch space by
    # default). Enabling flattens the transcript into a backing Drive file
    # (``context_file_id``, in the workspace's ``Chats/`` folder) and
    # embeds it like a note; disabling drops the chunks and trashes the
    # file. ``context_index_status`` mirrors the queued/embedding/ready/
    # failed lifecycle other workspace items use, surfaced as the chat's
    # tree chip. NULL on every non-workspace chat.
    context_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    context_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    context_index_status: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    context_indexed_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )

    def __repr__(self) -> str:
        return f"<Conversation id={self.id} title={self.title!r}>"


class CompareGroup(UUIDPKMixin, TimestampMixin, Base):
    """A side-by-side model-comparison session.

    DEPRECATED (Phase 1 cleanup): Compare mode was decommissioned — the
    frontend surface and the ``/api/chat/compare`` router are gone, so
    nothing creates new groups anymore. The model + ``compare_groups``
    table + ``Conversation.compare_group_id`` are kept dormant rather
    than dropped, because the sidebar / @-mention queries still filter
    ``compare_group_id`` to hide any historical uncrowned columns. With
    no creation path, those filters are harmless no-ops for new data.
    A future migration can drop the table + column once the residual
    filters in ``router.py`` are simplified away.

    One group bundles N (2–4) real ``conversations`` rows — one per
    column — and tracks which column the user ultimately "crowned".
    Before crowning, columns are equal peers; after crowning, the
    crowned conversation is treated as a normal chat in the sidebar
    and the losers remain accessible through the Compare archive
    view.
    """

    __tablename__ = "compare_groups"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The original prompt the user typed into the shared composer.
    # Kept for archive preview so the group doesn't need a messages
    # join on listing.
    seed_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    crowned_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<CompareGroup id={self.id} title={self.title!r}>"


class Workspace(UUIDPKMixin, TimestampMixin, Base):
    """A generic workspace bundle for non-Study conversations.

    Holds the shared instructions + pinned files + default model used
    by every chat inside it. Distinct from :class:`StudyProject` —
    Study projects are learning paths with units/exams, workspaces
    are ChatGPT/Claude-style bundles for arbitrary ongoing work.
    """

    __tablename__ = "workspaces"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Shared "instructions" for every chat in the project. Rendered as
    # a ``system`` role message at the top of each send's context so
    # the model obeys them turn-to-turn.
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Optional per-project model override. When NULL we fall back to
    # whatever the user's global picker says at send time.
    default_model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    default_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True
    )
    # NULL = active. A non-NULL timestamp is the single source of
    # truth for "in archive" — same pattern as study_projects.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Opt-in rolling workspace memory (Phase 4). When true, a background
    # job maintains a single pinned "Workspace Memory" file, refreshed
    # from whichever chat in the workspace most recently produced a reply.
    # Off by default — distinct from the manual "Save summary to workspace".
    # Retained as a synced mirror of ``memory_mode`` (== "auto") for any
    # legacy reader; ``memory_mode`` is the source of truth.
    auto_memory_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Tri-state memory mode, mirroring the account-level memory toggle:
    #   "off"    — no workspace memory: not maintained, not injected.
    #   "auto"   — the librarian auto-maintains it (== auto_memory_enabled).
    #   "manual" — used + hand-managed (editor + "save to memory"), but the
    #              librarian never auto-runs.
    memory_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="off", server_default="off"
    )
    # Dedicated model for the workspace-memory "librarian" (summarisation /
    # distillation). Lets the workspace creator pick a model from their own
    # stack — any enabled API model OR a local Ollama model — independent of
    # which chat triggered the refresh. NULL falls back to the workspace's
    # default chat model, then to the triggering conversation's model. This
    # is what keeps memory working on machines that can't run Ollama: pick an
    # API model here (or leave it on the API-backed workspace default).
    memory_model_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    memory_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("model_providers.id", ondelete="SET NULL"), nullable=True
    )
    # Drive folder backing this workspace (Phase 1). Points at the
    # auto-created ``My files / Workspaces / <title>`` folder where the
    # workspace's notes / canvases / uploaded files physically live, so
    # they inherit Drive's preview / search / trash / quota plumbing.
    # NULL only briefly during creation (or for a legacy row that
    # predates folder seeding). ``ON DELETE SET NULL`` so deleting the
    # folder out-of-band never cascade-deletes the workspace.
    root_folder_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("file_folders.id", ondelete="SET NULL"), nullable=True
    )
    # Optional cap on the combined size of the workspace's pinned files
    # (its "drive"). NULL = unlimited; the owner's personal storage quota
    # still applies underneath either way (files live in their bucket).
    storage_quota_bytes: Mapped[int | None] = mapped_column(
        BigInteger, nullable=True
    )
    # Backing Drive file for the flattened *automations* index (Phase 10).
    # Automations (scheduled Tasks homed here) aren't ``workspace_items`` rows,
    # so there's no ``ref_id`` to hang their RAG backing file on — we stash it
    # on the workspace instead. Holds a rendered summary of every automation
    # (name, schedule, prompt, flow node summary) so a chat can answer "what
    # runs on a schedule here?" via retrieval, not just the deterministic map.
    # ``ON DELETE SET NULL`` so trashing the file never cascade-nukes the row.
    automations_text_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )
    # Last workspace-memory regeneration outcome (Phase 10). Previously the
    # librarian swallowed every failure silently; now we stamp the attempt so
    # the overview Memory card can surface "last refresh failed" instead of a
    # stale "Updated 3 days ago". ``memory_last_status`` ∈ {ok, failed,
    # skipped}; ``skipped`` = nothing to distil / no model configured (not an
    # error). ``memory_last_error`` is a short human-readable reason on failure.
    memory_last_status: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    memory_last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    memory_last_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<Workspace id={self.id} title={self.title!r}>"


class WorkspaceItem(UUIDPKMixin, TimestampMixin, Base):
    """A node in a workspace's navigator tree (Phase 1).

    The workspace's left-rail tree is one unified, nestable,
    reorderable list mixing kinds — ``folder`` rows for organisation
    plus the actual work surfaces (``note`` today; ``canvas`` / ``file``
    in later phases). It is the **source of truth for the navigator**,
    which a ``file_folders`` tree can't be because that can't hold
    chats or canvases as first-class nodes.

    Chats are deliberately **not** stored here in Phase 1: they're
    synthesised into the tree at read time from the conversations
    carrying this ``workspace_id``, so a chat always shows up with zero
    sync bookkeeping. (Persisting chat nodes — to drag them into
    folders — is a later refinement.)

    ``ref_id`` points at the backing entity for non-folder kinds: a
    ``files.id`` (a ``source_kind='document'`` note) today. It is
    intentionally **not** a DB FK because it's polymorphic across
    target tables (files now, ``workspace_canvas`` later); the router
    reconciles a dangling ref at read time. ``position`` orders
    siblings as a float so a drag can insert between two neighbours by
    midpoint without renumbering the whole list.
    """

    __tablename__ = "workspace_items"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Folder nesting *within* the workspace. NULL = top level of the
    # tree. ``ON DELETE CASCADE`` so deleting a folder row drops its
    # subtree of item rows in one go (the router trashes the backing
    # blobs first — see the delete endpoint).
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    # 'folder' | 'note' | 'canvas' | 'file'. (Chats are synthesised at
    # read time, never stored, so they never carry this column.)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Backing entity id for non-folder kinds (-> files.id for a note).
    # NULL for folders. Polymorphic, so not a FK.
    ref_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    # Optional emoji or lucide icon name rendered on the tree row.
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Sibling ordering. Float so inserting between two neighbours is a
    # midpoint, never a full renumber. A fresh item lands at the end by
    # taking ``max(sibling positions) + 1``.
    position: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )

    # --- RAG indexing lifecycle (Phase 1b) -------------------------------
    # Per-item index status for note / canvas / file kinds — the same
    # ``queued -> embedding -> ready | failed`` lifecycle the pinned-file
    # chips use, but stored inline here (decision O3) so the tree renders
    # without an extra join. Folder rows leave these NULL.
    indexing_status: Mapped[str | None] = mapped_column(
        String(16), nullable=True
    )
    indexing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    indexed_content_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Soft-archive (workspace navigator). NULL = live in the tree; a set
    # timestamp moves the item (and, for a folder, its whole subtree) to
    # the workspace's Archive section at the bottom of the rail, where it
    # can be restored or permanently deleted. Deleting the workspace still
    # cascades archived rows away like any other.
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Soft-delete staging (0138). "Delete" stamps the item (and its
    # subtree) here instead of destroying it — invisible everywhere
    # (tree, AI map, retrieval, search, overview) but fully restorable
    # from the Trash section until purged (explicitly, or lazily after
    # 30 days). Distinct from ``archived_at``: archive is deliberate
    # put-away, trash is deletion staging.
    trashed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    # "Use as workspace context" — when True (the default) this note/canvas
    # feeds the workspace's shared RAG pool so every chat can draw on it.
    # Flip it off to keep an item in the tree but out of the AI's context
    # (drafts, scratch, sensitive). Embeddings are kept either way so the
    # toggle is instant; injection simply filters disabled items out.
    # Ignored for folders/chats.
    context_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    # Pinned items surface in a "Pinned" quick-access section at the top of
    # the workspace rail (chats reuse ``conversations.pinned``). Purely a
    # navigation convenience — no effect on context/indexing.
    pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # Kind-specific JSON config (0094). Boards use it for the label registry
    # (``{labels: [{id, name, color}]}``) and, later, custom columns. NULL
    # for kinds that don't need it.
    config: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    # --- Visibility (0134) ------------------------------------------------
    # "workspace" (default) = every member sees it. "private" = a
    # creator-only draft: hidden from other members' trees and item
    # fetches, and excluded from the shared RAG pool entirely (the pool
    # is workspace-wide, so a private item can't feed anyone's chats —
    # including the creator's — without leaking through shared surfaces
    # like the map).
    visibility: Mapped[str] = mapped_column(
        String(16), nullable=False, default="workspace", server_default="workspace"
    )
    # Who created the item (0134). Drives private visibility + activity
    # attribution. SET NULL keeps items when an account is deleted.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<WorkspaceItem id={self.id} kind={self.kind} "
            f"title={self.title!r}>"
        )


class WorkspaceItemComment(UUIDPKMixin, TimestampMixin, Base):
    """A comment thread entry on a workspace item (Phase 6 — collab).

    Flat (no threading) — a simple chronological discussion attached to a
    note / canvas / board / sheet so collaborators can leave feedback
    without editing the item itself. ``workspace_id`` is denormalised
    alongside ``item_id`` so listing + access checks don't need a join
    back through the item.
    """

    __tablename__ = "workspace_item_comments"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspace_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Author. ``SET NULL`` so deleting a user keeps the thread readable
    # (rendered as "former member") rather than cascade-deleting history.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # The selected note text this comment anchors to (0134). Text-quote
    # anchoring on purpose: editor marks would be stripped by the
    # bleach/CRDT snapshot pipeline, a quoted string survives anything.
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Non-null = thread resolved; resolved comments collapse in the UI.
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    def __repr__(self) -> str:
        return f"<WorkspaceItemComment id={self.id} item={self.item_id}>"


class WorkspaceProposal(UUIDPKMixin, Base):
    """A chat's *proposed* write into its workspace (Batch 4.1).

    Workspace chats stay read-only by design — instead of writing, the
    AI's workspace tools file one of these and the user applies or
    dismisses it from a preview card in the chat. ``payload`` is
    kind-specific JSON validated at propose time and re-validated at
    apply time (the workspace may have changed in between)."""

    __tablename__ = "workspace_proposals"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    # The chat-turn owner — the only account allowed to apply/dismiss.
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # create_note | add_cards
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # pending | applied | dismissed
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    # Where an applied change landed, for click-through.
    applied_item_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.current_timestamp(),
    )


class WorkspaceTask(UUIDPKMixin, TimestampMixin, Base):
    """A first-class task on a workspace's shared task list.

    This is distinct from the checkboxes a note's TipTap content can hold
    (those still roll up into the overview): a ``WorkspaceTask`` is a
    standalone, workspace-level to-do owned by the project as a whole, not
    by any one note. The overview "home" renders the open ones front and
    centre so the workspace doubles as a lightweight planner.

    Ordering mirrors ``WorkspaceItem``: ``position`` is a float so a task
    can be dropped between two neighbours by midpoint without renumbering.
    """

    __tablename__ = "workspace_tasks"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Which board (a ``kind='board'`` workspace item) this task belongs to
    # (0092). Boards are addable navigator items; deleting a board cascades
    # its tasks. NULL only on legacy rows the 0092 backfill missed.
    board_item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspace_items.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    # Rich card body + checklist (0093). ``description`` is free markdown;
    # ``subtasks`` is a JSON list of ``{id, text, done}``. Both feed the
    # board's RAG text so card detail is searchable.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    subtasks: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )
    # Label ids (0094) referencing the board item's ``config.labels`` registry.
    labels: Mapped[list[str] | None] = mapped_column(JSONB, nullable=True)
    # Links to other navigator items (0097) — a JSON list of
    # ``{item_id, kind, ref_id, title}``. ``title`` is denormalised so the
    # board's RAG text and a freshly-loaded card render without a tree lookup.
    links: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )
    # File attachments (0098) — a JSON list of
    # ``{file_id, filename, mime_type, size_bytes, is_cover}``. Each points at
    # a ``UserFile``; an image flagged ``is_cover`` renders on the card face.
    # Attachment text is embedded into the workspace RAG pool on attach.
    attachments: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB, nullable=True
    )
    # Assignee (0095) — a workspace member. ``SET NULL`` so removing a user
    # doesn't drop the task.
    assignee_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Custom-field values (0138) — ``{field_id: value}`` against the board
    # item's ``config.fields`` registry (definitions live there, like
    # labels, so they stay per-board and travel with duplication/export).
    fields: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    done: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # Kanban column (0091). ``todo`` | ``doing`` | ``done``. Kept in lockstep
    # with ``done`` (done ⇔ status=='done') so the overview's open-task count
    # and any pre-board callers keep working unchanged. ``done`` is the
    # legacy boolean; ``status`` is the source of truth for the board.
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="todo", server_default="todo"
    )
    # Priority is a card accent, not a column. ``low`` | ``medium`` | ``high``.
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, default="medium", server_default="medium"
    )
    # Optional due date/time. The board badges it orange as it approaches and
    # red once overdue. NULL = no due date.
    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    position: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0"
    )
    # When the task was last marked done (cleared when it's reopened).
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Who added it — nullable so a deleted user doesn't drop the task.
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return (
            f"<WorkspaceTask id={self.id} done={self.done} "
            f"title={self.title!r}>"
        )


class WorkspaceTaskComment(UUIDPKMixin, Base):
    """A comment or activity entry on a Kanban card (0096).

    One chronological thread per task mixes user **comments**
    (``kind='comment'``) and auto-logged **activity** (``kind='activity'``
    — "moved to In Progress", "assigned to Jane"). ``author_user_id`` is the
    comment author / change actor.
    """

    __tablename__ = "workspace_task_comments"

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspace_tasks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # ``comment`` (user text) | ``activity`` (system-logged change).
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default="comment", server_default="comment"
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<WorkspaceTaskComment id={self.id} kind={self.kind}>"


class WorkspaceCanvas(UUIDPKMixin, TimestampMixin, Base):
    """An Excalidraw canvas in a workspace (Phase 2).

    Multiplayer from day one: the Excalidraw scene syncs over the **same
    Yjs/Hocuspocus substrate as documents**, persisted here as a CRDT
    update (``yjs_update``) keyed by the ``canvas:<id>`` collab room. The
    columns mirror :class:`app.files.models.DocumentState` (``yjs_update``
    + monotonic ``version``) — the collab server's Database extension
    routes writes here when the room name carries the ``canvas:`` prefix.

    ``content_text`` holds the flattened text of the canvas's shapes,
    pushed by the client on a debounce (``POST /api/canvas/{id}/text``) —
    the backend can't cheaply decode the Excalidraw Yjs schema, so the client
    extracts it. It's mirrored onto a backing Drive text file
    (``text_file_id``) so the canvas participates in workspace retrieval
    through the existing ``knowledge_chunks`` pipeline (which keys on a
    ``UserFile``).
    """

    __tablename__ = "workspace_canvas"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(
        String(255), nullable=False, default="Untitled canvas"
    )
    # Full merged Y.Doc state (Excalidraw scene). Seeded empty at creation so
    # the collab Database extension has a row to upsert; the first session
    # starts from a fresh Y.Doc when this is empty (same as documents).
    yjs_update: Mapped[bytes] = mapped_column(
        LargeBinary, nullable=False, default=b""
    )
    version: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    # Flattened shape text for RAG, pushed by the client. Mirrored onto
    # ``text_file_id`` for the actual embedding.
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Backing Drive text file in the workspace's ``Canvases/`` folder that
    # carries the canvas text into ``knowledge_chunks`` (which requires a
    # ``UserFile``). ``ON DELETE SET NULL`` so a Drive-side delete of the
    # text file doesn't cascade away the canvas.
    text_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return f"<WorkspaceCanvas id={self.id} title={self.title!r}>"


class Spreadsheet(UUIDPKMixin, TimestampMixin, Base):
    """A spreadsheet (Fortune-sheet) — the backing entity for a
    ``kind='sheet'`` workspace item (standalone or a notebook page).

    The spreadsheet analogue of :class:`WorkspaceCanvas`. Persists the
    workbook as ``data`` (the Fortune-sheet JSON: a list of sheet objects)
    saved single-user via a debounced PUT. ``content_text`` holds the
    flattened cell text and ``text_file_id`` the backing Drive text file
    that carries it into ``knowledge_chunks`` — mirroring how a canvas feeds
    workspace RAG. Live collaboration (a ``sheet:<id>`` Yjs room) is a later
    phase; the columns above are all single-user needs for now.
    """

    __tablename__ = "spreadsheets"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        default="Untitled sheet",
        server_default="Untitled sheet",
    )
    # Fortune-sheet workbook JSON: a list of sheet objects ``[{name,
    # celldata, ...}]``. NULL until the first save → the client seeds a
    # blank sheet.
    data: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    # Full merged Y.Doc state for live collaboration, keyed by the
    # ``sheet:<id>`` collab room (mirrors :class:`WorkspaceCanvas`). Seeded
    # empty so the collab Database extension has a row to upsert; the first
    # session starts from a fresh Y.Doc when this is empty.
    yjs_update: Mapped[bytes] = mapped_column(
        LargeBinary, nullable=False, default=b""
    )
    version: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    # Flattened cell text for RAG, pushed by the client on save (mirrors
    # ``WorkspaceCanvas.content_text``).
    content_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Backing Drive text file that carries ``content_text`` into
    # ``knowledge_chunks``. ``ON DELETE SET NULL`` so a Drive-side delete
    # doesn't cascade away the spreadsheet.
    text_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"), nullable=True
    )

    def __repr__(self) -> str:
        return f"<Spreadsheet id={self.id} title={self.title!r}>"


class WorkspaceFile(Base):
    """Pinned-file join row — attaches a :class:`UserFile` to a
    :class:`Workspace` so every new conversation in the workspace
    gets the file auto-attached to its send context.

    Composite PK keeps (workspace, file) unique without a separate row
    id. ``ON DELETE CASCADE`` on both FKs (see the migration) keeps
    the join clean when either side goes away.
    """

    __tablename__ = "workspace_files"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"),
        primary_key=True,
    )
    pinned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    # Who pinned the file (Phase 4). Powers the unpin guard: the workspace
    # owner can unpin anything, but a collaborator can only unpin files
    # they pinned themselves. NULL on pre-0071 rows (owner-only unpin).
    pinned_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # RAG indexing lifecycle — mirrors ``custom_model_files`` so the
    # workspace Files tab can render the same "indexing… → ready / failed"
    # chips. ``queued`` until the background ingester picks the file up;
    # only text-extractable files (PDF / text) are ever indexed (images
    # stay on the attachment/vision path and keep status ``queued``,
    # which the retrieval layer simply ignores).
    indexing_status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="queued",
        server_default="queued",
    )
    indexing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    indexed_content_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    indexed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # "Use as workspace context" — when True (default) the file feeds the
    # workspace RAG pool; flip off to keep it attached but out of the AI's
    # context. Mirrors ``WorkspaceItem.context_enabled`` for notes/canvases.
    context_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )


class ConversationExcludedWorkspaceFile(Base):
    """Per-chat opt-out of a workspace's pinned files (Phase 4).

    Every chat in a workspace sees all pinned files by default. A row here
    means "exclude ``file_id`` from *this* conversation's context" — the
    send path filters it out of both the full-dump attachment set and
    the retrieval candidate set. Composite PK; both FKs cascade so the
    row vanishes when either the chat or the file goes away.
    """

    __tablename__ = "conversation_excluded_workspace_files"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("files.id", ondelete="CASCADE"), primary_key=True
    )


class Message(UUIDPKMixin, CreatedAtMixin, Base):
    __tablename__ = "messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Phase 2.6 — in-thread regeneration versioning. The message that
    # immediately precedes this one in its lineage. Messages sharing a
    # ``parent_id`` are *sibling versions* (e.g. the original answer and
    # a regenerated one, or an original user turn and an edited copy).
    # NULL only for the conversation's root message. ``SET NULL`` on
    # delete so deleting a parent doesn't cascade away its alternatives.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # 'user' | 'assistant' | 'system'
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")

    # DeepSeek thinking-mode chain-of-thought. Captured from
    # ``delta.reasoning_content`` on streamed responses and replayed
    # to DeepSeek on subsequent turns — the API 400s on tool-call
    # follow-up turns when this is missing (see migration
    # ``0049_msgs_reasoning`` for the docs link). Other providers
    # don't emit it (column stays NULL) and don't accept it as input
    # (stripped in ``provider.py`` before send for non-DeepSeek
    # requests). Populated only on ``role = "assistant"`` rows.
    reasoning_content: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Populated when the message was generated with web search on — list of
    # {title, url, snippet} dicts rendered as inline citations.
    sources: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Reserved for study-style messages that embed whiteboard actions; in
    # regular chats this stays null.
    whiteboard_actions: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Per-message performance metrics. Populated only on assistant rows
    # produced via streaming; all null for user / system messages and for
    # any stream that errored before usage was reported.
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Which model produced this (assistant) row — stamped per turn, so each
    # regenerated sibling version records its own model. Lets the UI show
    # "made with X" as the user flicks the ‹2/3› version pager. Raw model id
    # string (the frontend resolves a friendly name); NULL on user/system
    # rows and on assistant rows from before this was tracked.
    model_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Total spend on this single message (completion + tool invocations)
    # in USD micros. ``None`` for messages whose provider didn't report
    # a cost or for non-assistant rows.
    cost_usd_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    # Attachments that the user picked via the paperclip modal. Stored as a
    # frozen list of lightweight metadata dicts (id, filename, mime_type,
    # size_bytes) so the UI can render chips even after the underlying file
    # row has been deleted. Populated only on `role = "user"` messages.
    attachments: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB, nullable=True)

    # Author of the message (Phase 4b — shared conversations). For user
    # rows this is whoever actually pressed Send; for assistant / system
    # rows it stays NULL. Backfilled from ``conversations.user_id`` for
    # legacy rows so the UI's "from Jane" chip on shared chats has a
    # stable value to render. ``ON DELETE SET NULL`` keeps the message
    # if the author account is later removed.
    author_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Stamped by the in-place edit endpoint so the UI can render a
    # subtle "edited" badge on retroactively rewritten assistant
    # replies. NULL on every row that's still in its original state.
    # The edit-and-resend flow does NOT touch this column (it
    # rewrites text + re-streams a fresh assistant turn, which is
    # semantically a regenerated message rather than an edited one).
    edited_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Phase 2.5 — per-response quality signal. ``"up"`` / ``"down"`` /
    # NULL (no rating). Set by the conversation owner via the thumbs
    # affordance on assistant replies; ``feedback_reason`` carries the
    # optional short note captured on a thumbs-down. Both NULL on user /
    # system rows and on un-rated assistant replies.
    feedback: Mapped[str | None] = mapped_column(String(8), nullable=True)
    feedback_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<Message id={self.id} role={self.role}>"


class WorkspaceShare(UUIDPKMixin, TimestampMixin, Base):
    """Invite / membership row for shared workspaces (migration 0031).

    Same ``pending → accepted`` / ``pending → declined`` lifecycle, a
    unique ``(workspace_id, invitee_user_id)`` constraint, and the same
    "delete the row to revoke" policy.

    Semantically this is a *much bigger grant* than a single-chat
    share, though: accepting a workspace invite gives the invitee
    **complete access** to every conversation under that workspace
    (past + future), the workspace's pinned files, and the system-
    prompt settings. The resolver in ``app/chat/shares.py`` walks
    this table as a second path alongside conversation-level
    shares when answering "can this user read this conversation?".
    """

    __tablename__ = "workspace_shares"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    inviter_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    invitee_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", server_default="pending"
    )
    # Permission level once accepted (Phase 4). ``editor`` (default,
    # back-compat with pre-0071 shares) grants full read+write — edit
    # settings, pin/unpin files, add chats. ``viewer`` is read-only.
    # Owner-only actions (delete / archive / manage shares) are never
    # available to either; those gate on ``ws.user_id``.
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, default="editor", server_default="editor"
    )
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "workspace_id",
            "invitee_user_id",
            name="uq_workspace_shares_workspace_invitee",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<WorkspaceShare id={self.id} workspace={self.workspace_id} "
            f"invitee={self.invitee_user_id} status={self.status!r}>"
        )


class MessageEmbedding(TimestampMixin, Base):
    """Per-message embedding vector for semantic conversation search
    (Phase 7).

    One row per indexed message, populated asynchronously by the
    background semantic indexer. Stores the vector in the column matching
    the workspace embedding dim (``embedding_768`` / ``embedding_1536``,
    mirroring ``knowledge_chunks``); those columns are managed via raw
    SQL and intentionally not mapped here. ``content_hash`` lets the
    indexer detect edits and re-embed only what changed.
    """

    __tablename__ = "message_embeddings"

    message_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    content_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    embed_dim: Mapped[int] = mapped_column(Integer, nullable=False)

    def __repr__(self) -> str:
        return (
            f"<MessageEmbedding msg={self.message_id} dim={self.embed_dim}>"
        )
