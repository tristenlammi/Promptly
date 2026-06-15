import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PenTool,
  Plus,
  Shapes,
  Trash2,
  Zap,
  ZapOff,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspaceItem,
  useCreateWorkspaceItem,
  useDeleteWorkspaceItem,
  useSetItemContext,
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
  canEdit,
}: {
  workspaceId: string;
  tree: WorkspaceItemNode[];
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
}) {
  const create = useCreateWorkspaceItem(workspaceId);
  const qc = useQueryClient();
  const { data: workspace } = useWorkspace(workspaceId);
  const [creatingChat, setCreatingChat] = useState(false);

  const handleCreate = async (
    kind: "folder" | "note" | "canvas",
    parentId: string | null
  ) => {
    const item = await create.mutateAsync({ kind, parent_id: parentId });
    // A freshly-created note or canvas should open straight away. Folders
    // just appear in place. We synthesise a node so the pane can open the
    // editor without waiting for the tree refetch.
    if (kind === "note" || kind === "canvas") {
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
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Items
        </span>
        {canEdit && (
          <NewMenu
            disabled={create.isPending || creatingChat}
            onNewChat={handleNewChat}
            onNewFolder={() => handleCreate("folder", null)}
            onNewNote={() => handleCreate("note", null)}
            onNewCanvas={() => handleCreate("canvas", null)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            Nothing here yet. Use{" "}
            <span className="font-medium text-[var(--text)]">+ New</span> to add
            a chat, note, canvas, or folder.
          </div>
        ) : (
          <ul>
            {tree.map((node) => (
              <TreeNode
                key={node.id}
                workspaceId={workspaceId}
                node={node}
                depth={0}
                selectedId={selectedId}
                onSelect={onSelect}
                canEdit={canEdit}
                onCreateInFolder={(kind, parentId) =>
                  handleCreate(kind, parentId)
                }
              />
            ))}
          </ul>
        )}
      </div>

      {/* Per-workspace Archive — pinned to the bottom of the rail. */}
      <WorkspaceArchiveSection workspaceId={workspaceId} canEdit={canEdit} />
    </div>
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
    const ok = window.confirm(
      node.kind === "chat"
        ? "Permanently delete this chat?"
        : node.kind === "folder"
          ? "Permanently delete this folder and everything inside it?"
          : "Permanently delete this item?"
    );
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
                    className="rounded p-1 text-red-500 hover:bg-red-500/10"
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
  canEdit,
  onCreateInFolder,
}: {
  workspaceId: string;
  node: WorkspaceItemNode;
  depth: number;
  selectedId: string | null;
  onSelect: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
  onCreateInFolder: (
    kind: "folder" | "note" | "canvas",
    parentId: string
  ) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(node.title);

  const update = useUpdateWorkspaceItem(workspaceId);
  const remove = useDeleteWorkspaceItem(workspaceId);
  const archive = useArchiveWorkspaceItem(workspaceId);
  const setContext = useSetItemContext(workspaceId);
  const qc = useQueryClient();
  const [chatBusy, setChatBusy] = useState(false);

  const isFolder = node.kind === "folder";
  const isChat = node.kind === "chat";
  // Only notes + canvases feed the workspace RAG context, so only they get
  // the "Use as workspace context" toggle. ``context_enabled`` defaults on.
  const isContextItem = node.kind === "note" || node.kind === "canvas";
  const contextOn = node.context_enabled !== false;
  // Every item gets a menu now (archive then delete). Chats are
  // synthesised, so their archive/delete go through the conversation
  // endpoints; folders/notes/canvases through the workspace_items ones.
  const editable = canEdit;

  const invalidateTreeAndArchive = () => {
    qc.invalidateQueries({ queryKey: ["workspaces", "tree", workspaceId] });
    qc.invalidateQueries({ queryKey: ["workspaces", "archive", workspaceId] });
  };

  const handleArchive = async () => {
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
    } else {
      remove.mutate(node.id);
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
      await update.mutateAsync({ itemId: node.id, payload: { title: next } });
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
          {isContextItem && !contextOn && !renaming && (
            <span
              title="Not used as workspace context"
              className="inline-flex shrink-0 items-center text-[var(--text-muted)]"
            >
              <ZapOff className="h-3 w-3" />
            </span>
          )}
        </button>

        {editable && !renaming && (
          <NodeActions
            isFolder={isFolder}
            isChat={isChat}
            onRename={
              isChat
                ? undefined
                : () => {
                    setDraftTitle(node.title);
                    setRenaming(true);
                  }
            }
            onArchive={handleArchive}
            onDelete={handleDelete}
            onNewNote={() => onCreateInFolder("note", node.id)}
            onNewCanvas={() => onCreateInFolder("canvas", node.id)}
            onNewFolder={() => onCreateInFolder("folder", node.id)}
            contextState={isContextItem ? (contextOn ? "on" : "off") : null}
            onToggleContext={
              isContextItem
                ? () =>
                    setContext.mutate({ itemId: node.id, enabled: !contextOn })
                : undefined
            }
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
              canEdit={canEdit}
              onCreateInFolder={onCreateInFolder}
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
  onRename,
  onArchive,
  onDelete,
  onNewNote,
  onNewCanvas,
  onNewFolder,
  contextState,
  onToggleContext,
  deleting,
}: {
  isFolder: boolean;
  isChat: boolean;
  /** Omitted for chats (synthesised — no in-tree rename). */
  onRename?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onNewNote: () => void;
  onNewCanvas: () => void;
  onNewFolder: () => void;
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
                    icon={<FolderPlus className="h-3.5 w-3.5" />}
                    label="New folder"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewFolder();
                    }}
                  />
                </>
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
              {/* Archive first (the soft step), then permanent delete. */}
              <MenuItem
                icon={<Archive className="h-3.5 w-3.5" />}
                label="Archive"
                disabled={deleting}
                onClick={() => {
                  setMenuOpen(false);
                  onArchive();
                }}
              />
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label="Delete"
                destructive
                disabled={deleting}
                onClick={() => {
                  setMenuOpen(false);
                  if (
                    window.confirm(
                      isFolder
                        ? "Permanently delete this folder and everything inside it?"
                        : isChat
                          ? "Permanently delete this chat?"
                          : "Permanently delete this item?"
                    )
                  ) {
                    onDelete();
                  }
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
          ? "text-red-500 hover:bg-red-500/10"
          : "text-[var(--text)] hover:bg-[var(--accent)]/10"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function NewMenu({
  onNewChat,
  onNewFolder,
  onNewNote,
  onNewCanvas,
  disabled,
}: {
  /** Top-level only — chats live at the workspace root, not in folders. */
  onNewChat?: () => void;
  onNewFolder: () => void;
  onNewNote: () => void;
  onNewCanvas: () => void;
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
            className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)] py-1 shadow-lg"
          >
            {onNewChat && (
              <MenuItem
                icon={<MessageSquare className="h-3.5 w-3.5" />}
                label="New chat"
                onClick={() => {
                  setOpen(false);
                  onNewChat();
                }}
              />
            )}
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
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label="New folder"
              onClick={() => {
                setOpen(false);
                onNewFolder();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
