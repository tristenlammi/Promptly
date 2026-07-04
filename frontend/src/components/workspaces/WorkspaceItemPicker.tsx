import { useMemo, useState } from "react";
import {
  Clock,
  Columns3,
  FileText,
  Layers,
  MessageSquare,
  PenTool,
  Search,
  Table2,
} from "lucide-react";

import type { WorkspaceItemKind, WorkspaceItemNode } from "@/api/workspaces";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

const KIND_ICONS: Partial<Record<WorkspaceItemKind, typeof FileText>> = {
  note: FileText,
  canvas: PenTool,
  board: Columns3,
  sheet: Table2,
  chat: MessageSquare,
  container: Layers,
  task: Clock,
};
const KIND_LABELS: Partial<Record<WorkspaceItemKind, string>> = {
  note: "Note",
  canvas: "Canvas",
  board: "Board",
  sheet: "Sheet",
  chat: "Chat",
  container: "Notebook",
  task: "Automation",
};

/**
 * Modal picker for choosing a workspace item to link to. Flattens the
 * navigator tree (folders excluded), filters by a search box, and calls
 * ``onPick`` with the chosen node. Shared by the canvas link affordance;
 * the board keeps its own inline picker.
 */
export function WorkspaceItemPicker({
  workspaceId,
  excludeIds,
  onPick,
  onClose,
  title = "Link to workspace item",
}: {
  workspaceId: string;
  /** Items to hide (e.g. the current item, already-linked ids). */
  excludeIds?: Set<string>;
  onPick: (node: WorkspaceItemNode) => void;
  onClose: () => void;
  title?: string;
}) {
  const { data: tree } = useWorkspaceTree(workspaceId);
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const out: WorkspaceItemNode[] = [];
    const walk = (nodes: WorkspaceItemNode[]) => {
      for (const n of nodes) {
        if (n.kind === "folder") {
          walk(n.children);
          continue;
        }
        if (!excludeIds?.has(n.id)) out.push(n);
        if (n.children.length) walk(n.children);
      }
    };
    walk(tree ?? []);
    return out;
  }, [tree, excludeIds]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((n) => (n.title || "").toLowerCase().includes(q))
    : items;

  return (
    <Modal open onClose={onClose} title={title}>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items…"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] py-1.5 pl-8 pr-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
        />
      </div>
      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
            {items.length === 0
              ? "This workspace has no linkable items yet."
              : "No items match your search."}
          </p>
        ) : (
          filtered.map((n) => {
            const Icon = KIND_ICONS[n.kind] ?? FileText;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => onPick(n)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition",
                  "text-[var(--text)] hover:bg-[var(--hover)]"
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate">
                  {n.title || "Untitled"}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {KIND_LABELS[n.kind] ?? n.kind}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}
