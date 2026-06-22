import { useEffect, useState } from "react";
import { ChevronRight, Home, Loader2 } from "lucide-react";

import { filesApi, type FileScope, type FolderItem } from "@/api/files";
import { DriveItemIcon } from "./DriveItemIcon";
import { cn } from "@/utils/cn";

/**
 * Persistent folder-tree rail for the Drive browse view — the two-pane
 * "navigate the hierarchy without drilling through breadcrumbs" affordance
 * that makes Files read like a real drive. Children lazy-load via the
 * existing ``/files/browse`` endpoint (same pattern as the Move modal), so
 * a deep tree costs nothing until expanded.
 *
 * Desktop-only by design (the caller hides it under ``lg``); on mobile the
 * breadcrumb + sub-nav carry navigation.
 */
interface TreeNode {
  folder: FolderItem;
  depth: number;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: TreeNode[];
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

export function DriveFolderTree({
  scope,
  currentFolderId,
  onNavigate,
  /** Bumped by the parent after a folder mutation (create / move / trash)
   *  so the tree reloads its top level. */
  version = 0,
}: {
  scope: FileScope;
  currentFolderId: string | null;
  onNavigate: (folderId: string | null) => void;
  version?: number;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    filesApi
      .browse(scope, null)
      .then((res) => {
        if (cancelled) return;
        setRoots(res.folders.map((f) => makeNode(f, 0)));
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load folders");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, version]);

  const toggle = async (node: TreeNode) => {
    if (node.expanded) {
      node.expanded = false;
      setRoots((r) => [...r]);
      return;
    }
    if (node.loaded) {
      node.expanded = true;
      setRoots((r) => [...r]);
      return;
    }
    node.loading = true;
    node.expanded = true;
    setRoots((r) => [...r]);
    try {
      const res = await filesApi.browse(scope, node.folder.id);
      node.children = res.folders.map((f) => makeNode(f, node.depth + 1));
      node.loaded = true;
    } catch {
      node.expanded = false;
    } finally {
      node.loading = false;
      setRoots((r) => [...r]);
    }
  };

  return (
    <nav aria-label="Folders" className="flex flex-col gap-0.5 p-2 text-sm">
      <button
        type="button"
        onClick={() => onNavigate(null)}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition",
          currentFolderId === null
            ? "bg-[var(--accent)]/10 font-medium text-[var(--text)]"
            : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        )}
      >
        <Home className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {scope === "mine" ? "My files" : "Shared with me"}
        </span>
      </button>

      {loading && roots.length === 0 && (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div className="px-2 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <ul>
        {roots.map((n) => (
          <TreeRow
            key={n.folder.id}
            node={n}
            currentFolderId={currentFolderId}
            onNavigate={onNavigate}
            onToggle={toggle}
          />
        ))}
      </ul>
    </nav>
  );
}

function TreeRow({
  node,
  currentFolderId,
  onNavigate,
  onToggle,
}: {
  node: TreeNode;
  currentFolderId: string | null;
  onNavigate: (id: string | null) => void;
  onToggle: (n: TreeNode) => void;
}) {
  const active = node.folder.id === currentFolderId;
  return (
    <li>
      <div
        className={cn(
          "group flex items-center rounded-md transition",
          active ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]"
        )}
        style={{ paddingLeft: 2 + node.depth * 14 }}
      >
        <button
          type="button"
          onClick={() => onToggle(node)}
          className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
          aria-label={node.expanded ? "Collapse" : "Expand"}
        >
          {node.loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                node.expanded && "rotate-90"
              )}
            />
          )}
        </button>
        <button
          type="button"
          onClick={() => onNavigate(node.folder.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left",
            active
              ? "font-medium text-[var(--text)]"
              : "text-[var(--text-muted)] group-hover:text-[var(--text)]"
          )}
          title={node.folder.name}
        >
          <DriveItemIcon folder={node.folder} className="h-4 w-4" />
          <span className="truncate">{node.folder.name}</span>
        </button>
      </div>
      {node.expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeRow
              key={c.folder.id}
              node={c}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
