import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns2,
  Columns3,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Home,
  Layers,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PenTool,
  Pin,
  Plus,
  Settings,
  Shapes,
  Table2,
  Trash2,
  Zap,
  ZapOff,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { tasksApi } from "@/api/tasks";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { workspacesApi } from "@/api/workspaces";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspaceItem,
  useCreateWorkspaceItem,
  useDeleteWorkspaceItem,
  useMoveWorkspaceItem,
  useSetItemContext,
  useSetItemPinned,
  useUnarchiveWorkspaceItem,
  useUpdateWorkspaceItem,
  useWorkspace,
  useWorkspaceArchive,
} from "@/hooks/useWorkspaces";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";

/**
 * Workspace navigator tree (Phase 1c).
 *
 * Renders the nested folder/note tree plus root-level chats in the left
 * rail. Selection drives the main pane; folders just expand/collapse.
 * Create / rename / delete are wired straight to the items API. Chats are
 * synthesised (no ref row), so they're read-only here — their rename /
 * delete lives in the chat UI.
 *
 * // TODO P1: drag reorder — the /move endpoint supports float positions,
 * // but DnD adds enough surface area that it's deferred for this MVP.
 */
export function WorkspaceNavigatorTree({
  workspaceId,
  tree,
  selectedId,
  onSelect,
  onOpenToSide,
  canEdit,
  onHome,
  atHome,
  onSettings,
  atSettings,
  onNewTask,
}: {
  workspaceId: string;
  tree: WorkspaceItemNode[];
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  /** Open the item alongside the current one (split-screen). */
  onOpenToSide?: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
  /** Jump back to the workspace overview ("home"). */
  onHome?: () => void;
  /** True when the overview is showing (no item selected). */
  atHome?: boolean;
  /** Open the workspace settings page in the main pane. */
  onSettings?: () => void;
  /** True when the settings page is showing. */
  atSettings?: boolean;
  /** Open the "new automation" task form (homed in this workspace). */
  onNewTask?: () => void;
}) {
  const create = useCreateWorkspaceItem(workspaceId);
  const qc = useQueryClient();
  const { data: workspace } = useWorkspace(workspaceId);
  const [creatingChat, setCreatingChat] = useState(false);
  // The item whose "Move to folder" picker is open (null = closed).
  const [movingNode, setMovingNode] = useState<WorkspaceItemNode | null>(null);

  // Pinned items surface in a dedicated section and are pruned from the main
  // tree (each item shows once), mirroring the chat sidebar.
  const pinnedNodes = collectPinned(tree);
  const mainTree = removePinned(tree);

  const handleCreate = async (
    kind: "folder" | "note" | "canvas" | "board" | "sheet" | "container",
    parentId: string | null
  ) => {
    const item = await create.mutateAsync({ kind, parent_id: parentId });
    // A freshly-created note / canvas / sheet should open straight away.
    // Folders just appear in place. We synthesise a node so the pane can
    // open the editor without waiting for the tree refetch.
    if (
      kind === "note" ||
      kind === "canvas" ||
      kind === "sheet" ||
      kind === "container"
    ) {
      onSelect({
        id: item.id,
        kind: item.kind,
        ref_id: item.ref_id,
        title: item.title,
        icon: item.icon,
        position: item.position,
        indexing_status: item.indexing_status,
        children: [],
      });
    }
  };

  // Chats aren't ``workspace_items`` — they're conversations carrying this
  // ``workspace_id`` synthesised into the tree at read time. So "New chat"
  // creates a conversation directly, refreshes the tree, and opens it inline.
  const handleNewChat = async () => {
    if (creatingChat) return;
    setCreatingChat(true);
    const { selectedModelId, selectedProviderId } = useModelStore.getState();
    try {
      const conv = await chatApi.create({
        title: null,
        model_id: workspace?.default_model_id ?? selectedModelId ?? undefined,
        provider_id:
          workspace?.default_provider_id ?? selectedProviderId ?? undefined,
        web_search_mode: "off",
        workspace_id: workspaceId,
      });
      await qc.invalidateQueries({
        queryKey: ["workspaces", "tree", workspaceId],
      });
      onSelect({
        id: String(conv.id),
        kind: "chat",
        ref_id: String(conv.id),
        title: conv.title ?? "New chat",
        icon: null,
        position: 0,
        indexing_status: null,
        children: [],
      });
    } catch {
      // Best-effort; the axios interceptor surfaces failures as toasts.
    } finally {
      setCreatingChat(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {(onHome || onSettings) && (
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          {onSettings && (
            <button
              type="button"
              onClick={onSettings}
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md border p-2 transition",
                atSettings
                  ? "border-[var(--border)] bg-[var(--hover)] text-[var(--text)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              )}
              title="Workspace settings — instructions, model, members, files, usage"
              aria-label="Workspace settings"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
          {onHome && (
            <button
              type="button"
              onClick={onHome}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent)]/90",
                // Always solid orange — a constant anchor users can fall back
                // to when they lose their place in the tree.
                atHome && "ring-2 ring-[var(--accent)]/40"
              )}
              title="Workspace home — overview, board, and recent items"
            >
              <Home className="h-4 w-4" />
              Home
            </button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Content
        </span>
        {canEdit && (
          <NewMenu
            disabled={create.isPending || creatingChat}
            onNewChat={handleNewChat}
            onNewNote={() => handleCreate("note", null)}
            onNewCanvas={() => handleCreate("canvas", null)}
            onNewBoard={() => handleCreate("board", null)}
            onNewSheet={() => handleCreate("sheet", null)}
            onNewNotebook={() => handleCreate("container", null)}
            onNewFolder={() => handleCreate("folder", null)}
            onNewTask={onNewTask}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {pinnedNodes.length > 0 && (
          <div className="mb-2 border-b border-[var(--border)] pb-2">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <Pin className="h-3 w-3 fill-current" />
              Pinned
            </div>
            <ul>
              {pinnedNodes.map((node) => (
                <TreeNode
                  key={`pin-${node.id}`}
                  workspaceId={workspaceId}
                  node={node}
                  depth={0}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onOpenToSide={onOpenToSide}
                  canEdit={canEdit}
                  onCreateInFolder={(kind, parentId) =>
                    handleCreate(kind, parentId)
                  }
                  onMove={setMovingNode}
                />
              ))}
            </ul>
          </div>
        )}
        {tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            Nothing here yet. Use{" "}
            <span className="font-medium text-[var(--text)]">+ New</span> to add
            a chat, note, canvas, or folder.
          </div>
        ) : mainTree.length === 0 ? null : (
          <ul>
            {mainTree.map((node) => (
              <TreeNode
                key={node.id}
                workspaceId={workspaceId}
                node={node}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenToSide={onOpenToSide}
                canEdit={canEdit}
                onCreateInFolder={(kind, parentId) =>
                  handleCreate(kind, parentId)
                }
                onMove={setMovingNode}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Per-workspace Archive — pinned to the bottom of the rail. */}
      <WorkspaceArchiveSection workspaceId={workspaceId} canEdit={canEdit} />

      {movingNode && (
        <MoveToFolderModal
          workspaceId={workspaceId}
          node={movingNode}
          folders={collectFolders(tree, movingNode.id)}
          onClose={() => setMovingNode(null)}
        />
      )}
    </div>
  );
}

/** Flatten the tree into a depth-tagged list of folders, skipping the
 *  subtree rooted at ``excludeId`` (you can't move an item into itself or
 *  one of its own descendants). */
function collectFolders(
  nodes: WorkspaceItemNode[],
  excludeId: string,
  depth = 0
): { id: string; title: string; depth: number }[] {
  const out: { id: string; title: string; depth: number }[] = [];
  for (const n of nodes) {
    if (n.id === excludeId) continue; // skip self + its whole subtree
    if (n.kind === "folder") {
      out.push({ id: n.id, title: n.title || "Untitled folder", depth });
      if (n.children?.length) {
        out.push(...collectFolders(n.children, excludeId, depth + 1));
      }
    }
  }
  return out;
}

/** Small modal that lists the workspace's folders so the user can reparent
 *  an item. "Top level" detaches it from any folder. */
function MoveToFolderModal({
  workspaceId,
  node,
  folders,
  onClose,
}: {
  workspaceId: string;
  node: WorkspaceItemNode;
  folders: { id: string; title: string; depth: number }[];
  onClose: () => void;
}) {
  const move = useMoveWorkspaceItem(workspaceId);

  const go = (parentId: string | null) => {
    move.mutate(
      // A large position appends the item to the end of the target's children.
      { itemId: node.id, payload: { parent_id: parentId, position: Date.now() } },
      { onSettled: onClose }
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Move “${node.title || "item"}”`}
      widthClass="max-w-sm"
    >
      <div className="space-y-1 text-sm">
        <button
          type="button"
          onClick={() => go(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover)]"
        >
          <Home className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          Top level (no folder)
        </button>
        {folders.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[var(--text-muted)]/70">
            No other folders yet. Create one from the “+ New” menu.
          </p>
        ) : (
          folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => go(f.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--hover)]"
              style={{ paddingLeft: f.depth * 14 + 8 }}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{f.title}</span>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

/** Top-most pinned nodes (doesn't descend into a pinned subtree). */
function collectPinned(nodes: WorkspaceItemNode[]): WorkspaceItemNode[] {
  const out: WorkspaceItemNode[] = [];
  const walk = (list: WorkspaceItemNode[]) => {
    for (const n of list) {
      if (n.pinned) out.push(n);
      else if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** The tree with pinned nodes removed (they render in the Pinned section
 *  instead, so each item shows exactly once — matching the chat sidebar). */
function removePinned(nodes: WorkspaceItemNode[]): WorkspaceItemNode[] {
  return nodes
    .filter((n) => !n.pinned)
    .map((n) =>
      n.children?.length ? { ...n, children: removePinned(n.children) } : n
    );
}

/**
 * Collapsible Archive at the bottom of the workspace rail. Lists archived
 * item roots + archived chats; each can be restored or permanently
 * deleted. Hidden entirely when nothing is archived.
 */
function WorkspaceArchiveSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data: archived } = useWorkspaceArchive(workspaceId);
  const unarchive = useUnarchiveWorkspaceItem(workspaceId);
  const remove = useDeleteWorkspaceItem(workspaceId);
  const qc = useQueryClient();

  const entries = archived ?? [];
  if (entries.length === 0) return null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
    qc.invalidateQueries({ queryKey: ["workspaces", "archive", workspaceId] });
  };

  const restore = async (node: WorkspaceItemNode) => {
    if (node.kind === "chat") {
      if (node.ref_id) {
        await chatApi.unarchive(node.ref_id);
        invalidate();
      }
    } else {
      unarchive.mutate(node.id);
    }
  };

  const del = async (node: WorkspaceItemNode) => {
    const ok = await confirm({
      title: "Delete",
      message:
        node.kind === "chat"
          ? "Permanently delete this chat?"
          : node.kind === "folder"
            ? "Permanently delete this folder and everything inside it?"
            : "Permanently delete this item?",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (node.kind === "chat") {
      if (node.ref_id) {
        await chatApi.remove(node.ref_id);
        invalidate();
      }
    } else {
      remove.mutate(node.id);
    }
  };

  return (
    <div className="shrink-0 border-t border-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Archive className="h-3.5 w-3.5" />
        Archive
        <span className="ml-1 font-normal normal-case">({entries.length})</span>
      </button>
      {open && (
        <ul className="max-h-48 overflow-y-auto px-1.5 pb-2">
          {entries.map((node) => (
            <li
              key={node.id}
              className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <NodeIcon node={node} expanded={false} />
              <span className="min-w-0 flex-1 truncate">
                {node.title || "Untitled"}
              </span>
              {canEdit && (
                <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    title="Restore"
                    aria-label="Restore"
                    onClick={() => void restore(node)}
                    className="rounded p-1 hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete permanently"
                    aria-label="Delete permanently"
                    onClick={() => void del(node)}
                    className="rounded p-1 text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeNode({
  workspaceId,
  node,
  depth,
  selectedId,
  onSelect,
  onOpenToSide,
  canEdit,
  onCreateInFolder,
  onMove,
}: {
  workspaceId: string;
  node: WorkspaceItemNode;
  depth: number;
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  onOpenToSide?: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
  onCreateInFolder: (
    kind: "folder" | "note" | "canvas" | "board" | "sheet" | "container",
    parentId: string
  ) => void;
  /** Open the move-to-folder picker for a (movable) stored item. */
  onMove?: (node: WorkspaceItemNode) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(node.title);

  const update = useUpdateWorkspaceItem(workspaceId);
  const remove = useDeleteWorkspaceItem(workspaceId);
  const archive = useArchiveWorkspaceItem(workspaceId);
  const setContext = useSetItemContext(workspaceId);
  const setPinned = useSetItemPinned(workspaceId);
  const qc = useQueryClient();
  const [chatBusy, setChatBusy] = useState(false);

  const isFolder = node.kind === "folder";
  const isChat = node.kind === "chat";
  const isTask = node.kind === "task";
  // Notes, canvases, boards, sheets, and chats can feed the workspace RAG
  // context, so they get the "Use as workspace context" toggle. Documents
  // default ON; chats default OFF (scratch space until opted in).
  const isContextItem =
    node.kind === "note" ||
    node.kind === "canvas" ||
    node.kind === "board" ||
    node.kind === "sheet" ||
    node.kind === "container" ||
    isChat;
  const contextOn = isChat
    ? node.context_enabled === true
    : node.context_enabled !== false;
  const isPinned = node.pinned === true;

  const handleTogglePin = async () => {
    if (isChat) {
      if (!node.ref_id) return;
      setChatBusy(true);
      try {
        await chatApi.update(node.ref_id, { pinned: !isPinned });
        invalidateTreeAndArchive();
      } finally {
        setChatBusy(false);
      }
    } else {
      setPinned.mutate({ itemId: node.id, pinned: !isPinned });
    }
  };
  // Every item gets a menu now (archive then delete). Chats are
  // synthesised, so their archive/delete go through the conversation
  // endpoints; folders/notes/canvases through the workspace_items ones.
  const editable = canEdit;

  const invalidateTreeAndArchive = () => {
    qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
    qc.invalidateQueries({ queryKey: ["workspaces", "archive", workspaceId] });
  };

  const handleArchive = async () => {
    const ok = await confirm({
      title: "Archive",
      message: isFolder
        ? "Archive this folder and everything inside it?"
        : isChat
          ? "Archive this chat?"
          : "Archive this item?",
      confirmLabel: "Archive",
    });
    if (!ok) return;
    if (isChat) {
      if (!node.ref_id) return;
      setChatBusy(true);
      try {
        await chatApi.archive(node.ref_id);
        invalidateTreeAndArchive();
      } finally {
        setChatBusy(false);
      }
    } else {
      archive.mutate(node.id);
    }
  };

  const handleDelete = async () => {
    if (isChat) {
      if (!node.ref_id) return;
      setChatBusy(true);
      try {
        await chatApi.remove(node.ref_id);
        invalidateTreeAndArchive();
      } finally {
        setChatBusy(false);
      }
    } else if (isTask) {
      // Automations are synthesised (no workspace_items row) — delete the
      // underlying Task, which drops it from the workspace tree.
      if (!node.ref_id) return;
      setChatBusy(true);
      try {
        await tasksApi.remove(node.ref_id);
        invalidateTreeAndArchive();
      } finally {
        setChatBusy(false);
      }
    } else {
      remove.mutate(node.id);
    }
  };

  const handleToggleContext = async () => {
    if (isChat) {
      if (!node.ref_id) return;
      setChatBusy(true);
      try {
        await workspacesApi.setChatContext(workspaceId, node.ref_id, !contextOn);
        invalidateTreeAndArchive();
      } finally {
        setChatBusy(false);
      }
    } else {
      setContext.mutate({ itemId: node.id, enabled: !contextOn });
    }
  };

  // Only show the spinner while a chunk run is *actively in flight*.
  // ``queued`` is a parked state — an empty note/canvas (or a workspace
  // with no embedding provider) sits there indefinitely, so spinning on
  // it just looks like something's stuck.
  const indexing = node.indexing_status === "embedding";

  const handleClick = () => {
    if (isFolder) {
      setExpanded((e) => !e);
    } else {
      onSelect(node);
    }
  };

  const commitRename = async () => {
    const next = draftTitle.trim();
    setRenaming(false);
    if (!next || next === node.title) {
      setDraftTitle(node.title);
      return;
    }
    try {
      if (isChat) {
        // Chats aren't workspace_items — rename the conversation directly.
        if (node.ref_id) await chatApi.update(node.ref_id, { title: next });
        invalidateTreeAndArchive();
      } else {
        await update.mutateAsync({ itemId: node.id, payload: { title: next } });
      }
    } catch {
      setDraftTitle(node.title);
    }
  };

  const isSelected = selectedId === node.id;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md pr-1 text-sm transition",
          isSelected
            ? "bg-[var(--accent)]/10 text-[var(--text)]"
            : "text-[var(--text)] hover:bg-[var(--hover)]"
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          {isFolder ? (
            <span className="shrink-0 text-[var(--text-muted)]">
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {/* Context is ON by default for documents, so only the *excluded*
              state is worth a glyph — flagging the exception keeps the rail
              quiet. The on/off toggle still lives in the ⋯ menu. */}
          {isContextItem && !contextOn && (
            <span
              title="Excluded from this workspace's chat context. Toggle via the ⋯ menu."
              aria-label="Excluded from workspace context"
              className="inline-flex shrink-0 items-center text-[var(--text-muted)]/70"
            >
              <ZapOff className="h-3 w-3" />
            </span>
          )}

          <NodeIcon node={node} expanded={expanded} />

          {renaming ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setDraftTitle(node.title);
                }
              }}
              className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--surface)] px-1 py-0.5 text-sm outline-none"
            />
          ) : (
            <span className="truncate">{node.title || "Untitled"}</span>
          )}

          {indexing && !renaming && (
            <span
              title="Indexing for semantic search…"
              className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--text-muted)]"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
            </span>
          )}
        </button>

        {editable && !renaming && (
          <NodeActions
            isFolder={isFolder}
            isChat={isChat}
            isTask={isTask}
            onRename={() => {
              setDraftTitle(node.title);
              setRenaming(true);
            }}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onNewNote={() => onCreateInFolder("note", node.id)}
            onNewCanvas={() => onCreateInFolder("canvas", node.id)}
            onNewBoard={() => onCreateInFolder("board", node.id)}
            onNewSheet={() => onCreateInFolder("sheet", node.id)}
            onNewNotebook={() => onCreateInFolder("container", node.id)}
            onNewSubfolder={
              isFolder ? () => onCreateInFolder("folder", node.id) : undefined
            }
            onMove={
              // Only stored workspace_items move via the items API. Chats and
              // automations are synthesised, so they have no movable row.
              onMove && !isChat && node.kind !== "task"
                ? () => onMove(node)
                : undefined
            }
            pinned={isPinned}
            onTogglePin={handleTogglePin}
            onOpenToSide={
              !isFolder && onOpenToSide ? () => onOpenToSide(node) : undefined
            }
            contextState={isContextItem ? (contextOn ? "on" : "off") : null}
            onToggleContext={isContextItem ? handleToggleContext : undefined}
            deleting={remove.isPending || archive.isPending || chatBusy}
          />
        )}
      </div>

      {isFolder && expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              workspaceId={workspaceId}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onOpenToSide={onOpenToSide}
              canEdit={canEdit}
              onCreateInFolder={onCreateInFolder}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function NodeIcon({
  node,
  expanded,
}: {
  node: WorkspaceItemNode;
  expanded: boolean;
}) {
  // Respect an explicit emoji icon if the node carries one. Lucide names
  // would need a registry to resolve; emoji renders directly, which is
  // the common case for user-set icons.
  if (node.icon && isEmoji(node.icon)) {
    return <span className="shrink-0 text-sm leading-none">{node.icon}</span>;
  }
  const cls = "h-4 w-4 shrink-0 text-[var(--text-muted)]";
  switch (node.kind) {
    case "folder":
      return expanded ? (
        <FolderOpen className={cls} />
      ) : (
        <Folder className={cls} />
      );
    case "chat":
      return <MessageSquare className={cls} />;
    case "canvas":
      return <Shapes className={cls} />;
    case "board":
      return <Columns3 className={cls} />;
    case "sheet":
      return <Table2 className={cls} />;
    case "container":
      return <Layers className={cls} />;
    case "task":
      // A clock reads "scheduled"; reserve the bolt for the context flag.
      return <Clock className={cls} />;
    case "note":
    default:
      return <FileText className={cls} />;
  }
}

/** Crude emoji test — good enough to decide "render this string directly"
 *  vs "fall back to a lucide glyph". Matches common pictographic ranges. */
function isEmoji(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

function NodeActions({
  isFolder,
  isChat,
  isTask,
  onRename,
  onArchive,
  onDelete,
  onNewNote,
  onNewCanvas,
  onNewBoard,
  onNewSheet,
  onNewNotebook,
  onNewSubfolder,
  onMove,
  pinned,
  onTogglePin,
  onOpenToSide,
  contextState,
  onToggleContext,
  deleting,
}: {
  isFolder: boolean;
  isChat: boolean;
  isTask: boolean;
  onRename?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onNewNote: () => void;
  onNewCanvas: () => void;
  onNewBoard: () => void;
  onNewSheet: () => void;
  onNewNotebook: () => void;
  onNewSubfolder?: () => void;
  /** Open the "move to folder" picker for this item. */
  onMove?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Open this item alongside the current one (split-screen). */
  onOpenToSide?: () => void;
  /** "on" / "off" for note+canvas (workspace-context toggle); null otherwise. */
  contextState?: "on" | "off" | null;
  onToggleContext?: () => void;
  deleting: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex shrink-0 items-center opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
      {isFolder && (
        <button
          type="button"
          title="New note in folder"
          aria-label="New note in folder"
          onClick={(e) => {
            e.stopPropagation();
            onNewNote();
          }}
          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
      {onTogglePin && (
        <button
          type="button"
          title={pinned ? "Unpin" : "Pin to top"}
          aria-label={pinned ? "Unpin" : "Pin to top"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
        >
          <Pin
            className={cn("h-3.5 w-3.5", pinned && "fill-current text-[var(--accent)]")}
          />
        </button>
      )}
      <div className="relative">
        <button
          type="button"
          title="More"
          aria-label="More actions"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
          className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <>
            <button
              aria-hidden
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
              }}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div
              role="menu"
              className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] py-1 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              {onRename && (
                <MenuItem
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  label="Rename"
                  onClick={() => {
                    setMenuOpen(false);
                    onRename();
                  }}
                />
              )}
              {onOpenToSide && (
                <MenuItem
                  icon={<Columns2 className="h-3.5 w-3.5" />}
                  label="Open to the side"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenToSide();
                  }}
                />
              )}
              {isFolder && (
                <>
                  <MenuItem
                    icon={<FilePlus2 className="h-3.5 w-3.5" />}
                    label="New note"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewNote();
                    }}
                  />
                  <MenuItem
                    icon={<PenTool className="h-3.5 w-3.5" />}
                    label="New canvas"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewCanvas();
                    }}
                  />
                  <MenuItem
                    icon={<Columns3 className="h-3.5 w-3.5" />}
                    label="New board"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewBoard();
                    }}
                  />
                  <MenuItem
                    icon={<Table2 className="h-3.5 w-3.5" />}
                    label="New sheet"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewSheet();
                    }}
                  />
                  <MenuItem
                    icon={<Layers className="h-3.5 w-3.5" />}
                    label="New notebook"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewNotebook();
                    }}
                  />
                  {onNewSubfolder && (
                    <MenuItem
                      icon={<FolderPlus className="h-3.5 w-3.5" />}
                      label="New subfolder"
                      onClick={() => {
                        setMenuOpen(false);
                        onNewSubfolder();
                      }}
                    />
                  )}
                </>
              )}
              {onMove && (
                <MenuItem
                  icon={<FolderInput className="h-3.5 w-3.5" />}
                  label="Move to folder"
                  onClick={() => {
                    setMenuOpen(false);
                    onMove();
                  }}
                />
              )}
              {contextState && onToggleContext && (
                <MenuItem
                  icon={
                    contextState === "on" ? (
                      <ZapOff className="h-3.5 w-3.5" />
                    ) : (
                      <Zap className="h-3.5 w-3.5" />
                    )
                  }
                  label={
                    contextState === "on"
                      ? "Remove from context"
                      : "Use as context"
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleContext();
                  }}
                />
              )}
              {/* Archive first (the soft step), then permanent delete.
                  Automations are synthesised and have no archive state. */}
              {!isTask && (
                <MenuItem
                  icon={<Archive className="h-3.5 w-3.5" />}
                  label="Archive"
                  disabled={deleting}
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                />
              )}
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label="Delete"
                destructive
                disabled={deleting}
                onClick={async () => {
                  setMenuOpen(false);
                  const ok = await confirm({
                    title: "Delete",
                    message: isFolder
                      ? "Permanently delete this folder and everything inside it?"
                      : isChat
                        ? "Permanently delete this chat?"
                        : isTask
                          ? "Permanently delete this automation and its run history?"
                          : "Permanently delete this item?",
                    confirmLabel: "Delete",
                    danger: true,
                  });
                  if (ok) onDelete();
                }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition disabled:opacity-50",
        destructive
          ? "text-[var(--danger)] hover:bg-[var(--danger-bg)]"
          : "text-[var(--text)] hover:bg-[var(--accent)]/10"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** A tiny uppercase divider label inside a dropdown menu. */
function MenuSection({ label }: { label: string }) {
  return (
    <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
      {label}
    </div>
  );
}

function NewMenu({
  onNewChat,
  onNewNote,
  onNewCanvas,
  onNewBoard,
  onNewSheet,
  onNewNotebook,
  onNewFolder,
  onNewTask,
  disabled,
}: {
  /** Top-level only — chats live at the workspace root, not in folders. */
  onNewChat?: () => void;
  onNewNote: () => void;
  onNewCanvas: () => void;
  onNewBoard: () => void;
  onNewSheet: () => void;
  onNewNotebook: () => void;
  onNewFolder: () => void;
  onNewTask?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text)] transition",
          "hover:bg-[var(--hover)] disabled:opacity-50"
        )}
      >
        {disabled ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        New
      </button>
      {open && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] py-1 shadow-lg"
          >
            {onNewChat && (
              <>
                <MenuSection label="Chat" />
                <MenuItem
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  label="New chat"
                  onClick={() => {
                    setOpen(false);
                    onNewChat();
                  }}
                />
              </>
            )}
            <MenuSection label="Documents" />
            <MenuItem
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              label="New note"
              onClick={() => {
                setOpen(false);
                onNewNote();
              }}
            />
            <MenuItem
              icon={<PenTool className="h-3.5 w-3.5" />}
              label="New canvas"
              onClick={() => {
                setOpen(false);
                onNewCanvas();
              }}
            />
            <MenuItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="New board"
              onClick={() => {
                setOpen(false);
                onNewBoard();
              }}
            />
            <MenuItem
              icon={<Table2 className="h-3.5 w-3.5" />}
              label="New sheet"
              onClick={() => {
                setOpen(false);
                onNewSheet();
              }}
            />
            <MenuSection label="Organize" />
            <MenuItem
              icon={<Layers className="h-3.5 w-3.5" />}
              label="New notebook"
              onClick={() => {
                setOpen(false);
                onNewNotebook();
              }}
            />
            <MenuItem
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label="New folder"
              onClick={() => {
                setOpen(false);
                onNewFolder();
              }}
            />
            {onNewTask && (
              <>
                <MenuSection label="Automation" />
                <MenuItem
                  icon={<Clock className="h-3.5 w-3.5" />}
                  label="New automation"
                  onClick={() => {
                    setOpen(false);
                    onNewTask();
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
