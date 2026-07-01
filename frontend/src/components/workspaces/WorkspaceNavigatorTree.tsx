import { createContext, useCallback, useContext, useMemo, useState } from "react";
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
  const move = useMoveWorkspaceItem(workspaceId);
  const setPinned = useSetItemPinned(workspaceId);

  // Pinned items surface in a dedicated section and are pruned from the main
  // tree (each item shows once), mirroring the chat sidebar.
  const pinnedNodes = collectPinned(tree);
  const mainTree = removePinned(tree);

  // --- Drag & drop: reorder items, move them into folders, and pin them ---
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; mode: DropMode } | null>(null);
  const [pinHover, setPinHover] = useState(false);
  const dndIndex = useMemo(() => buildDndIndex(mainTree), [mainTree]);

  const performMove = useCallback(
    (targetId: string, mode: DropMode) => {
      const draggedId = dragId;
      if (!draggedId || draggedId === targetId) return;
      const target = dndIndex.get(targetId);
      if (!target) return;
      // Never drop a folder into itself or one of its own descendants.
      if (mode === "inside" && draggedId === targetId) return;
      if (isDndAncestor(dndIndex, draggedId, targetId)) return;

      let parentId: string | null;
      let position: number;
      if (mode === "inside") {
        parentId = targetId;
        const kids = target.childPositions;
        position = (kids.length ? Math.max(...kids) : 0) + 1;
      } else {
        parentId = target.parentId;
        const sibs = target.siblings;
        const i = sibs.findIndex((s) => s.id === targetId);
        if (mode === "before") {
          const prev = sibs[i - 1];
          position = prev
            ? (prev.position + sibs[i].position) / 2
            : sibs[i].position - 1;
        } else {
          const next = sibs[i + 1];
          position = next
            ? (sibs[i].position + next.position) / 2
            : sibs[i].position + 1;
        }
      }
      // Optimistic reorder so the drop feels instant; the refetch confirms.
      qc.setQueryData<WorkspaceItemNode[]>(
        ["workspaces", "tree", workspaceId],
        (old) => (old ? moveNodeInTree(old, draggedId, parentId, position) : old)
      );
      move.mutate({ itemId: draggedId, payload: { parent_id: parentId, position } });
    },
    [dragId, dndIndex, move, qc, workspaceId]
  );

  const performPin = useCallback(() => {
    if (dragId) setPinned.mutate({ itemId: dragId, pinned: true });
  }, [dragId, setPinned]);

  const dnd = useMemo<TreeDnd>(
    () => ({
      canDrag: canEdit,
      draggingId: dragId,
      begin: setDragId,
      end: () => {
        setDragId(null);
        setDrop(null);
        setPinHover(false);
      },
      drop,
      setDrop,
      perform: performMove,
    }),
    [canEdit, dragId, drop, performMove]
  );

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

      <TreeDndContext.Provider value={dnd}>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {/* Drop-to-pin zone — only while dragging, so the rail stays clean. */}
          {dragId && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setPinHover(true);
              }}
              onDragLeave={() => setPinHover(false)}
              onDrop={(e) => {
                e.preventDefault();
                performPin();
                dnd.end();
              }}
              className={cn(
                "mb-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed py-2 text-[11px] font-medium transition",
                pinHover
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-muted)]"
              )}
            >
              <Pin className={cn("h-3.5 w-3.5", pinHover && "fill-current")} />
              Drop here to pin
            </div>
          )}
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
                  />
                ))}
              </ul>
            </div>
          )}
          {tree.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              Nothing here yet. Use{" "}
              <span className="font-medium text-[var(--text)]">+ New</span> to
              add a chat, note, canvas, or folder.
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
                />
              ))}
            </ul>
          )}
        </div>
      </TreeDndContext.Provider>

      {/* Per-workspace Archive — pinned to the bottom of the rail. */}
      <WorkspaceArchiveSection workspaceId={workspaceId} canEdit={canEdit} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Drag & drop plumbing
// ---------------------------------------------------------------------
type DropMode = "before" | "after" | "inside";
interface TreeDnd {
  canDrag: boolean;
  draggingId: string | null;
  begin: (id: string) => void;
  end: () => void;
  drop: { id: string; mode: DropMode } | null;
  setDrop: (d: { id: string; mode: DropMode } | null) => void;
  perform: (targetId: string, mode: DropMode) => void;
}
const TreeDndContext = createContext<TreeDnd | null>(null);

interface DndEntry {
  parentId: string | null;
  siblings: { id: string; position: number }[];
  childPositions: number[];
}
/** node id → its parent, ordered siblings, and child positions (for drop math). */
function buildDndIndex(nodes: WorkspaceItemNode[]): Map<string, DndEntry> {
  const map = new Map<string, DndEntry>();
  const walk = (list: WorkspaceItemNode[], parentId: string | null) => {
    const siblings = list.map((n) => ({ id: n.id, position: n.position }));
    for (const n of list) {
      map.set(n.id, {
        parentId,
        siblings,
        childPositions: (n.children ?? []).map((c) => c.position),
      });
      if (n.children?.length) walk(n.children, n.id);
    }
  };
  walk(nodes, null);
  return map;
}
/** True if ``ancestorId`` is at/above ``nodeId`` (so we never nest into self). */
function isDndAncestor(
  map: Map<string, DndEntry>,
  ancestorId: string,
  nodeId: string
): boolean {
  let cur: string | null | undefined = nodeId;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = map.get(cur)?.parentId ?? null;
  }
  return false;
}
/** Immutably relocate a node under ``parentId`` at ``position`` and re-sort. */
function moveNodeInTree(
  tree: WorkspaceItemNode[],
  id: string,
  parentId: string | null,
  position: number
): WorkspaceItemNode[] {
  let moved: WorkspaceItemNode | null = null;
  const strip = (nodes: WorkspaceItemNode[]): WorkspaceItemNode[] =>
    nodes
      .filter((n) => {
        if (n.id === id) {
          moved = n;
          return false;
        }
        return true;
      })
      .map((n) => ({ ...n, children: strip(n.children ?? []) }));
  let next = strip(tree);
  if (!moved) return tree;
  const node = { ...(moved as WorkspaceItemNode), position };
  const sortByPos = (a: WorkspaceItemNode, b: WorkspaceItemNode) =>
    a.position - b.position;
  if (parentId == null) {
    next = [...next, node].sort(sortByPos);
  } else {
    const addTo = (nodes: WorkspaceItemNode[]): WorkspaceItemNode[] =>
      nodes.map((n) =>
        n.id === parentId
          ? { ...n, children: [...(n.children ?? []), node].sort(sortByPos) }
          : { ...n, children: addTo(n.children ?? []) }
      );
    next = addTo(next);
  }
  return next;
}

/** Flatten the tree into a depth-tagged list of folders, skipping the
 *  subtree rooted at ``excludeId`` (you can't move an item into itself or
 *  one of its own descendants). */
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
}: {
  workspaceId: string;
  node: WorkspaceItemNode;
  depth: number;
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  onOpenToSide?: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
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

  // --- Drag & drop ---
  const dnd = useContext(TreeDndContext);
  // Chats + automations are synthesised (no movable row); everything stored is
  // draggable to reorder / move into folders.
  const canDragThis =
    !!dnd?.canDrag && !isChat && !isTask && !renaming;
  const isDragging = dnd?.draggingId === node.id;
  const dropMode = dnd?.drop?.id === node.id ? dnd.drop.mode : null;

  const onDragOver = (e: React.DragEvent) => {
    if (!dnd?.draggingId || dnd.draggingId === node.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    const mode: DropMode =
      isFolder && y > r.height * 0.25 && y < r.height * 0.75
        ? "inside"
        : y < r.height / 2
          ? "before"
          : "after";
    if (dnd.drop?.id !== node.id || dnd.drop.mode !== mode)
      dnd.setDrop({ id: node.id, mode });
  };
  const onDrop = (e: React.DragEvent) => {
    if (!dnd?.draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropMode) dnd.perform(node.id, dropMode);
    dnd.end();
  };

  return (
    <li>
      <div
        className="relative"
        onDragOver={canDragThis ? onDragOver : undefined}
        onDrop={canDragThis ? onDrop : undefined}
      >
        {/* Reorder insertion line */}
        {dropMode === "before" && (
          <div className="pointer-events-none absolute left-2 right-2 top-0 z-10 h-0.5 rounded-full bg-[var(--accent)]" />
        )}
        {dropMode === "after" && (
          <div className="pointer-events-none absolute bottom-0 left-2 right-2 z-10 h-0.5 rounded-full bg-[var(--accent)]" />
        )}
        <div
          draggable={canDragThis}
          onDragStart={(e) => {
            if (!canDragThis || !dnd) return;
            e.stopPropagation();
            e.dataTransfer.effectAllowed = "move";
            dnd.begin(node.id);
          }}
          onDragEnd={() => dnd?.end()}
          className={cn(
            "group flex items-center gap-1 rounded-md pr-1 text-sm transition",
            isSelected
              ? "bg-[var(--accent)]/10 text-[var(--text)]"
              : "text-[var(--text)] hover:bg-[var(--hover)]",
            // Drop-into-folder highlight.
            dropMode === "inside" &&
              "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/50",
            isDragging && "opacity-40",
            canDragThis && "cursor-grab active:cursor-grabbing"
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
