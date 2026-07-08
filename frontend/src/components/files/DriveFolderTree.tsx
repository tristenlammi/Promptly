import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Home,
  Loader2,
} from "lucide-react";

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
 * Refinements:
 *  - **Preserve expansion on refresh** — a folder mutation bumps ``version``;
 *    the reload reconciles against the live tree so open folders stay open
 *    instead of the rail collapsing under the user.
 *  - **Auto-expand to the current folder** — navigating (from the content
 *    pane, a link, …) reveals that folder in the rail by expanding its
 *    ancestor chain (resolved from the flat folder list).
 *  - **"+ New folder"** right in the rail (desktop); the toolbar keeps its
 *    own for mobile, where the rail is hidden.
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

/** Rebuild the top level from a fresh fetch while carrying each still-present
 *  folder's expansion + already-loaded children forward, so a ``version`` bump
 *  (create / move / trash) doesn't collapse the rail. */
function reconcile(prev: TreeNode[], fresh: FolderItem[]): TreeNode[] {
  const byId = new Map(prev.map((n) => [n.folder.id, n]));
  return fresh.map((f) => {
    const old = byId.get(f.id);
    if (!old) return makeNode(f, 0);
    // Keep expansion + children (they're already at the right depth); just
    // refresh the folder row data (name/rename).
    return { ...old, folder: f };
  });
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.folder.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

export function DriveFolderTree({
  scope,
  currentFolderId,
  onNavigate,
  onNewFolder,
  /** Bumped by the parent after a folder mutation (create / move / trash)
   *  so the tree reloads its top level. */
  version = 0,
}: {
  scope: FileScope;
  currentFolderId: string | null;
  onNavigate: (folderId: string | null) => void;
  /** Opens the parent's "new folder" flow (creates in the current folder). */
  onNewFolder?: () => void;
  version?: number;
}) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // System folders (Chat Uploads, Generated Files, Workspaces…) are
  // tucked into a collapsed group at the bottom of the rail so the
  // top level reads as *your* folders rather than echoing the content
  // pane's full listing. Collapsed by default; opens on demand.
  const [systemOpen, setSystemOpen] = useState(false);

  // Latest roots for async orchestration (auto-expand) without stale closures.
  const rootsRef = useRef<TreeNode[]>(roots);
  rootsRef.current = roots;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    filesApi
      .browse(scope, null)
      .then((res) => {
        if (cancelled) return;
        // Preserve expansion across a version reload; a scope switch starts
        // fresh (different tree entirely).
        setRoots((prev) => reconcile(prev, res.folders));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, version]);

  // A scope switch is a different tree — drop the carried-over expansion.
  useEffect(() => {
    setRoots([]);
  }, [scope]);

  const loadChildren = useCallback(
    async (node: TreeNode) => {
      if (node.loaded) return;
      node.loading = true;
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
    },
    [scope]
  );

  const toggle = useCallback(
    async (node: TreeNode) => {
      if (node.expanded) {
        node.expanded = false;
        setRoots((r) => [...r]);
        return;
      }
      node.expanded = true;
      await loadChildren(node);
    },
    [loadChildren]
  );

  // Auto-expand the ancestor chain down to the current folder so navigating
  // to it (from anywhere) reveals it in the rail. Path resolved from the flat
  // folder list, which only covers the personal Drive ("mine" scope).
  useEffect(() => {
    if (!currentFolderId || scope !== "mine" || roots.length === 0) return;
    // Already visible? Nothing to do.
    if (findNode(rootsRef.current, currentFolderId)) return;
    let cancelled = false;
    (async () => {
      let all: { id: string; parent_id: string | null; name: string }[];
      try {
        all = await filesApi.allFolders();
      } catch {
        return;
      }
      if (cancelled) return;
      const byId = new Map(all.map((f) => [f.id, f]));
      // Build the ancestor chain (top-level → parent-of-current).
      const chain: string[] = [];
      let cur = byId.get(currentFolderId);
      while (cur && cur.parent_id) {
        chain.unshift(cur.parent_id);
        cur = byId.get(cur.parent_id);
      }
      // Expand each ancestor in order, loading children as we descend.
      for (const id of chain) {
        if (cancelled) return;
        const node = findNode(rootsRef.current, id);
        if (!node) break; // chain left the visible tree (system subtree etc.)
        node.expanded = true;
        await loadChildren(node);
      }
      if (!cancelled) setRoots((r) => [...r]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, scope, roots.length, loadChildren]);

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
          {scope === "mine" ? "Drive" : "Shared with me"}
        </span>
      </button>

      {onNewFolder && scope === "mine" && (
        <button
          type="button"
          onClick={onNewFolder}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--accent)]"
          title="New folder here"
        >
          <FolderPlus className="h-4 w-4 shrink-0" />
          <span className="truncate">New folder</span>
        </button>
      )}

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
        {roots
          .filter((n) => !n.folder.system_kind)
          .map((n) => (
            <TreeRow
              key={n.folder.id}
              node={n}
              currentFolderId={currentFolderId}
              onNavigate={onNavigate}
              onToggle={toggle}
            />
          ))}
      </ul>

      {roots.some((n) => n.folder.system_kind) && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setSystemOpen((o) => !o)}
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] transition hover:text-[var(--text)]"
            aria-expanded={systemOpen}
          >
            {systemOpen ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            System
          </button>
          {systemOpen && (
            <ul>
              {roots
                .filter((n) => n.folder.system_kind)
                .map((n) => (
                  <TreeRow
                    key={n.folder.id}
                    node={n}
                    currentFolderId={currentFolderId}
                    onNavigate={onNavigate}
                    onToggle={toggle}
                  />
                ))}
            </ul>
          )}
        </div>
      )}
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
