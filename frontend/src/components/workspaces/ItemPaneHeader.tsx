import { useEffect, useState } from "react";
import {
  CalendarDays,
  Clock,
  Columns3,
  Copy,
  FileText,
  Loader2,
  Shapes,
  Table2,
  Zap,
  ZapOff,
} from "lucide-react";

import type { WorkspaceItemKind, WorkspaceItemNode } from "@/api/workspaces";
import {
  useDuplicateWorkspaceItem,
  useSetItemContext,
  useUpdateWorkspaceItem,
  useWorkspaceTree,
} from "@/hooks/useWorkspaces";
import { cn } from "@/utils/cn";

// Icons must match the navigator rail's NodeIcon so an item shows the same
// symbol in its pane title as in the nav.
const KIND_ICONS: Partial<Record<WorkspaceItemKind, typeof FileText>> = {
  note: FileText,
  canvas: Shapes,
  board: Columns3,
  sheet: Table2,
  roster: CalendarDays,
  task: Clock,
};

/** Kinds the duplicate endpoint supports (canvas scenes live in their
 *  collab doc — not yet copyable server-side; automations have their own
 *  lifecycle). */
const DUPLICABLE: WorkspaceItemKind[] = ["note", "sheet", "board"];

/**
 * The unified chrome every workspace item pane shares (Phase 5): kind
 * icon + rename-in-place title, the context-⚡ toggle, a Duplicate
 * action where supported, a pane-supplied status slot (collab / save
 * chips), and pane-specific `extra` controls on the right.
 *
 * Title + context state are read live from the tree query so renames
 * and toggles made in the navigator reflect here instantly (the
 * `node` prop the pane mounted with is just a snapshot).
 *
 * Notes keep the DocumentEditorModal's own header (it already carries
 * title/save/collab and is shared with Drive documents); chat panes keep
 * the chat top bar. This header is for canvas / sheet / board /
 * automation panes.
 */
export function ItemPaneHeader({
  workspaceId,
  itemId,
  kind,
  fallbackTitle,
  canEdit,
  status,
  extra,
  onRename,
}: {
  workspaceId: string;
  itemId: string;
  kind: WorkspaceItemKind;
  fallbackTitle: string;
  canEdit: boolean;
  /** Pane-supplied live chips: Connected / Syncing / Saved …. */
  status?: React.ReactNode;
  /** Pane-specific right-side controls (view toggles, Run now, …). */
  extra?: React.ReactNode;
  /** Override the rename path (automations rename their task, not a
   *  workspace item). Default: PATCH the workspace item. */
  onRename?: (title: string) => Promise<void> | void;
}) {
  const { data: tree } = useWorkspaceTree(workspaceId);
  const live = findNode(tree ?? [], itemId);
  const title = live?.title ?? fallbackTitle;
  // Synthesised nodes (automations) aren't workspace items — no ⚡/PATCH.
  const isRealItem = kind !== "task";

  const updateItem = useUpdateWorkspaceItem(workspaceId);
  const duplicate = useDuplicateWorkspaceItem(workspaceId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  // Keep the draft in step with outside renames while not editing.
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    if (onRename) void onRename(next);
    else updateItem.mutate({ itemId, payload: { title: next } });
  };

  const Icon = KIND_ICONS[kind] ?? FileText;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1.5">
      <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              setDraft(title);
            }
          }}
          className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--surface)] px-1.5 py-0.5 text-sm font-semibold text-[var(--text)] outline-none"
          aria-label="Item title"
        />
      ) : (
        <button
          type="button"
          onClick={() => canEdit && setEditing(true)}
          className={cn(
            "min-w-0 truncate rounded px-1.5 py-0.5 text-left text-sm font-semibold text-[var(--text)]",
            canEdit && "transition hover:bg-[var(--hover)]",
            !canEdit && "cursor-default"
          )}
          title={canEdit ? "Rename" : title}
        >
          {title || "Untitled"}
        </button>
      )}

      {isRealItem && (
        <ItemContextToggle
          workspaceId={workspaceId}
          itemId={itemId}
          canEdit={canEdit}
        />
      )}

      {canEdit && DUPLICABLE.includes(kind) && (
        <button
          type="button"
          disabled={duplicate.isPending}
          onClick={() => duplicate.mutate(itemId)}
          title="Duplicate"
          aria-label="Duplicate item"
          className="shrink-0 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
        >
          {duplicate.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {status}
        {extra}
      </span>
    </div>
  );
}

/**
 * The ⚡ "use this item as workspace chat context" toggle. Extracted so
 * panes that don't use {@link ItemPaneHeader} (notes keep the document
 * editor's own header) can drop in the identical control. Reads the live
 * ``context_enabled`` from the tree so it stays in sync with the navigator.
 */
export function ItemContextToggle({
  workspaceId,
  itemId,
  canEdit,
}: {
  workspaceId: string;
  itemId: string;
  canEdit: boolean;
}) {
  const { data: tree } = useWorkspaceTree(workspaceId);
  const live = findNode(tree ?? [], itemId);
  const contextOn = (live?.context_enabled ?? true) !== false;
  const setContext = useSetItemContext(workspaceId);
  return (
    <button
      type="button"
      disabled={!canEdit || setContext.isPending}
      onClick={() => setContext.mutate({ itemId, enabled: !contextOn })}
      title={
        contextOn
          ? "Included in this workspace's chat context — click to exclude"
          : "Excluded from this workspace's chat context — click to include"
      }
      aria-pressed={contextOn}
      className={cn(
        "shrink-0 rounded p-1 transition disabled:cursor-default disabled:opacity-60",
        contextOn
          ? "text-[var(--accent)] hover:bg-[var(--accent)]/10"
          : "text-[var(--text-muted)]/70 hover:bg-[var(--hover)]"
      )}
    >
      {contextOn ? (
        <Zap className="h-3.5 w-3.5 fill-current" />
      ) : (
        <ZapOff className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function findNode(
  nodes: WorkspaceItemNode[],
  id: string
): WorkspaceItemNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const sub = findNode(n.children, id);
    if (sub) return sub;
  }
  return null;
}
