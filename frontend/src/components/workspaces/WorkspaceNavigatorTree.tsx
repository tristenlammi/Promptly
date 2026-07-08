import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArchiveRestore,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns2,
  Columns3,
  Copy as CopyIcon,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Search as SearchIcon,
  Home,
  Layers,
  LayoutTemplate,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PenTool,
  Pin,
  Plus,
  Settings,
  Shapes,
  Smile,
  SmilePlus,
  Table2,
  Trash2,
  Unlock,
  Zap,
  ZapOff,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { EmojiPicker } from "@/components/files/documents/EmojiPicker";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { Modal } from "@/components/shared/Modal";
import { tasksApi } from "@/api/tasks";
import { confirm } from "@/components/shared/ConfirmDialog";
import { workspacesApi } from "@/api/workspaces";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspaceItem,
  useCreateWorkspaceItem,
  useDeleteWorkspaceItem,
  useDuplicateWorkspaceItem,
  useMoveWorkspaceItem,
  useSetItemContext,
  useSetItemPinned,
  useUnarchiveWorkspaceItem,
  useUpdateWorkspaceItem,
  useWorkspace,
  useWorkspaceArchive,
} from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";
import { useModelStore } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
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
 * Drag reorder / reparent / pin all work — ``handleDragEnd`` computes a
 * float midpoint position among the new siblings and calls the ``/move``
 * endpoint (optimistic tree update first).
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
  onDrive,
  atDrive,
  onSearch,
  atSearch,
  onNewTask,
  onNewMeeting,
  isOwner,
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
  /** Open the workspace drive (file browser) in the main pane. */
  onDrive?: () => void;
  /** True when the drive is showing. */
  atDrive?: boolean;
  /** Open workspace search (titles + full text + semantic) in the main pane. */
  onSearch?: () => void;
  /** True when the search pane is showing. */
  atSearch?: boolean;
  /** Open the "new automation" task form (homed in this workspace). */
  onNewTask?: () => void;
  /** Open the meeting-notes upload (recording → transcribed note). */
  onNewMeeting?: () => void;
  /** Caller owns the workspace — gates public share links (9.1); the
   *  backing documents belong to the owner, so only they can mint links. */
  isOwner?: boolean;
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

  // --- Drag & drop (dnd-kit): reorder, move into folders, pin. The tree is
  // flattened to a sortable list so siblings animate out of the way live and a
  // DragOverlay lifts the grabbed row. ---
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);
  // Where the drop would land relative to the hovered row: on a folder's
  // middle band = file *into* it; near a row's edge = insert before/after
  // (shown as an explicit indicator line). Rows never shift while dragging.
  const [dropEdge, setDropEdge] = useState<"before" | "after" | "into" | null>(
    null
  );
  // Keyboard navigation (7.1): a roving focus separate from the *open*
  // item, so ↑↓ can walk the rail without loading every pane it passes.
  const [focusId, setFocusId] = useState<string | null>(null);
  // F2 → the focused row flips into its inline rename input.
  const [renameRequestId, setRenameRequestId] = useState<string | null>(null);
  // "New from template" picker (9.3).
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // One flat list across both sections so pinned items are draggable too, and
  // dragging between the Pinned area and the tree pins / unpins the item.
  const flatItems = useMemo(() => {
    const pinnedFlat = flattenTree(pinnedNodes, collapsed).map((i) => ({
      ...i,
      group: "pinned" as const,
    }));
    const mainFlat = flattenTree(mainTree, collapsed).map((i) => ({
      ...i,
      group: "main" as const,
    }));
    return [...pinnedFlat, ...mainFlat];
  }, [pinnedNodes, mainTree, collapsed]);
  // While dragging a folder, hide its descendants (can't nest into itself).
  const visibleItems = useMemo(
    () => (activeId ? removeChildrenOf(flatItems, activeId) : flatItems),
    [flatItems, activeId]
  );
  const pinnedIds = useMemo(
    () => visibleItems.filter((i) => i.group === "pinned").map((i) => i.id),
    [visibleItems]
  );
  const mainIds = useMemo(
    () => visibleItems.filter((i) => i.group === "main").map((i) => i.id),
    [visibleItems]
  );
  const activeItem = activeId
    ? flatItems.find((i) => i.id === activeId) ?? null
    : null;

  const overItem = overId ? flatItems.find((i) => i.id === overId) : null;
  const dropInPinned = overId === PIN_ZONE_ID || overItem?.group === "pinned";
  // Reorder projection (inserting before/after the hovered row). "Into" mode
  // bypasses it — the hovered folder itself is the destination.
  const projected =
    activeId && overId && !dropInPinned && dropEdge && dropEdge !== "into"
      ? getProjection(visibleItems, activeId, overId, dropEdge, offsetLeft)
      : null;
  const intoFolder =
    dropEdge === "into" &&
    overItem &&
    overItem.node.kind === "folder" &&
    overItem.group === "main" &&
    overItem.id !== activeId
      ? overItem
      : null;

  // Hovering "into" a collapsed folder springs it open after a beat, so you
  // can keep dragging deeper without having to drop first.
  const intoFolderId = intoFolder?.id ?? null;
  useEffect(() => {
    if (!intoFolderId || !collapsed.has(intoFolderId)) return;
    const t = window.setTimeout(() => toggleCollapse(intoFolderId), 700);
    return () => window.clearTimeout(t);
  }, [intoFolderId, collapsed, toggleCollapse]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );
  const resetDrag = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
    setDropEdge(null);
    document.body.style.removeProperty("cursor");
  };

  // Classify the pointer's position within the hovered row: a folder's middle
  // band means "file inside it"; the outer bands (and any non-folder row)
  // mean insert before/after — shown as an indicator line, not by shuffling
  // rows around.
  const handleDragMove = ({ activatorEvent, delta, over }: DragMoveEvent) => {
    setOffsetLeft(delta.x);
    if (!over || over.id === PIN_ZONE_ID) {
      setDropEdge(null);
      return;
    }
    const startY = (activatorEvent as PointerEvent | null)?.clientY;
    const rect = over.rect;
    if (startY == null || !rect) {
      setDropEdge("after");
      return;
    }
    const frac = (startY + delta.y - rect.top) / Math.max(rect.height, 1);
    const overFlat = flatItems.find((i) => i.id === String(over.id));
    const folderish =
      overFlat?.node.kind === "folder" &&
      overFlat.group === "main" &&
      overFlat.id !== activeId;
    if (folderish && frac >= 0.3 && frac <= 0.7) setDropEdge("into");
    else setDropEdge(frac < 0.5 ? "before" : "after");
  };

  // Chats + automations (0140) are draggable now: they carry their own
  // parent/position columns, so reordering/filing routes to the placement
  // endpoints instead of the items-move one.
  const canDragKind = (_k: string) => true;

  // ↑↓ walk the visible rows, Enter opens (or toggles a folder), ←/→
  // collapse/expand, F2 renames. The handler lives on the scroll
  // container so it only fires when the rail itself has focus — typing
  // in a rename input or the search box is untouched.
  const handleTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const order = visibleItems;
    if (order.length === 0) return;
    const idx = order.findIndex((i) => i.id === (focusId ?? selectedId));
    const focusRow = (item: FlatItem | undefined) => {
      if (!item) return;
      setFocusId(item.id);
      document
        .getElementById(`ws-tree-row-${item.id}`)
        ?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        idx === -1
          ? step === 1
            ? 0
            : order.length - 1
          : Math.max(0, Math.min(order.length - 1, idx + step));
      focusRow(order[next]);
      return;
    }
    const cur = idx >= 0 ? order[idx] : undefined;
    if (!cur) return;
    const isFolderish = cur.node.kind === "folder" || cur.node.kind === "container";
    if (e.key === "Enter") {
      e.preventDefault();
      if (isFolderish) toggleCollapse(cur.id);
      else onSelect(cur.node);
    } else if (e.key === "ArrowRight") {
      if (isFolderish && collapsed.has(cur.id)) {
        e.preventDefault();
        toggleCollapse(cur.id);
      }
    } else if (e.key === "ArrowLeft") {
      if (isFolderish && !collapsed.has(cur.id)) {
        e.preventDefault();
        toggleCollapse(cur.id);
      } else if (cur.parentId) {
        // On a leaf (or an already-collapsed folder): jump to the parent.
        e.preventDefault();
        focusRow(order.find((i) => i.id === cur.parentId));
      }
    } else if (e.key === "F2") {
      if (canEdit) {
        e.preventDefault();
        setRenameRequestId(cur.id);
      }
    }
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const activeFlat = flatItems.find((i) => i.id === active.id);
    const overFlat = over ? flatItems.find((i) => i.id === over.id) : null;
    const toPinned = over?.id === PIN_ZONE_ID || overFlat?.group === "pinned";
    resetDrag();
    if (!over || !canEdit || !activeFlat || !canDragKind(activeFlat.node.kind))
      return;

    const kind = activeFlat.node.kind;
    const isChat = kind === "chat";
    const isTask = kind === "task";
    const refId = activeFlat.node.ref_id;

    // Crossing the Pinned ↔ tree boundary toggles the pin. Tasks have no
    // pin concept, so pinning is a no-op for them.
    const wasPinned = activeFlat.node.pinned === true;
    if (toPinned !== wasPinned && !isTask) {
      if (isChat) {
        if (refId) {
          void chatApi.update(refId, { pinned: toPinned }).then(() =>
            qc.invalidateQueries({
              queryKey: ["workspaces", "tree", workspaceId],
            })
          );
        }
      } else {
        setPinned.mutate({ itemId: String(active.id), pinned: toPinned });
      }
    }
    // Tasks can't live in the pinned section — snap them back if dropped there.
    if (toPinned && isTask) return;
    // Reparent + reorder only when the item lands in the tree region.
    if (toPinned || over.id === PIN_ZONE_ID) return;

    let parentId: string | null;
    let position: number;
    if (
      dropEdge === "into" &&
      overFlat &&
      overFlat.node.kind === "folder" &&
      overFlat.id !== String(active.id)
    ) {
      // Filing straight into the hovered folder: append as its last child.
      parentId = overFlat.id;
      const kids = overFlat.node.children ?? [];
      const lastPos = kids.length ? kids[kids.length - 1].position : null;
      position = lastPos != null ? lastPos + 1 : 1;
    } else if (projected) {
      // Inserting at the indicator line: midpoint between the neighbouring
      // siblings that share the projected parent.
      parentId = projected.parentId;
      const { without, insertAt, depth } = projected;
      let prevSib: FlatItem | null = null;
      for (let i = insertAt - 1; i >= 0; i--) {
        const it = without[i];
        if (it.depth < depth || it.group !== "main") break;
        if (it.depth === depth && it.parentId === parentId) {
          prevSib = it;
          break;
        }
      }
      let nextSib: FlatItem | null = null;
      for (let i = insertAt; i < without.length; i++) {
        const it = without[i];
        if (it.depth < depth || it.group !== "main") break;
        if (it.depth === depth && it.parentId === parentId) {
          nextSib = it;
          break;
        }
      }
      const prev = prevSib?.node.position;
      const next = nextSib?.node.position;
      position =
        prev != null && next != null
          ? (prev + next) / 2
          : prev != null
            ? prev + 1
            : next != null
              ? next - 1
              : 1;
    } else {
      return;
    }

    qc.setQueryData<WorkspaceItemNode[]>(
      ["workspaces", "tree", workspaceId],
      (old) =>
        old ? moveNodeInTree(old, String(active.id), parentId, position) : old
    );
    // Chats + automations (0140) persist their placement to their own
    // columns; stored items go through the items-move endpoint.
    if (isChat) {
      void workspacesApi.placeChat(workspaceId, String(active.id), {
        parent_id: parentId,
        position,
      });
    } else if (isTask) {
      void workspacesApi.placeTask(workspaceId, String(active.id), {
        parent_id: parentId,
        position,
      });
    } else {
      move.mutate({
        itemId: String(active.id),
        payload: { parent_id: parentId, position },
      });
    }
  };

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
          {onDrive && (
            <button
              type="button"
              onClick={onDrive}
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md border p-2 transition",
                atDrive
                  ? "border-[var(--border)] bg-[var(--hover)] text-[var(--text)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              )}
              title="Workspace drive — the shared files chats can draw on"
              aria-label="Workspace drive"
            >
              <HardDrive className="h-4 w-4" />
            </button>
          )}
          {onSearch && (
            <button
              type="button"
              onClick={onSearch}
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md border p-2 transition",
                atSearch
                  ? "border-[var(--border)] bg-[var(--hover)] text-[var(--text)]"
                  : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              )}
              title="Search this workspace — titles, content, and meaning"
              aria-label="Search workspace"
            >
              <SearchIcon className="h-4 w-4" />
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
            onNewMeeting={onNewMeeting}
            onNewFromTemplate={() => setTemplatePickerOpen(true)}
          />
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={rowUnderPointer}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={({ active }) => {
          setActiveId(String(active.id));
          setOverId(String(active.id));
          document.body.style.cursor = "grabbing";
        }}
        onDragMove={handleDragMove}
        onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
        onDragEnd={handleDragEnd}
        onDragCancel={resetDrag}
      >
        <div
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          role="tree"
          aria-label="Workspace content"
          className="min-h-0 flex-1 overflow-y-auto px-1 pb-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/40"
        >
          <SortableContext
            items={[...pinnedIds, ...mainIds]}
            strategy={staticRowsStrategy}
          >
            {/* Pinned section — always rendered (a faint standing hint when
                empty, so pinning is discoverable without mid-drag luck),
                lighting up as a drop target while dragging. */}
            {(pinnedNodes.length > 0 || activeId || tree.length > 0) && (
              <div className="mb-2 border-b border-[var(--border)] pb-2">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                  <Pin className="h-3 w-3 fill-current" />
                  Pinned
                </div>
                {pinnedNodes.length === 0 ? (
                  <PinDropZone active={dropInPinned} />
                ) : (
                  <ul>
                    {visibleItems
                      .filter((i) => i.group === "pinned")
                      .map((item) => (
                        <TreeRow
                          key={item.id}
                          workspaceId={workspaceId}
                          item={item}
                          selectedId={selectedId}
                          onSelect={(n) => {
                            setFocusId(n.id);
                            onSelect(n);
                          }}
                          onOpenToSide={onOpenToSide}
                          canEdit={canEdit}
                          collapsed={collapsed}
                          toggleCollapse={toggleCollapse}
                          sortable={canDragKind(item.node.kind)}
                          focused={focusId === item.id}
                          renameRequest={renameRequestId === item.id}
                          onRenameHandled={() => setRenameRequestId(null)}
                          isOwner={isOwner}
                          onCreateInside={
                            canEdit
                              ? (kind, parentId) =>
                                  void handleCreate(kind, parentId)
                              : undefined
                          }
                        />
                      ))}
                  </ul>
                )}
              </div>
            )}
            {tree.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                Nothing here yet. Use{" "}
                <span className="font-medium text-[var(--text)]">+ New</span> to
                add a chat, note, canvas, or folder.
              </div>
            ) : (
              <ul>
                {visibleItems
                  .filter((i) => i.group === "main")
                  .map((item) => (
                    <TreeRow
                      key={item.id}
                      workspaceId={workspaceId}
                      item={item}
                      selectedId={selectedId}
                      onSelect={(n) => {
                        setFocusId(n.id);
                        onSelect(n);
                      }}
                      onOpenToSide={onOpenToSide}
                      canEdit={canEdit}
                      collapsed={collapsed}
                      toggleCollapse={toggleCollapse}
                      sortable={canDragKind(item.node.kind)}
                      focused={focusId === item.id}
                      renameRequest={renameRequestId === item.id}
                      onRenameHandled={() => setRenameRequestId(null)}
                      isOwner={isOwner}
                      isDropParent={
                        !!activeId &&
                        !dropInPinned &&
                        item.node.kind === "folder" &&
                        (intoFolder?.id === item.id ||
                          projected?.parentId === item.id)
                      }
                      dropIndicator={
                        activeId &&
                        !dropInPinned &&
                        overId === item.id &&
                        projected &&
                        (dropEdge === "before" || dropEdge === "after")
                          ? { edge: dropEdge, depth: projected.depth }
                          : null
                      }
                      onCreateInside={
                        canEdit
                          ? (kind, parentId) =>
                              void handleCreate(kind, parentId)
                          : undefined
                      }
                    />
                  ))}
              </ul>
            )}
          </SortableContext>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeItem ? (
            <TreeRow
              workspaceId={workspaceId}
              item={{ ...activeItem, depth: 0 }}
              selectedId={selectedId}
              onSelect={onSelect}
              canEdit={false}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              sortable={false}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Per-workspace Archive + Trash — pinned to the bottom of the rail. */}
      <WorkspaceArchiveSection workspaceId={workspaceId} canEdit={canEdit} />
      <WorkspaceTrashSection workspaceId={workspaceId} canEdit={canEdit} />

      {templatePickerOpen && (
        <NoteTemplatePicker
          workspaceId={workspaceId}
          tree={tree}
          onClose={() => setTemplatePickerOpen(false)}
          onCreated={(item) =>
            onSelect({
              id: item.id,
              kind: "note",
              ref_id: item.ref_id,
              title: item.title,
              icon: null,
              position: 0,
              indexing_status: null,
              children: [],
            })
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Drag & drop plumbing (dnd-kit flattened sortable tree)
// ---------------------------------------------------------------------
const PIN_ZONE_ID = "__pin_zone__";
const INDENT = 12; // px of indentation per depth level

// Rows hold still while dragging — the drop location is communicated by the
// indicator line / folder highlight instead of sortable shuffling, so the
// folder you're aiming at can never slide away from the cursor.
const staticRowsStrategy = () => null;

// Prefer the row directly under the pointer (the before/after/into bands need
// it); fall back to nearest-centre when the pointer is outside every row.
const rowUnderPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

interface FlatItem {
  id: string;
  node: WorkspaceItemNode;
  depth: number;
  parentId: string | null;
  /** Which visual section the row lives in — dropping across the two toggles
   *  the item's pinned state. */
  group?: "pinned" | "main";
}

/** Depth-first flatten of the tree, skipping collapsed folders' children. */
function flattenTree(
  nodes: WorkspaceItemNode[],
  collapsed: Set<string>,
  parentId: string | null = null,
  depth = 0
): FlatItem[] {
  const out: FlatItem[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, node: n, depth, parentId });
    if (n.children?.length && !collapsed.has(n.id)) {
      out.push(...flattenTree(n.children, collapsed, n.id, depth + 1));
    }
  }
  return out;
}

/** Drop the dragged item's whole subtree from the list (so it can't nest into
 *  itself and the remaining rows animate cleanly). */
function removeChildrenOf(items: FlatItem[], id: string): FlatItem[] {
  const out: FlatItem[] = [];
  let skipBelow: number | null = null;
  for (const it of items) {
    if (skipBelow != null) {
      if (it.depth > skipBelow) continue;
      skipBelow = null;
    }
    out.push(it);
    if (it.id === id) skipBelow = it.depth;
  }
  return out;
}

/** Where the dragged row would land when inserted on ``edge`` of the row under
 *  the pointer: a depth (nudged by the horizontal drag, clamped to the levels
 *  that exist at that boundary) and the resulting parent id. ``insertAt`` /
 *  ``without`` let the caller find the neighbouring siblings for positioning. */
function getProjection(
  items: FlatItem[],
  activeId: string,
  overId: string,
  edge: "before" | "after",
  dragOffset: number
): {
  depth: number;
  parentId: string | null;
  insertAt: number;
  without: FlatItem[];
} | null {
  const active = items.find((i) => i.id === activeId);
  const without = items.filter((i) => i.id !== activeId);
  let insertAt = without.findIndex((i) => i.id === overId);
  if (insertAt === -1 || !active) return null;
  if (edge === "after") insertAt += 1;
  const prev = without[insertAt - 1];
  const next = without[insertAt];
  const dragDepth = Math.round(dragOffset / INDENT);
  const projectedDepth = active.depth + dragDepth;
  // Can only nest one level under the previous row, and only if it's a folder.
  const maxDepth = prev
    ? prev.node.kind === "folder"
      ? prev.depth + 1
      : prev.depth
    : 0;
  const minDepth = next ? next.depth : 0;
  const depth = Math.max(minDepth, Math.min(projectedDepth, maxDepth));

  const parentId = (() => {
    if (depth === 0 || !prev) return null;
    if (depth === prev.depth) return prev.parentId;
    if (depth > prev.depth) return prev.id;
    const ancestor = without
      .slice(0, insertAt)
      .reverse()
      .find((i) => i.depth === depth);
    return ancestor?.parentId ?? null;
  })();
  return { depth, parentId, insertAt, without };
}

/** The "Drop here to pin" target (a dnd-kit droppable) shown while dragging. */
function PinDropZone({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: PIN_ZONE_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mb-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed py-2 text-[11px] font-medium transition",
        active
          ? "scale-[1.01] border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
          : "border-[var(--border)] text-[var(--text-muted)]"
      )}
    >
      <Pin className={cn("h-3.5 w-3.5", active && "fill-current")} />
      {/* Standing copy teaches the gesture; the active copy confirms it. */}
      {active ? "Drop here to pin" : "Drag items here to pin"}
    </div>
  );
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
    if (node.kind === "chat") {
      const ok = await confirm({
        title: "Delete",
        message: "Permanently delete this chat?",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      if (node.ref_id) {
        await chatApi.remove(node.ref_id);
        invalidate();
      }
    } else {
      // Items move to the Trash (0138) — recoverable, no confirm needed.
      remove.mutate(node.id, {
        onSuccess: () =>
          qc.invalidateQueries({
            queryKey: ["workspaces", "trash", workspaceId],
          }),
      });
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
                    title={
                      node.kind === "chat"
                        ? "Delete permanently"
                        : "Move to Trash"
                    }
                    aria-label={
                      node.kind === "chat"
                        ? "Delete permanently"
                        : "Move to Trash"
                    }
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

/** Builtin note templates — mirrors backend NOTE_TEMPLATES (9.3). The
 *  backend ignores unknown keys, so drift degrades to a 404 toast. */
const BUILTIN_NOTE_TEMPLATES: { key: string; name: string; hint: string }[] = [
  { key: "meeting_agenda", name: "Meeting agenda", hint: "Attendees, agenda, decisions, action items" },
  { key: "decision_record", name: "Decision record", hint: "Context, options, decision, consequences" },
  { key: "weekly_report", name: "Weekly report", hint: "Done, in progress, blocked, next week" },
  { key: "project_brief", name: "Project brief", hint: "Problem, goals, approach, risks" },
];

/** "New from template" picker (9.3): builtin skeletons + any workspace
 *  note flagged as a template via its ⋯ menu. */
function NoteTemplatePicker({
  workspaceId,
  tree,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  tree: WorkspaceItemNode[];
  onClose: () => void;
  onCreated: (item: { id: string; ref_id: string | null; title: string }) => void;
}) {
  const qc = useQueryClient();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const templateNotes = useMemo(() => {
    const out: WorkspaceItemNode[] = [];
    const walk = (nodes: WorkspaceItemNode[]) => {
      for (const n of nodes) {
        if (n.kind === "note" && n.is_template) out.push(n);
        if (n.children.length) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const create = async (
    payload: { template_key?: string; from_item_id?: string },
    busy: string
  ) => {
    if (busyKey) return;
    setBusyKey(busy);
    try {
      const item = await workspacesApi.createNoteFromTemplate(
        workspaceId,
        payload
      );
      qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
      onCreated({ id: item.id, ref_id: item.ref_id, title: item.title });
      onClose();
    } catch {
      toast.error("Couldn't create the note — try again.");
      setBusyKey(null);
    }
  };

  const Row = ({
    name,
    hint,
    busy,
    onClick,
  }: {
    name: string;
    hint: string;
    busy: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      disabled={Boolean(busyKey)}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-[var(--hover)] disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
      ) : (
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      )}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[var(--text)]">
          {name}
        </span>
        <span className="block truncate text-xs text-[var(--text-muted)]">
          {hint}
        </span>
      </span>
    </button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="New note from template"
      description="Start from a skeleton instead of a blank page."
      widthClass="max-w-sm"
    >
      <div className="space-y-0.5">
        {BUILTIN_NOTE_TEMPLATES.map((t) => (
          <Row
            key={t.key}
            name={t.name}
            hint={t.hint}
            busy={busyKey === t.key}
            onClick={() => void create({ template_key: t.key }, t.key)}
          />
        ))}
        {templateNotes.length > 0 && (
          <>
            <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Your templates
            </div>
            {templateNotes.map((n) => (
              <Row
                key={n.id}
                name={n.title || "Untitled"}
                hint="Copy of your template note"
                busy={busyKey === n.id}
                onClick={() => void create({ from_item_id: n.id }, n.id)}
              />
            ))}
          </>
        )}
        <p className="px-2.5 pt-2 text-[10px] leading-snug text-[var(--text-muted)]">
          Tip: flag any note as a template from its ⋯ menu and it appears
          here for the whole workspace.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Collapsible Trash below the Archive (0138). Deleted items stage here
 * for 30 days; each entry restores in one click or purges for real.
 * Hidden entirely when the trash is empty.
 */
function WorkspaceTrashSection({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data: entries = [] } = useQuery({
    queryKey: ["workspaces", "trash", workspaceId],
    queryFn: () => workspacesApi.trash(workspaceId),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  if (entries.length === 0) return null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
    qc.invalidateQueries({ queryKey: ["workspaces", "trash", workspaceId] });
    qc.invalidateQueries({ queryKey: ["workspaces", "overview", workspaceId] });
  };

  const restore = async (id: string, title: string) => {
    setBusyId(id);
    try {
      await workspacesApi.restoreTrashed(workspaceId, id);
      invalidate();
      toast.success(`Restored “${title || "Untitled"}”`);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id: string, title: string, subtree: number) => {
    const ok = await confirm({
      title: "Delete forever",
      message: `Permanently delete “${title || "Untitled"}”${
        subtree > 0 ? ` and ${subtree} nested item(s)` : ""
      }? This cannot be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await workspacesApi.purgeTrashed(workspaceId, id);
      invalidate();
    } finally {
      setBusyId(null);
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
        <Trash2 className="h-3.5 w-3.5" />
        Trash
        <span className="ml-1 font-normal normal-case">({entries.length})</span>
      </button>
      {open && (
        <>
          <p className="px-3 pb-1 text-[10px] leading-snug text-[var(--text-muted)]">
            Deleted items stay here for 30 days, hidden from the AI.
          </p>
          <ul className="max-h-48 overflow-y-auto px-1.5 pb-2">
            {entries.map((e) => (
              <li
                key={e.id}
                className="group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <span className="min-w-0 flex-1 truncate" title={e.title}>
                  {e.title || "Untitled"}
                  {e.subtree_count > 0 && (
                    <span className="ml-1 text-[10px]">
                      (+{e.subtree_count})
                    </span>
                  )}
                </span>
                {canEdit &&
                  (busyId === e.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        title="Restore"
                        aria-label="Restore"
                        onClick={() => void restore(e.id, e.title)}
                        className="rounded p-1 hover:bg-[var(--accent)]/10 hover:text-[var(--text)]"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete forever"
                        aria-label="Delete forever"
                        onClick={() =>
                          void purge(e.id, e.title, e.subtree_count)
                        }
                        className="rounded p-1 text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function TreeRow({
  workspaceId,
  item,
  selectedId,
  onSelect,
  onOpenToSide,
  canEdit,
  collapsed,
  toggleCollapse,
  sortable,
  isDropParent,
  dropIndicator,
  overlay,
  onCreateInside,
  focused,
  renameRequest,
  onRenameHandled,
  isOwner,
}: {
  workspaceId: string;
  item: FlatItem;
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  onOpenToSide?: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
  /** Whether this row participates in dnd-kit sorting. */
  sortable: boolean;
  /** Highlight — the folder the dragged item will drop into. */
  isDropParent?: boolean;
  /** Insertion line while dragging: which edge of this row, at what indent. */
  dropIndicator?: { edge: "before" | "after"; depth: number } | null;
  /** Rendered inside the DragOverlay (the lifted copy). */
  overlay?: boolean;
  /** Folder rows only — create an item inside this folder (⋯ menu). */
  onCreateInside?: (
    kind: "note" | "canvas" | "board" | "sheet",
    parentId: string
  ) => void;
  /** Keyboard roving focus (visual ring; the open item stays separate). */
  focused?: boolean;
  /** F2 on the focused row — flip into the inline rename input. */
  renameRequest?: boolean;
  onRenameHandled?: () => void;
  /** Workspace owner — may mint public share links for notes (9.1). */
  isOwner?: boolean;
}) {
  const { node, depth } = item;
  const expanded = !collapsed.has(node.id);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(node.title);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);

  useEffect(() => {
    if (renameRequest && canEdit && !overlay) {
      setDraftTitle(node.title);
      setRenaming(true);
      onRenameHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest]);

  const update = useUpdateWorkspaceItem(workspaceId);
  const remove = useDeleteWorkspaceItem(workspaceId);
  const archive = useArchiveWorkspaceItem(workspaceId);
  const setContext = useSetItemContext(workspaceId);
  const setPinned = useSetItemPinned(workspaceId);
  const duplicateItem = useDuplicateWorkspaceItem(workspaceId);
  const qc = useQueryClient();
  const [chatBusy, setChatBusy] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

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
      // Items go to the Trash (0138) — recoverable, so no scary confirm;
      // the toast's Undo restores in one click.
      remove.mutate(node.id, {
        onSuccess: () => {
          qc.invalidateQueries({
            queryKey: ["workspaces", "trash", workspaceId],
          });
          toast.success(`Moved “${node.title || "Untitled"}” to Trash`, {
            duration: 6000,
            action: {
              label: "Undo",
              onClick: () => {
                void workspacesApi
                  .restoreTrashed(workspaceId, node.id)
                  .then(() => {
                    invalidateTreeAndArchive();
                    qc.invalidateQueries({
                      queryKey: ["workspaces", "trash", workspaceId],
                    });
                  });
              },
            },
          });
        },
      });
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
    if (isFolder) toggleCollapse(node.id);
    else onSelect(node);
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

  // --- dnd-kit sortable ---
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    // The overlay copy gets a throwaway id so it never double-registers the
    // real row's id with the DnD context.
    id: overlay ? `${item.id}__overlay` : item.id,
    disabled: !sortable || renaming || overlay,
  });
  const dragHandle = sortable && !renaming ? { ...attributes, ...listeners } : {};

  return (
    <li
      id={overlay ? undefined : `ws-tree-row-${node.id}`}
      ref={overlay ? undefined : setNodeRef}
      className="relative"
      style={
        overlay
          ? undefined
          : { transform: CSS.Translate.toString(transform), transition }
      }
    >
      {/* Insertion line (drag): where the row will land, at its final indent. */}
      {dropIndicator && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-1 z-10 flex items-center",
            dropIndicator.edge === "before" ? "-top-[3px]" : "-bottom-[3px]"
          )}
          style={{ left: dropIndicator.depth * INDENT + 6 }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full border-2 border-[var(--accent)] bg-[var(--bg)]" />
          <span className="h-[3px] flex-1 rounded-full bg-[var(--accent)]" />
        </div>
      )}
      <div
        {...dragHandle}
        className={cn(
          // ``outline-none`` suppresses the browser's native blue focus ring —
          // the dnd-kit drag handle spreads a ``tabIndex`` onto this row, so a
          // click focuses it and Chromium would otherwise draw its default
          // outline. Selection + keyboard focus get their own styles below.
          // ``relative`` anchors the selected-row accent bar (below).
          "group relative flex items-center gap-1 rounded-md pr-1 text-sm outline-none transition-colors",
          // Match the chat sidebar's selected row: a neutral filled background
          // (not an outline), with the accent reserved for the icon (P1).
          isSelected
            ? "bg-[var(--hover-strong)] text-[var(--text)]"
            : "text-[var(--text)] hover:bg-[var(--hover)]",
          // Keyboard-nav focus keeps a subtle accent (not blue) ring — but
          // only when the row isn't the selected one (whose fill already marks
          // it), so a plain click reads as just the filled row, like chat.
          focused &&
            !overlay &&
            !isSelected &&
            "ring-1 ring-inset ring-[var(--accent)]/60",
          isDropParent &&
            "bg-[var(--accent)]/15 ring-2 ring-inset ring-[var(--accent)]/70",
          isDragging && !overlay && "opacity-40",
          // The lifted copy: shrink slightly (origin-left keeps it aligned to
          // the cursor) + shadow/ring so it reads as picked up.
          overlay &&
            "origin-left scale-[0.98] cursor-grabbing rounded-md bg-[var(--surface)] shadow-lg ring-1 ring-[var(--accent)]/40",
          sortable && !renaming && "cursor-grab active:cursor-grabbing"
        )}
        style={{ paddingLeft: depth * INDENT + 2 }}
      >
        {/* Selected-row accent bar — the little terracotta module pinned to
            the row's left edge, independent of indent depth. */}
        {isSelected && !overlay && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--accent)]"
          />
        )}
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1 py-1.5 text-left"
        >
          {isFolder ? (
            <span className="flex w-3 shrink-0 items-center justify-center text-[var(--text-muted)]">
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}

          {/* Context state: the *excluded* glyph is permanent (it's the
              exception worth flagging); the *included* glyph fades in on
              row hover so the on-state is discoverable without turning the
              rail into a wall of identical bolts. Toggle stays in ⋯.
              Non-context rows (folders, automations) reserve the same column
              with an empty spacer so every row's icon + title stay aligned. */}
          {isContextItem ? (
            contextOn ? (
              <span
                title="Included in this workspace's chat context. Toggle via the ⋯ menu."
                aria-label="Included in workspace context"
                className="inline-flex shrink-0 items-center text-[var(--accent)]/80 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Zap className="h-3 w-3 fill-current" />
              </span>
            ) : (
              <span
                title="Excluded from this workspace's chat context. Toggle via the ⋯ menu."
                aria-label="Excluded from workspace context"
                className="inline-flex shrink-0 items-center text-[var(--text-muted)]/70"
              >
                <ZapOff className="h-3 w-3" />
              </span>
            )
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}

          <NodeIcon node={node} expanded={expanded || !!isDropParent} />

          {renaming ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
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

          {node.visibility === "private" && !renaming && (
            <Lock
              className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
              aria-label="Private — only you can see this"
            />
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

        {editable && !renaming && !overlay && (
          <NodeActions
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
            onCreateInside={
              isFolder && onCreateInside
                ? (kind) => onCreateInside(kind, node.id)
                : undefined
            }
            onDuplicate={
              ["note", "sheet", "board", "canvas"].includes(node.kind)
                ? () => duplicateItem.mutate(node.id)
                : isTask && node.ref_id
                  ? () => {
                      // Automations are tasks, not items — copy arrives
                      // paused so it can't double-fire next to the source.
                      void tasksApi
                        .duplicate(node.ref_id as string)
                        .then(invalidateTreeAndArchive);
                    }
                  : undefined
            }
            visibility={
              // Only the creator may flip a draft (0134); others never even
              // receive private nodes, so this is about *my* items only.
              ["note", "sheet", "board", "canvas"].includes(node.kind) &&
              node.created_by === currentUserId
                ? node.visibility ?? "workspace"
                : null
            }
            onToggleVisibility={() =>
              update.mutate({
                itemId: node.id,
                payload: {
                  visibility:
                    node.visibility === "private" ? "workspace" : "private",
                },
              })
            }
            onChangeIcon={
              !isChat && !isTask ? () => setIconPickerOpen(true) : undefined
            }
            onShareLink={
              isOwner && node.kind === "note" && node.ref_id
                ? () => setShareLinkOpen(true)
                : undefined
            }
            isTemplate={node.is_template === true}
            onToggleTemplate={
              node.kind === "note"
                ? () =>
                    update.mutate({
                      itemId: node.id,
                      payload: {
                        config: node.is_template ? null : { template: true },
                      },
                    })
                : undefined
            }
            hasIcon={Boolean(node.icon)}
            onClearIcon={() =>
              update.mutate({ itemId: node.id, payload: { icon: null } })
            }
            deleting={remove.isPending || archive.isPending || chatBusy}
          />
        )}
      </div>
      {shareLinkOpen && node.ref_id && (
        <ShareLinkDialog
          open={shareLinkOpen}
          resource={{ kind: "file", id: node.ref_id, name: node.title }}
          onClose={() => setShareLinkOpen(false)}
        />
      )}
      {iconPickerOpen && (
        <EmojiPicker
          anchor={
            document
              .getElementById(`ws-tree-row-${node.id}`)
              ?.getBoundingClientRect() ?? null
          }
          onSelect={(emoji) => {
            update.mutate({ itemId: node.id, payload: { icon: emoji } });
            setIconPickerOpen(false);
          }}
          onClose={() => setIconPickerOpen(false)}
        />
      )}
    </li>
  );
}

// Per-kind pastel tile: a translucent tint behind a saturated glyph, so each
// item type reads at a glance from its colour AND shape. Same values in light
// + dark — the tint sits over the surface and the strokes stay legible on
// both grounds. (Reinstated after the P1 monochrome pass; the tinted tiles
// tested better in the marketing mock and the user asked to try them live.)
const KIND_TILE: Record<string, { tile: string; ink: string }> = {
  folder: { tile: "bg-[var(--accent-soft)]", ink: "text-[var(--accent)]" },
  chat: { tile: "bg-[rgba(217,119,87,0.16)]", ink: "text-[#D97757]" },
  note: { tile: "bg-[rgba(245,158,11,0.16)]", ink: "text-[#F59E0B]" },
  canvas: { tile: "bg-[rgba(59,130,246,0.16)]", ink: "text-[#3B82F6]" },
  board: { tile: "bg-[rgba(16,185,129,0.16)]", ink: "text-[#10B981]" },
  sheet: { tile: "bg-[rgba(236,72,153,0.16)]", ink: "text-[#EC4899]" },
  container: { tile: "bg-[rgba(139,92,246,0.16)]", ink: "text-[#8B5CF6]" },
  task: { tile: "bg-[rgba(100,116,139,0.18)]", ink: "text-[#64748B]" },
};

function NodeIcon({
  node,
  expanded,
}: {
  node: WorkspaceItemNode;
  expanded: boolean;
}) {
  const tileBase = "grid h-5 w-5 shrink-0 place-items-center rounded-md";
  // Respect an explicit emoji icon if the node carries one — render it inside
  // the same tile footprint so rows stay aligned.
  if (node.icon && isEmoji(node.icon)) {
    return (
      <span className={cn(tileBase, "text-[12px] leading-none")}>
        {node.icon}
      </span>
    );
  }
  const glyph = "h-3 w-3";
  const { tile, ink } = KIND_TILE[node.kind] ?? KIND_TILE.note;
  const Icon = (() => {
    switch (node.kind) {
      case "folder":
        return expanded ? FolderOpen : Folder;
      case "chat":
        return MessageSquare;
      case "canvas":
        return Shapes;
      case "board":
        return Columns3;
      case "sheet":
        return Table2;
      case "container":
        return Layers;
      case "task":
        // A clock reads "scheduled"; reserve the bolt for the context flag.
        return Clock;
      case "note":
      default:
        return FileText;
    }
  })();
  return (
    <span className={cn(tileBase, tile)}>
      <Icon className={cn(glyph, ink)} />
    </span>
  );
}

/** Crude emoji test — good enough to decide "render this string directly"
 *  vs "fall back to a lucide glyph". Matches common pictographic ranges. */
function isEmoji(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

function NodeActions({
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
  onCreateInside,
  onDuplicate,
  visibility,
  onToggleVisibility,
  onChangeIcon,
  hasIcon,
  onClearIcon,
  onShareLink,
  isTemplate,
  onToggleTemplate,
  deleting,
}: {
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
  /** Folders only — create a new item inside this folder. */
  onCreateInside?: (kind: "note" | "canvas" | "board" | "sheet") => void;
  /** Notes / sheets / boards / canvases — deep-copy as a sibling;
   *  automations — copy the task (arrives paused). */
  onDuplicate?: () => void;
  /** Current visibility when the caller may flip it (creator only,
   *  0134); null hides the menu entry. */
  visibility?: "workspace" | "private" | null;
  onToggleVisibility?: () => void;
  /** Open the emoji picker for this item's tree icon. */
  onChangeIcon?: () => void;
  hasIcon?: boolean;
  onClearIcon?: () => void;
  /** Manage public (guest) share links for this note (9.1; owner only). */
  onShareLink?: () => void;
  /** Note templates (9.3): current flag + toggle. */
  isTemplate?: boolean;
  onToggleTemplate?: () => void;
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
              {/* Creation-in-place for folders — drag-first stays the
                  organising gesture, but "make a note here" shouldn't
                  require creating at root and dragging it in. */}
              {onCreateInside && (
                <>
                  {(
                    [
                      { kind: "note", label: "New note here", icon: FileText },
                      { kind: "canvas", label: "New canvas here", icon: Shapes },
                      { kind: "board", label: "New board here", icon: Columns3 },
                      { kind: "sheet", label: "New sheet here", icon: Table2 },
                    ] as const
                  ).map((opt) => (
                    <MenuItem
                      key={opt.kind}
                      icon={<opt.icon className="h-3.5 w-3.5" />}
                      label={opt.label}
                      onClick={() => {
                        setMenuOpen(false);
                        onCreateInside(opt.kind);
                      }}
                    />
                  ))}
                  <div className="my-1 border-t border-[var(--border)]" />
                </>
              )}
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
              {onChangeIcon && (
                <MenuItem
                  icon={<Smile className="h-3.5 w-3.5" />}
                  label="Change icon"
                  onClick={() => {
                    setMenuOpen(false);
                    onChangeIcon();
                  }}
                />
              )}
              {hasIcon && onClearIcon && (
                <MenuItem
                  icon={<SmilePlus className="h-3.5 w-3.5" />}
                  label="Remove icon"
                  onClick={() => {
                    setMenuOpen(false);
                    onClearIcon();
                  }}
                />
              )}
              {onDuplicate && (
                <MenuItem
                  icon={<CopyIcon className="h-3.5 w-3.5" />}
                  label="Duplicate"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate();
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
              {onShareLink && (
                <MenuItem
                  icon={<Link2 className="h-3.5 w-3.5" />}
                  label="Public link…"
                  onClick={() => {
                    setMenuOpen(false);
                    onShareLink();
                  }}
                />
              )}
              {onToggleTemplate && (
                <MenuItem
                  icon={<LayoutTemplate className="h-3.5 w-3.5" />}
                  label={
                    isTemplate ? "Remove from templates" : "Save as template"
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleTemplate();
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
              {visibility && onToggleVisibility && (
                <MenuItem
                  icon={
                    visibility === "private" ? (
                      <Unlock className="h-3.5 w-3.5" />
                    ) : (
                      <Lock className="h-3.5 w-3.5" />
                    )
                  }
                  label={
                    visibility === "private"
                      ? "Share with workspace"
                      : "Make private"
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleVisibility();
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
                label={isChat || isTask ? "Delete" : "Move to Trash"}
                destructive
                disabled={deleting}
                onClick={async () => {
                  setMenuOpen(false);
                  // Items are recoverable from the Trash (0138) — no
                  // confirm needed; the toast's Undo covers slips. Chats
                  // and automations delete for real, so they still ask.
                  if (isChat || isTask) {
                    const ok = await confirm({
                      title: "Delete",
                      message: isChat
                        ? "Permanently delete this chat?"
                        : "Permanently delete this automation and its run history?",
                      confirmLabel: "Delete",
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  onDelete();
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
  onNewMeeting,
  onNewFromTemplate,
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
  /** Upload a meeting recording → transcribed + summarised note. */
  onNewMeeting?: () => void;
  /** Open the note-template picker (9.3). */
  onNewFromTemplate?: () => void;
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
            {onNewFromTemplate && (
              <MenuItem
                icon={<LayoutTemplate className="h-3.5 w-3.5" />}
                label="New from template"
                onClick={() => {
                  setOpen(false);
                  onNewFromTemplate();
                }}
              />
            )}
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
            {onNewMeeting && (
              <MenuItem
                icon={<AudioLines className="h-3.5 w-3.5" />}
                label="Meeting notes"
                onClick={() => {
                  setOpen(false);
                  onNewMeeting();
                }}
              />
            )}
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
