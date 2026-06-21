import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { lazyWithRetry } from "@/utils/lazyWithRetry";
import { cn } from "@/utils/cn";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  FolderX,
  Columns3,
  Layers,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Shapes,
  Table2,
  Share2,
  Upload,
  Users,
  Zap,
  ZapOff,
  X,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { ShareWorkspaceDialog } from "@/components/chat/ShareWorkspaceDialog";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { TopNav } from "@/components/layout/TopNav";
import {
  parseWikiHref,
  type WikiTarget,
} from "@/components/files/documents/WikiLinkExtension";
// Lazy so the (large) Excalidraw editor chunk only downloads when a
// canvas is actually opened, not on every workspace visit. Wrapped so a
// stale chunk after a redeploy auto-reloads instead of dead-ending on the
// "Failed to fetch dynamically imported module" error boundary.
const WorkspaceCanvasPane = lazyWithRetry(
  () =>
    import("@/components/workspaces/WorkspaceCanvasPane").then((m) => ({
      default: m.WorkspaceCanvasPane,
    })),
  "WorkspaceCanvasPane"
);
// Lazy too — the Fortune-sheet editor chunk is large and only needed when a
// spreadsheet page is opened.
const WorkspaceSheetPane = lazyWithRetry(
  () =>
    import("@/components/workspaces/WorkspaceSheetPane").then((m) => ({
      default: m.WorkspaceSheetPane,
    })),
  "WorkspaceSheetPane"
);
import { WorkspaceCommandPalette } from "@/components/workspaces/WorkspaceCommandPalette";
import { WorkspaceBoardPane } from "@/components/workspaces/WorkspaceBoardPane";
import { WorkspaceNavigatorTree } from "@/components/workspaces/WorkspaceNavigatorTree";
import { WorkspaceOverviewPane } from "@/components/workspaces/WorkspaceOverviewPane";
import { WorkspaceSettingsContent } from "@/components/workspaces/WorkspaceSettingsDrawer";
import { ChatPage } from "./ChatPage";
import { filesApi, type FileItem } from "@/api/files";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspace,
  useBulkRemoveConversationsFromWorkspace,
  useCreateWorkspaceItem,
  useDeleteWorkspaceItem,
  useItemBacklinks,
  useMoveWorkspaceItem,
  useSetItemContext,
  useUpdateWorkspaceItem,
  useWorkspace,
  useWorkspaceConversations,
  useWorkspaceTree,
  useDeleteWorkspace,
  useUnarchiveWorkspace,
} from "@/hooks/useWorkspaces";

/**
 * Workspace detail page (Phase 1c) — rail + main-pane navigator.
 *
 * Left rail: the workspace's item tree (folders / notes / chats).
 * Main pane: the selected item rendered full-height. A note opens the
 * Drive document editor; a chat navigates to its conversation. Settings
 * (instructions, default model, members, usage, pinned files, lifecycle)
 * moved into a slide-over drawer behind the gear button.
 */
export function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: workspace, isLoading } = useWorkspace(id);
  const { data: conversations } = useWorkspaceConversations(id);
  const { data: tree, isLoading: treeLoading } = useWorkspaceTree(id);
  const [searchParams, setSearchParams] = useSearchParams();

  const [selected, setSelected] = useState<WorkspaceItemNode | null>(null);
  const [secondary, setSecondary] = useState<WorkspaceItemNode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Persist the open item(s) in the URL so a refresh restores the view
  // instead of dropping back to the workspace home. ``item`` is the primary
  // pane; ``item2`` the split-screen secondary.
  const findNode = useCallback(
    (
      nodes: WorkspaceItemNode[] | undefined,
      target: string | null
    ): WorkspaceItemNode | null => {
      if (!nodes || !target) return null;
      for (const n of nodes) {
        if (n.id === target) return n;
        const found = findNode(n.children, target);
        if (found) return found;
      }
      return null;
    },
    []
  );

  // Restore selection from the URL once the tree is available — once per
  // workspace id, so closing an item later doesn't re-open it, and a
  // workspace switch re-reads (and clears stale state).
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tree || !id || restoredForRef.current === id) return;
    restoredForRef.current = id;
    const primary = findNode(tree, searchParams.get("item"));
    setSelected(primary);
    const split = findNode(tree, searchParams.get("item2"));
    setSecondary(split && split.id !== primary?.id ? split : null);
  }, [tree, id, searchParams, findNode]);

  // Mirror the current selection back into the URL (replace, so selecting
  // items doesn't pile up browser history). Guarded until restore has run
  // for this id so we never clobber the param before reading it.
  useEffect(() => {
    if (restoredForRef.current !== id) return;
    const next = new URLSearchParams(searchParams);
    if (selected) next.set("item", selected.id);
    else next.delete("item");
    if (secondary) next.set("item2", secondary.id);
    else next.delete("item2");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [selected, secondary, id, searchParams, setSearchParams]);

  // ⌘K / Ctrl+K opens the workspace command palette (jump / ask).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const archive = useArchiveWorkspace();
  const unarchive = useUnarchiveWorkspace();
  const remove = useDeleteWorkspace();
  const bulkRemoveConversations = useBulkRemoveConversationsFromWorkspace(
    id ?? ""
  );

  if (!id) return null;

  const isArchived = Boolean(workspace?.archived_at);
  const isOwner = (workspace?.role ?? "owner") === "owner";
  const canEdit = (workspace?.access_role ?? "owner") !== "viewer";
  const collaboratorCount = workspace?.collaborators?.length ?? 0;

  // Everything — chats included — opens inline in the main pane so the
  // rail + nav stay put. (Folders are toggled in the tree, not selected.)
  const handleSelect = (node: WorkspaceItemNode) => {
    // Avoid the same item on both sides of a split.
    if (secondary && secondary.id === node.id) setSecondary(null);
    setSettingsOpen(false);
    setSelected(node);
  };

  // Split-screen: open a note/canvas/chat alongside the primary one. Folders
  // can't be split (they only nest); with no primary yet, it just opens
  // normally on the left.
  const handleOpenToSide = (node: WorkspaceItemNode) => {
    if (node.kind === "folder") return;
    if (!selected) {
      setSelected(node);
      return;
    }
    if (selected.id === node.id) return;
    setSecondary(node);
  };

  // Closing the left pane while a split is open promotes the right pane.
  const closePrimary = () => {
    if (secondary) {
      setSelected(secondary);
      setSecondary(null);
    } else {
      setSelected(null);
    }
  };

  return (
    <>
      <TopNav
        title={workspace?.title ?? "Workspace"}
        subtitle={
          workspace?.description
            ? workspace.description
            : workspace?.role === "collaborator" && workspace?.shared_by
              ? `Shared by ${workspace.shared_by.username}`
              : "Notes, chats, and shared instructions"
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              leftIcon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => navigate("/workspaces")}
            >
              Back
            </Button>
            <Button
              variant="ghost"
              leftIcon={<Search className="h-4 w-4" />}
              onClick={() => setPaletteOpen(true)}
              title="Search items or ask this workspace (⌘K)"
            >
              <span className="hidden items-center gap-1 sm:inline-flex">
                Ask
                <kbd className="rounded border border-[var(--border)] px-1 text-[10px] text-[var(--text-muted)]">
                  ⌘K
                </kbd>
              </span>
            </Button>
            {!isArchived && isOwner && (
              <Button
                variant="ghost"
                leftIcon={<Share2 className="h-4 w-4" />}
                onClick={() => setShareOpen(true)}
                title="Share this workspace with a teammate"
              >
                {collaboratorCount > 0 ? `Share (${collaboratorCount})` : "Share"}
              </Button>
            )}
            {!isArchived && canEdit && (
              <Button
                variant="ghost"
                leftIcon={<Upload className="h-4 w-4" />}
                onClick={() => setImportOpen(true)}
              >
                Import
              </Button>
            )}
          </div>
        }
      />

      {isLoading || !workspace ? (
        <div className="flex flex-1 items-center gap-2 px-6 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading workspace...
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Left rail — navigator tree */}
          <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg)]">
            {treeLoading && !tree ? (
              <div className="flex items-center gap-2 px-4 py-4 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : (
              <WorkspaceNavigatorTree
                workspaceId={id}
                tree={tree ?? []}
                selectedId={selected?.id ?? null}
                onSelect={handleSelect}
                onOpenToSide={handleOpenToSide}
                canEdit={canEdit && !isArchived}
                onHome={() => {
                  setSettingsOpen(false);
                  setSelected(null);
                  setSecondary(null);
                }}
                atHome={!selected && !settingsOpen}
                onSettings={() => {
                  setSecondary(null);
                  setSettingsOpen(true);
                }}
                atSettings={settingsOpen}
              />
            )}
          </aside>

          {/* Main pane */}
          <main
            className={
              "flex min-w-0 flex-1 flex-col " +
              (secondary || settingsOpen ? "overflow-hidden" : "overflow-y-auto")
            }
          >
            {settingsOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-5 py-2.5">
                  <h2 className="truncate text-sm font-semibold text-[var(--text)]">
                    {workspace.title} · Settings
                  </h2>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    title="Close settings"
                    aria-label="Close settings"
                    className="shrink-0 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <WorkspaceSettingsContent
                  workspace={workspace}
                  isOwner={isOwner}
                  canEdit={canEdit}
                  onArchive={async () => {
                    const ok = await confirm({
                      title: "Archive workspace",
                      message:
                        "Archive this workspace? It moves to your archived list and can be restored anytime.",
                      confirmLabel: "Archive",
                    });
                    if (ok) archive.mutate(workspace.id);
                  }}
                  onUnarchive={() => unarchive.mutate(workspace.id)}
                  onDelete={() => {
                    setSettingsOpen(false);
                    setDeleteOpen(true);
                  }}
                  archivePending={archive.isPending}
                  unarchivePending={unarchive.isPending}
                />
              </div>
            ) : secondary && selected ? (
              // Split screen — primary on the left, secondary on the right,
              // with a draggable gutter. The chat side defaults narrower
              // (chats cap their own width, so a full half wastes space);
              // ``key`` remounts the split when which-side-is-chat changes
              // so it re-reads the right saved width.
              (() => {
                const chatSide =
                  selected.kind === "chat" && secondary.kind !== "chat"
                    ? "left"
                    : secondary.kind === "chat" && selected.kind !== "chat"
                      ? "right"
                      : "even";
                const defaultLeftFraction =
                  chatSide === "left" ? 0.4 : chatSide === "right" ? 0.6 : 0.5;
                return (
                  <ResizableSplit
                    key={chatSide}
                    storageKey={`promptly.workspaceSplit.${chatSide}`}
                    defaultLeftFraction={defaultLeftFraction}
                    left={
                      <>
                        <SplitPaneHeader
                          title={selected.title}
                          onClose={closePrimary}
                        />
                        <WorkspaceItemView
                          key={selected.id}
                          node={selected}
                          workspaceId={id}
                          onOpenItem={handleSelect}
                          onClose={closePrimary}
                          canEdit={canEdit}
                        />
                      </>
                    }
                    right={
                      <>
                        <SplitPaneHeader
                          title={secondary.title}
                          onClose={() => setSecondary(null)}
                        />
                        <WorkspaceItemView
                          key={secondary.id}
                          node={secondary}
                          workspaceId={id}
                          onOpenItem={handleSelect}
                          onClose={() => setSecondary(null)}
                          canEdit={canEdit}
                        />
                      </>
                    }
                  />
                );
              })()
            ) : (
              <WorkspaceMainPane
                key={selected?.id ?? "empty"}
                node={selected}
                workspaceId={id}
                workspaceTitle={workspace.title}
                onOpenItem={handleSelect}
                onCloseNote={() => setSelected(null)}
                isArchived={isArchived}
                isOwner={isOwner}
                hasConversations={(conversations?.length ?? 0) > 0}
                onUnarchive={() => unarchive.mutate(workspace.id)}
                onDissolve={() => bulkRemoveConversations.mutate()}
                dissolvePending={bulkRemoveConversations.isPending}
                collaboratorNames={(workspace.collaborators ?? []).map(
                  (c) => c.username
                )}
                sharedByName={
                  !isOwner ? (workspace.shared_by?.username ?? null) : null
                }
                canEdit={canEdit}
              />
            )}
          </main>
        </div>
      )}

      <ImportConversationsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        defaultWorkspaceId={id}
      />

      {workspace && isOwner && (
        <ShareWorkspaceDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          workspaceId={workspace.id}
          workspaceTitle={workspace.title}
        />
      )}


      <ConfirmDoubleModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!workspace) return;
          await remove.mutateAsync(workspace.id);
          navigate("/workspaces");
        }}
        destructive
        pending={remove.isPending}
        firstTitle="Delete this workspace?"
        firstDescription={
          workspace
            ? `"${workspace.title}" will be deleted. Conversations inside it are preserved and will move back to your top-level chat list. Pinned files stay in your library.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={
          workspace
            ? `Type the workspace title to confirm permanent deletion of "${workspace.title}".`
            : ""
        }
        typeToConfirm={workspace?.title}
        secondConfirmLabel="Delete workspace"
      />

      <WorkspaceCommandPalette
        workspaceId={id}
        tree={tree ?? []}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectNode={handleSelect}
      />
    </>
  );
}

// ---------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------

function WorkspaceMainPane({
  node,
  workspaceId,
  workspaceTitle,
  onOpenItem,
  onCloseNote,
  isArchived,
  isOwner,
  hasConversations,
  onUnarchive,
  onDissolve,
  dissolvePending,
  collaboratorNames,
  sharedByName,
  canEdit,
}: {
  node: WorkspaceItemNode | null;
  workspaceId: string;
  workspaceTitle: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
  onCloseNote: () => void;
  isArchived: boolean;
  isOwner: boolean;
  hasConversations: boolean;
  onUnarchive: () => void;
  onDissolve: () => void;
  dissolvePending: boolean;
  collaboratorNames: string[];
  sharedByName: string | null;
  canEdit: boolean;
}) {
  if (
    node &&
    (node.kind === "note" ||
      node.kind === "canvas" ||
      node.kind === "chat" ||
      node.kind === "board" ||
      node.kind === "sheet" ||
      node.kind === "container")
  ) {
    return (
      <WorkspaceItemView
        node={node}
        workspaceId={workspaceId}
        onOpenItem={onOpenItem}
        onClose={onCloseNote}
        canEdit={canEdit}
      />
    );
  }

  // No item selected → the workspace overview home (counts + tasks +
  // recent), preceded by any archive/share banners.
  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-4xl px-6 pt-6 empty:hidden">
      {isArchived && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <Archive className="h-3.5 w-3.5" />
            This workspace is archived. Unarchive to add new chats and items.
          </span>
          {isOwner && (
            <div className="flex shrink-0 items-center gap-2">
              {hasConversations && (
                <Button
                  variant="ghost"
                  leftIcon={<FolderX className="h-3.5 w-3.5" />}
                  onClick={onDissolve}
                  disabled={dissolvePending}
                  title="Move all chats back to your top-level list"
                >
                  {dissolvePending ? "Moving…" : "Move all chats out"}
                </Button>
              )}
              <Button
                variant="ghost"
                leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                onClick={onUnarchive}
              >
                Unarchive
              </Button>
            </div>
          )}
        </div>
      )}

      {isOwner && collaboratorNames.length > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)]">
          <Users className="h-3.5 w-3.5 shrink-0" />
          <span>
            Shared with{" "}
            <span className="font-medium text-[var(--text)]">
              {collaboratorNames.join(", ")}
            </span>
            . They can see and edit every chat in this workspace.
          </span>
        </div>
      )}

      {sharedByName && (
        <div
          className={
            "mb-4 flex items-center gap-2 rounded-card border p-3 text-xs " +
            (canEdit
              ? "border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[var(--text)]"
              : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200")
          }
        >
          <Users
            className={
              "h-3.5 w-3.5 shrink-0 " +
              (canEdit ? "text-[var(--accent)]" : "text-amber-500")
            }
          />
          <span>
            {canEdit ? (
              <>
                You have collaborator access to this workspace, shared by{" "}
                <span className="font-medium">{sharedByName}</span>. You can see
                and edit every chat in it.
              </>
            ) : (
              <>
                <span className="font-semibold">View-only access</span> — shared
                by <span className="font-medium">{sharedByName}</span>. You can
                read its chats, notes, and files but not change them.
              </>
            )}
          </span>
        </div>
      )}

      </div>

      <WorkspaceOverviewPane
        workspaceId={workspaceId}
        title={workspaceTitle}
        onOpenItem={onOpenItem}
        canEdit={canEdit && !isArchived}
      />
    </div>
  );
}

/**
 * Two panes side by side with a draggable gutter between them. ``left``
 * gets ``leftFraction`` of the width (clamped 20–80%); the gutter drag
 * updates and persists it under ``storageKey``. ``defaultLeftFraction``
 * seeds the first-ever layout (we narrow the chat side — chats cap their
 * own content width, so a full half is wasted space).
 */
function ResizableSplit({
  storageKey,
  defaultLeftFraction,
  left,
  right,
}: {
  storageKey: string;
  defaultLeftFraction: number;
  left: ReactNode;
  right: ReactNode;
}) {
  const MIN = 0.2;
  const MAX = 0.8;
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const fractionRef = useRef(defaultLeftFraction);
  const [fraction, setFraction] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    const f =
      Number.isFinite(stored) && stored >= MIN && stored <= MAX
        ? stored
        : defaultLeftFraction;
    fractionRef.current = f;
    return f;
  });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(
        MAX,
        Math.max(MIN, (e.clientX - rect.left) / rect.width)
      );
      fractionRef.current = next;
      setFraction(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(storageKey, String(fractionRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [storageKey]);

  const startDrag = (e: ReactPointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div
        className="flex min-w-0 flex-col overflow-hidden"
        style={{ width: `${fraction * 100}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startDrag}
        className="relative w-px shrink-0 cursor-col-resize bg-[var(--border)] hover:bg-[var(--accent,#D97757)]"
      >
        {/* Wider invisible hit area so the 1px gutter is easy to grab. */}
        <div className="absolute inset-y-0 -left-2 -right-2" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{right}</div>
    </div>
  );
}

/** Thin title bar above each pane in split-screen mode, with a close. */
function SplitPaneHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">
        {title || "Untitled"}
      </span>
      <button
        type="button"
        onClick={onClose}
        title="Close this pane"
        aria-label="Close pane"
        className="shrink-0 rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Renders a single workspace item (note / canvas / chat). Pulled out of
 * ``WorkspaceMainPane`` so the same renderer drives both the primary pane
 * and the split-screen secondary pane.
 */
function WorkspaceItemView({
  node,
  workspaceId,
  onOpenItem,
  onClose,
  canEdit,
  embeddedInNotebook = false,
}: {
  node: WorkspaceItemNode;
  workspaceId: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
  onClose: () => void;
  canEdit: boolean;
  /** True when rendered as a notebook page — suppresses chrome (e.g. the
   *  chat's "Back to workspace" bar) that the notebook tab strip replaces. */
  embeddedInNotebook?: boolean;
}) {
  if (node.kind === "note") {
    return (
      <WorkspaceNotePane
        node={node}
        workspaceId={workspaceId}
        onClose={onClose}
        onOpenItem={onOpenItem}
        canEdit={canEdit}
      />
    );
  }
  if (node.kind === "canvas") {
    return (
      <WorkspaceCanvasPaneFrame node={node} canEdit={canEdit} />
    );
  }
  if (node.kind === "sheet" && node.ref_id) {
    return (
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading sheet…
            </span>
          </div>
        }
      >
        <WorkspaceSheetPane
          workspaceId={workspaceId}
          sheetId={node.ref_id}
          canEdit={canEdit}
        />
      </Suspense>
    );
  }
  if (node.kind === "chat" && node.ref_id) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPage
          embedded
          embeddedConversationId={node.ref_id}
          onExitToWorkspace={onClose}
          hideWorkspaceBar={embeddedInNotebook}
        />
      </div>
    );
  }
  if (node.kind === "board") {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <WorkspaceBoardPane
            workspaceId={workspaceId}
            boardItemId={node.id}
            canEdit={canEdit}
            onOpenItem={onOpenItem}
          />
        </div>
      </div>
    );
  }
  if (node.kind === "container") {
    return (
      <WorkspaceNotebookPane
        node={node}
        workspaceId={workspaceId}
        canEdit={canEdit}
        onOpenItem={onOpenItem}
      />
    );
  }
  return null;
}

/**
 * Renders a selected note in the main pane by fetching its backing Drive
 * Document and reusing the existing collaborative editor.
 *
 * The editor is a full-screen portal modal (``DocumentEditorModal``). Per
 * the MVP brief, rendering it on select is the accepted reuse path — it
 * carries the entire TipTap + Yjs collab stack with zero re-plumbing.
 * While the file loads we show a placeholder so the pane isn't blank.
 */
function WorkspaceNotePane({
  node,
  workspaceId,
  onClose,
  onOpenItem,
  canEdit,
}: {
  node: WorkspaceItemNode;
  workspaceId: string;
  onClose: () => void;
  onOpenItem: (node: WorkspaceItemNode) => void;
  canEdit: boolean;
}) {
  const [file, setFile] = useState<FileItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateItem = useUpdateWorkspaceItem(workspaceId);
  // Track the title we last reflected into the tree so repeated content
  // saves (which also fire onFileUpdated) don't re-PATCH on every keystroke.
  const syncedTitleRef = useRef(node.title);

  // Renaming a note in the editor renames its Drive file but not the
  // navigator item — keep the rail label in lockstep by syncing the item
  // title (extension stripped) whenever the document's name changes.
  const syncNoteTitle = useCallback(
    (f: FileItem) => {
      if (!canEdit) return;
      const name = stripDocExt(f.filename).trim();
      if (name && name !== syncedTitleRef.current) {
        syncedTitleRef.current = name;
        updateItem.mutate({ itemId: node.id, payload: { title: name } });
      }
    },
    [node.id, canEdit, updateItem]
  );

  // Workspace tree → flat list of linkable targets for the ``[[``
  // autocomplete + click-to-open title lookup. Folders aren't linkable.
  const { data: tree } = useWorkspaceTree(workspaceId);
  const linkables = useMemo(() => collectLinkables(tree ?? []), [tree]);

  const wikiItems = useCallback(
    async (query: string): Promise<WikiTarget[]> => {
      const q = query.trim().toLowerCase();
      return linkables
        .filter((n) => n.id !== node.id)
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((n) => ({
          id: n.id,
          kind: n.kind,
          refId: n.ref_id,
          title: n.title,
          workspaceId,
        }));
    },
    [linkables, node.id, workspaceId]
  );
  const wikiLink = useMemo(() => ({ items: wikiItems }), [wikiItems]);

  const handleEditorClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      const parsed = parseWikiHref(anchor.getAttribute("href"));
      if (!parsed) return;
      e.preventDefault();
      e.stopPropagation();
      const known = linkables.find((n) => n.id === parsed.item);
      onOpenItem(
        known ?? {
          id: parsed.item,
          kind: parsed.kind as WorkspaceItemNode["kind"],
          ref_id: parsed.ref,
          title: "",
          icon: null,
          position: 0,
          indexing_status: null,
          children: [],
        }
      );
    },
    [linkables, onOpenItem]
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFile(null);
    syncedTitleRef.current = node.title;
    if (!node.ref_id) {
      setError("This note has no underlying document.");
      return;
    }
    filesApi
      .getFile(node.ref_id)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        syncNoteTitle(f);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? "Couldn't open this note.";
        setError(detail);
      });
    return () => {
      cancelled = true;
    };
  }, [node.id, node.ref_id]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening “{node.title || "note"}”…
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        onClickCapture={handleEditorClick}
      >
        <DocumentEditorModal
          file={file}
          inline
          onClose={onClose}
          onFileUpdated={(f) => {
            setFile(f);
            syncNoteTitle(f);
          }}
          wikiLink={wikiLink}
        />
      </div>
      <BacklinksPanel
        workspaceId={workspaceId}
        itemId={node.id}
        onOpenItem={onOpenItem}
      />
    </div>
  );
}

/** Kinds a notebook page can be. */
type NotebookPageKind = "note" | "sheet" | "canvas" | "board" | "chat";

const NOTEBOOK_ADD_KINDS: { kind: NotebookPageKind; label: string }[] = [
  { kind: "note", label: "Note" },
  { kind: "sheet", label: "Sheet" },
  { kind: "canvas", label: "Canvas" },
  { kind: "board", label: "Board" },
  { kind: "chat", label: "Chat" },
];

function notebookPageIcon(kind: string) {
  switch (kind) {
    case "sheet":
      return Table2;
    case "canvas":
      return Shapes;
    case "board":
      return Columns3;
    case "chat":
      return MessageSquare;
    default:
      return FileText;
  }
}

/** Recursive lookup of a tree node by id (the selected snapshot can go stale
 *  after pages are added; panes re-derive from the live tree with this). */
function findNodeById(
  nodes: WorkspaceItemNode[],
  id: string
): WorkspaceItemNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNodeById(n.children, id);
    if (found) return found;
  }
  return null;
}

/**
 * A Notebook: a container whose child items render as a tab strip. Each tab
 * dispatches to the normal per-kind pane (note / sheet / canvas / board), so a
 * single notebook can hold a mix of everything. Pages are real child items —
 * created, renamed, and deleted through the same item API as the tree — so
 * RAG, collab, and delete all work per-page with no special plumbing.
 */
function WorkspaceNotebookPane({
  node,
  workspaceId,
  canEdit,
  onOpenItem,
}: {
  node: WorkspaceItemNode;
  workspaceId: string;
  canEdit: boolean;
  onOpenItem: (node: WorkspaceItemNode) => void;
}) {
  // Read the live tree so newly added / renamed / deleted pages appear — the
  // ``node`` passed down is a snapshot taken when the notebook was selected.
  const { data: tree } = useWorkspaceTree(workspaceId);
  const container = useMemo(
    () => findNodeById(tree ?? [], node.id) ?? node,
    [tree, node]
  );
  const pages = container.children ?? [];

  const create = useCreateWorkspaceItem(workspaceId);
  const updateItem = useUpdateWorkspaceItem(workspaceId);
  const del = useDeleteWorkspaceItem(workspaceId);
  const setContext = useSetItemContext(workspaceId);
  const move = useMoveWorkspaceItem(workspaceId);

  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (pages.length === 0) {
      setActiveId(null);
      return;
    }
    setActiveId((cur) =>
      cur && pages.some((p) => p.id === cur) ? cur : pages[0].id
    );
  }, [pages]);

  const active = pages.find((p) => p.id === activeId) ?? null;

  const addPage = useCallback(
    async (kind: NotebookPageKind) => {
      try {
        const item = await create.mutateAsync({ kind, parent_id: node.id });
        setActiveId(item.id);
      } catch {
        // Surfaced by the mutation error toast.
      }
    },
    [create, node.id]
  );

  const deletePage = useCallback(
    async (pageId: string) => {
      const ok = await confirm({
        title: "Delete page",
        message: "Permanently delete this page?",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const remaining = pages.filter((p) => p.id !== pageId);
      del.mutate(pageId, {
        onSuccess: () => {
          if (activeId === pageId) setActiveId(remaining[0]?.id ?? null);
        },
      });
    },
    [pages, activeId, del]
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <NotebookTabs
        pages={pages}
        activeId={activeId}
        canEdit={canEdit}
        adding={create.isPending}
        onSelect={setActiveId}
        onAdd={addPage}
        onRename={(pageId, title) =>
          updateItem.mutate({ itemId: pageId, payload: { title } })
        }
        onDelete={deletePage}
        onToggleContext={(pageId, enabled) =>
          setContext.mutate({ itemId: pageId, enabled })
        }
        onReorder={(pageId, position) =>
          move.mutate({
            itemId: pageId,
            payload: { parent_id: node.id, position },
          })
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {active ? (
          <WorkspaceItemView
            key={active.id}
            node={active}
            workspaceId={workspaceId}
            onOpenItem={onOpenItem}
            onClose={() => {}}
            canEdit={canEdit}
            embeddedInNotebook
          />
        ) : (
          <NotebookEmptyState
            canEdit={canEdit}
            adding={create.isPending}
            onAdd={addPage}
          />
        )}
      </div>
    </div>
  );
}

function NotebookEmptyState({
  canEdit,
  adding,
  onAdd,
}: {
  canEdit: boolean;
  adding: boolean;
  onAdd: (kind: NotebookPageKind) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <Layers className="h-8 w-8 text-[var(--text-muted)]" />
      <div className="text-sm text-[var(--text-muted)]">
        This notebook is empty.
        {canEdit ? " Add its first page:" : ""}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {NOTEBOOK_ADD_KINDS.map(({ kind, label }) => {
            const Icon = notebookPageIcon(kind);
            return (
              <button
                key={kind}
                type="button"
                disabled={adding}
                onClick={() => onAdd(kind)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text)] transition hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Tab strip for a Notebook's pages (child items). The scrollable tab list is
 * isolated in its own ``overflow-x-auto`` container so the "+" add menu — a
 * sibling outside that container — is never clipped.
 */
function NotebookTabs({
  pages,
  activeId,
  canEdit,
  adding,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onToggleContext,
  onReorder,
}: {
  pages: WorkspaceItemNode[];
  activeId: string | null;
  canEdit: boolean;
  adding: boolean;
  onSelect: (id: string) => void;
  onAdd: (kind: NotebookPageKind) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onToggleContext: (id: string, enabled: boolean) => void;
  onReorder: (id: string, position: number) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  if (pages.length === 0 && !canEdit) return null;

  const commitRename = (id: string) => {
    const next = draftTitle.trim();
    const cur = pages.find((p) => p.id === id)?.title ?? "";
    if (next && next !== cur) onRename(id, next);
    setRenamingId(null);
  };

  const pick = (kind: NotebookPageKind) => {
    setAddOpen(false);
    onAdd(kind);
  };

  // Reorder: drop the dragged page immediately *before* the target. We
  // compute a float midpoint between the target and its left neighbour
  // (among the other pages) so no full renumber is needed — the same
  // scheme the navigator tree uses.
  const handleDropBefore = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const others = pages.filter((p) => p.id !== dragId);
    const idx = others.findIndex((p) => p.id === targetId);
    if (idx < 0) return;
    const target = others[idx];
    const prev = others[idx - 1];
    const before = prev ? prev.position : target.position - 1;
    onReorder(dragId, (before + target.position) / 2);
  };

  return (
    <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {pages.map((p) => {
          const active = p.id === activeId;
          const Icon = notebookPageIcon(p.kind);
          if (renamingId === p.id) {
            return (
              <input
                key={p.id}
                autoFocus
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => commitRename(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(p.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="min-w-[6rem] rounded-md border border-[var(--accent)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] outline-none"
              />
            );
          }
          const contextOn = p.context_enabled !== false;
          return (
            <div
              key={p.id}
              draggable={canEdit}
              onDragStart={() => setDragId(p.id)}
              onDragOver={(e) => {
                if (canEdit && dragId) e.preventDefault();
              }}
              onDrop={() => {
                handleDropBefore(p.id);
                setDragId(null);
              }}
              onDragEnd={() => setDragId(null)}
              className={cn(
                "group inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition",
                canEdit && "cursor-grab active:cursor-grabbing",
                dragId === p.id && "opacity-50",
                active
                  ? "bg-[var(--accent)]/15 text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                onDoubleClick={() => {
                  if (!canEdit) return;
                  setDraftTitle(p.title);
                  setRenamingId(p.id);
                }}
                className="inline-flex max-w-[12rem] items-center gap-1.5 truncate"
                title={
                  canEdit
                    ? "Click to open · double-click to rename · drag to reorder"
                    : p.title
                }
              >
                <Icon className="h-3 w-3 shrink-0 opacity-70" />
                <span className="truncate">{p.title || "Untitled"}</span>
              </button>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onToggleContext(p.id, !contextOn)}
                  className={cn(
                    "transition",
                    contextOn
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-muted)] opacity-0 group-hover:opacity-100"
                  )}
                  aria-label={
                    contextOn
                      ? "Used as workspace context — click to exclude"
                      : "Excluded from workspace context — click to include"
                  }
                  title={
                    contextOn
                      ? "Used as workspace context (click to exclude)"
                      : "Excluded from workspace context (click to include)"
                  }
                >
                  {contextOn ? (
                    <Zap className="h-3 w-3" />
                  ) : (
                    <ZapOff className="h-3 w-3" />
                  )}
                </button>
              )}
              {canEdit && pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => onDelete(p.id)}
                  className="opacity-0 transition group-hover:opacity-100"
                  aria-label="Delete page"
                  title="Delete page"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            disabled={adding}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] disabled:opacity-50 dark:hover:bg-white/[0.06]"
            title="Add a page"
            aria-haspopup="menu"
            aria-expanded={addOpen}
          >
            {adding ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            <span>Page</span>
          </button>
          {addOpen && (
            <>
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => setAddOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
              >
                {NOTEBOOK_ADD_KINDS.map(({ kind, label }) => {
                  const Icon = notebookPageIcon(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      onClick={() => pick(kind)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--text)] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                      <Icon className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Flatten the workspace tree into the set of wiki-linkable items
 *  (everything but folders). Used for ``[[`` autocomplete + click-to-open
 *  title resolution. */
/** A note's rail title is its Drive filename without the document
 *  extension — matches how the backend derives the note title. */
function stripDocExt(name: string): string {
  return name.replace(/\.(html?|md)$/i, "");
}

function collectLinkables(nodes: WorkspaceItemNode[]): WorkspaceItemNode[] {
  const out: WorkspaceItemNode[] = [];
  const walk = (list: WorkspaceItemNode[]) => {
    for (const n of list) {
      if (n.kind === "folder") {
        walk(n.children);
      } else {
        out.push(n);
        if (n.children.length) walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** "Linked from" strip below a note — lists the notes that wiki-link to
 *  it. Hidden entirely when there are no backlinks so it stays
 *  unobtrusive. Each row opens its source note inline. */
function BacklinksPanel({
  workspaceId,
  itemId,
  onOpenItem,
}: {
  workspaceId: string;
  itemId: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
}) {
  const { data: backlinks } = useItemBacklinks(workspaceId, itemId);
  if (!backlinks || backlinks.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        <Link2 className="h-3 w-3" />
        Linked from ({backlinks.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {backlinks.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onOpenItem(b)}
            className="inline-flex max-w-xs items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] transition hover:bg-[var(--accent)]/10"
            title={b.title || "Untitled"}
          >
            <FileText className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
            <span className="truncate">{b.title || "Untitled"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Inline frame for a selected canvas item. Unlike the note pane (which
 * pops the document editor as a modal), the canvas renders a real inline
 * editor — Excalidraw fills this positioned, full-height container.
 *
 * The canvas item's ``ref_id`` is the canvas id the collab room + token
 * endpoints key off. Viewers (no edit access) get a read-only board.
 */
function WorkspaceCanvasPaneFrame({
  node,
  canEdit,
}: {
  node: WorkspaceItemNode;
  canEdit: boolean;
}) {
  if (!node.ref_id) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          This canvas has no underlying board.
        </div>
      </div>
    );
  }
  return (
    // ``min-h-0`` lets this flex child shrink so the absolutely-positioned
    // Excalidraw surface gets a real height inside the scrolling main pane.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
            Loading canvas…
          </div>
        }
      >
        <WorkspaceCanvasPane canvasId={node.ref_id} readOnly={!canEdit} />
      </Suspense>
    </div>
  );
}

