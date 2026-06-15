import { useState } from "react";
import {
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
  Plus,
  Trash2,
} from "lucide-react";

import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useCreateWorkspaceItem,
  useDeleteWorkspaceItem,
  useUpdateWorkspaceItem,
} from "@/hooks/useWorkspaces";
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

  const handleCreate = async (
    kind: "folder" | "note",
    parentId: string | null
  ) => {
    const item = await create.mutateAsync({ kind, parent_id: parentId });
    // A freshly-created note should open straight away. Folders just
    // appear in place. We synthesise a node so the pane can open the
    // editor without waiting for the tree refetch.
    if (kind === "note") {
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Items
        </span>
        {canEdit && (
          <NewMenu
            disabled={create.isPending}
            onNewFolder={() => handleCreate("folder", null)}
            onNewNote={() => handleCreate("note", null)}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            Nothing here yet. Use{" "}
            <span className="font-medium text-[var(--text)]">+ New</span> to add
            a note or folder.
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
  onCreateInFolder: (kind: "folder" | "note", parentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(node.title);

  const update = useUpdateWorkspaceItem(workspaceId);
  const remove = useDeleteWorkspaceItem(workspaceId);

  const isFolder = node.kind === "folder";
  const isChat = node.kind === "chat";
  // Chats are synthesised — no rename/delete from the tree.
  const editable = canEdit && !isChat;

  const indexing =
    node.indexing_status === "queued" || node.indexing_status === "embedding";

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
        </button>

        {editable && !renaming && (
          <NodeActions
            isFolder={isFolder}
            onRename={() => {
              setDraftTitle(node.title);
              setRenaming(true);
            }}
            onDelete={() => remove.mutate(node.id)}
            onNewNote={() => onCreateInFolder("note", node.id)}
            onNewFolder={() => onCreateInFolder("folder", node.id)}
            deleting={remove.isPending}
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
  onRename,
  onDelete,
  onNewNote,
  onNewFolder,
  deleting,
}: {
  isFolder: boolean;
  onRename: () => void;
  onDelete: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
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
              <MenuItem
                icon={<Pencil className="h-3.5 w-3.5" />}
                label="Rename"
                onClick={() => {
                  setMenuOpen(false);
                  onRename();
                }}
              />
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
                    icon={<FolderPlus className="h-3.5 w-3.5" />}
                    label="New folder"
                    onClick={() => {
                      setMenuOpen(false);
                      onNewFolder();
                    }}
                  />
                </>
              )}
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
                        ? "Delete this folder and everything inside it?"
                        : "Delete this note?"
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
  onNewFolder,
  onNewNote,
  disabled,
}: {
  onNewFolder: () => void;
  onNewNote: () => void;
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
            <MenuItem
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              label="New note"
              onClick={() => {
                setOpen(false);
                onNewNote();
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
