import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  Home,
  Loader2,
} from "lucide-react";

import { filesApi, type FileScope, type FolderItem } from "@/api/files";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

type Kind = "file" | "folder";

interface MoveItemModalProps {
  open: boolean;
  scope: FileScope;
  /** What's being moved — used for the title and to disable invalid targets. */
  kind: Kind;
  itemId: string;
  itemName: string;
  /** Folder the item currently lives in (so we can mark it as the source). */
  currentParentId: string | null;
  onClose: () => void;
  onSubmit: (targetFolderId: string | null) => Promise<void>;
}

interface TreeNode {
  folder: FolderItem;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: TreeNode[];
}

/**
 * Folder picker that lazy-loads children via the existing browse endpoint.
 *
 * Validation:
 *   - The item's current parent is highlighted as "current" and disabled.
 *   - When moving a folder, that folder itself is hidden from the tree.
 *     Descendants are still shown (cheap to flatten); the backend rejects
 *     descendant targets with a clear 400 if the user picks one.
 */
export function MoveItemModal({
  open,
  scope,
  kind,
  itemId,
  itemName,
  currentParentId,
  onClose,
  onSubmit,
}: MoveItemModalProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Reload the top level whenever the modal opens (also when scope changes).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTarget(undefined);
    setSubmitErr(null);
    setRootError(null);
    setRootLoading(true);
    filesApi
      .browse(scope, null)
      .then((res) => {
        if (cancelled) return;
        setRoots(
          res.folders
            .filter((f) => !(kind === "folder" && f.id === itemId))
            .map((f) => makeNode(f, 0))
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setRootError(e instanceof Error ? e.message : "Failed to load folders");
      })
      .finally(() => {
        if (!cancelled) setRootLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scope, itemId, kind]);

  const toggle = async (node: TreeNode) => {
    if (node.expanded) {
      mutateNode(node, (n) => {
        n.expanded = false;
      });
      setRoots((r) => [...r]);
      return;
    }
    if (node.loaded) {
      mutateNode(node, (n) => {
        n.expanded = true;
      });
      setRoots((r) => [...r]);
      return;
    }
    mutateNode(node, (n) => {
      n.loading = true;
      n.expanded = true;
    });
    setRoots((r) => [...r]);
    try {
      const res = await filesApi.browse(scope, node.folder.id);
      mutateNode(node, (n) => {
        n.children = res.folders
          .filter((f) => !(kind === "folder" && f.id === itemId))
          .map((f) => makeNode(f, node.depth + 1));
        n.loaded = true;
        n.loading = false;
      });
    } catch {
      mutateNode(node, (n) => {
        n.loading = false;
        n.expanded = false;
      });
    }
    setRoots((r) => [...r]);
  };

  const handleSubmit = async () => {
    if (target === undefined) return;
    if (target === currentParentId) {
      onClose();
      return;
    }
    setBusy(true);
    setSubmitErr(null);
    try {
      await onSubmit(target);
    } catch (e) {
      setSubmitErr(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const rootIsCurrent = currentParentId === null;
  const rootSelected = target === null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move ${kind === "folder" ? "folder" : "file"}`}
      description={`Choose a destination for “${itemName}”.`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            loading={busy}
            disabled={target === undefined || target === currentParentId}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => !rootIsCurrent && setTarget(null)}
          disabled={rootIsCurrent}
          className={cn(
            "flex w-full items-center gap-2 rounded-input border px-3 py-2 text-left text-sm transition",
            rootIsCurrent
              ? "cursor-not-allowed border-[var(--border)] bg-[var(--bg)] opacity-60"
              : rootSelected
                ? "border-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          )}
        >
          <Home className="h-4 w-4 text-[var(--text-muted)]" />
          <span className="font-medium">
            {scope === "mine" ? "My files" : "Shared"} (root)
          </span>
          {rootIsCurrent && (
            <span className="ml-auto text-xs text-[var(--text-muted)]">
              current
            </span>
          )}
        </button>

        <div className="max-h-72 overflow-y-auto rounded-input border border-[var(--border)] bg-[var(--bg)]">
          {rootLoading && (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading folders…
            </div>
          )}
          {!rootLoading && rootError && (
            <div className="px-3 py-3 text-sm text-red-600 dark:text-red-400">
              {rootError}
            </div>
          )}
          {!rootLoading && !rootError && roots.length === 0 && (
            <div className="px-3 py-3 text-sm text-[var(--text-muted)]">
              No subfolders. Pick the root above.
            </div>
          )}
          {!rootLoading && !rootError && roots.length > 0 && (
            <ul className="py-1">
              {roots.map((n) => (
                <TreeRow
                  key={n.folder.id}
                  node={n}
                  selected={target ?? undefined}
                  currentParentId={currentParentId}
                  onSelect={setTarget}
                  onToggle={toggle}
                />
              ))}
            </ul>
          )}
        </div>

        {submitErr && (
          <p className="text-sm text-red-600 dark:text-red-400">{submitErr}</p>
        )}
      </div>
    </Modal>
  );
}

function TreeRow({
  node,
  selected,
  currentParentId,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  selected: string | undefined;
  currentParentId: string | null;
  onSelect: (id: string) => void;
  onToggle: (n: TreeNode) => void;
}) {
  const isCurrent = node.folder.id === currentParentId;
  const isSelected = selected === node.folder.id;
  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 px-1 py-0.5",
          isSelected && "bg-[var(--accent)]/10"
        )}
        style={{ paddingLeft: 4 + node.depth * 16 }}
      >
        <button
          type="button"
          onClick={() => onToggle(node)}
          className="rounded p-1 text-[var(--text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          aria-label={node.expanded ? "Collapse" : "Expand"}
        >
          {node.loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : node.expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          onClick={() => !isCurrent && onSelect(node.folder.id)}
          disabled={isCurrent}
          className={cn(
            "flex flex-1 items-center gap-2 truncate rounded px-2 py-1 text-left text-sm transition",
            isCurrent
              ? "cursor-not-allowed text-[var(--text-muted)]"
              : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          )}
        >
          <FolderIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <span className="truncate">{node.folder.name}</span>
          {isCurrent && (
            <span className="ml-auto text-xs text-[var(--text-muted)]">
              current
            </span>
          )}
        </button>
      </div>
      {node.expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeRow
              key={c.folder.id}
              node={c}
              selected={selected}
              currentParentId={currentParentId}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function makeNode(folder: FolderItem, depth: number): TreeNode {
  return {
    folder,
    depth,
    expanded: false,
    loaded: false,
    loading: false,
    children: [],
  };
}

/** In-place tree mutation; caller is responsible for triggering a re-render. */
function mutateNode(node: TreeNode, fn: (n: TreeNode) => void) {
  fn(node);
}

function extractError(e: unknown): string {
  if (typeof e === "object" && e && "response" in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
