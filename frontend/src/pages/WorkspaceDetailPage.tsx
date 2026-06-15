import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  FolderX,
  Home,
  Link2,
  Loader2,
  Network,
  Plus,
  Search,
  Settings,
  Share2,
  Upload,
  Users,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { ShareWorkspaceDialog } from "@/components/chat/ShareWorkspaceDialog";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { TopNav } from "@/components/layout/TopNav";
import {
  parseWikiHref,
  type WikiTarget,
} from "@/components/files/documents/WikiLinkExtension";
import { WorkspaceCanvasPane } from "@/components/workspaces/WorkspaceCanvasPane";
import { WorkspaceCommandPalette } from "@/components/workspaces/WorkspaceCommandPalette";
import { WorkspaceGraphPane } from "@/components/workspaces/WorkspaceGraphPane";
import { WorkspaceNavigatorTree } from "@/components/workspaces/WorkspaceNavigatorTree";
import { WorkspaceOverviewPane } from "@/components/workspaces/WorkspaceOverviewPane";
import { WorkspaceSettingsDrawer } from "@/components/workspaces/WorkspaceSettingsDrawer";
import { useQueryClient } from "@tanstack/react-query";
import { ChatPage } from "./ChatPage";
import { chatApi } from "@/api/chat";
import { filesApi, type FileItem } from "@/api/files";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspace,
  useBulkRemoveConversationsFromWorkspace,
  useItemBacklinks,
  useWorkspace,
  useWorkspaceConversations,
  useWorkspaceTree,
  useDeleteWorkspace,
  useUnarchiveWorkspace,
} from "@/hooks/useWorkspaces";
import { useModelStore } from "@/store/modelStore";

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
  const qc = useQueryClient();
  const { data: workspace, isLoading } = useWorkspace(id);
  const { data: conversations } = useWorkspaceConversations(id);
  const { data: tree, isLoading: treeLoading } = useWorkspaceTree(id);

  const [selected, setSelected] = useState<WorkspaceItemNode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);

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
    setGraphOpen(false);
    setSelected(node);
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
              variant={!selected && !graphOpen ? "primary" : "ghost"}
              leftIcon={<Home className="h-4 w-4" />}
              onClick={() => {
                setGraphOpen(false);
                setSelected(null);
              }}
              title="Workspace home — overview, tasks, and recent items"
            >
              <span className="hidden sm:inline">Home</span>
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
            <Button
              variant={graphOpen ? "primary" : "ghost"}
              leftIcon={<Network className="h-4 w-4" />}
              onClick={() => setGraphOpen((g) => !g)}
              title="Graph view — see how items connect"
            >
              <span className="hidden sm:inline">Graph</span>
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
            {!isArchived && canEdit && (
              <Button
                variant="primary"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() =>
                  workspace &&
                  handleNewChat(workspace, (conv) => {
                    // Open the new chat inline + refresh the tree so it
                    // appears in the rail.
                    setSelected({
                      id: conv.id,
                      kind: "chat",
                      ref_id: conv.id,
                      title: conv.title ?? "New chat",
                      icon: null,
                      position: 0,
                      indexing_status: null,
                      children: [],
                    });
                    void qc.invalidateQueries({
                      queryKey: ["workspaces", "tree", id],
                    });
                  })
                }
              >
                New chat
              </Button>
            )}
            {workspace && (
              <Button
                variant="ghost"
                leftIcon={<Settings className="h-4 w-4" />}
                onClick={() => setSettingsOpen(true)}
                title="Workspace settings"
                aria-label="Workspace settings"
              />
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
                canEdit={canEdit && !isArchived}
              />
            )}
          </aside>

          {/* Main pane */}
          <main
            className={
              "flex min-w-0 flex-1 flex-col " +
              (graphOpen ? "overflow-hidden" : "overflow-y-auto")
            }
          >
            {graphOpen ? (
              <WorkspaceGraphPane workspaceId={id} onOpenItem={handleSelect} />
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

      {workspace && (
        <WorkspaceSettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          workspace={workspace}
          isOwner={isOwner}
          canEdit={canEdit}
          onArchive={() => archive.mutate(workspace.id)}
          onUnarchive={() => unarchive.mutate(workspace.id)}
          onDelete={() => {
            setSettingsOpen(false);
            setDeleteOpen(true);
          }}
          archivePending={archive.isPending}
          unarchivePending={unarchive.isPending}
        />
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
  if (node && node.kind === "note") {
    return (
      <WorkspaceNotePane
        node={node}
        workspaceId={workspaceId}
        onClose={onCloseNote}
        onOpenItem={onOpenItem}
      />
    );
  }

  if (node && node.kind === "canvas") {
    return (
      <WorkspaceCanvasPaneFrame
        node={node}
        canEdit={canEdit}
        workspaceId={workspaceId}
        onOpenItem={onOpenItem}
      />
    );
  }

  if (node && node.kind === "chat" && node.ref_id) {
    // Render the full chat experience inline (no page nav) — the chat
    // is keyed by ref_id (conversation id). WorkspaceMainPane is already
    // keyed by the selected node id upstream, so switching chats remounts
    // cleanly and resets the chat store's active conversation.
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatPage embedded embeddedConversationId={node.ref_id} />
      </div>
    );
  }

  // No item selected → the workspace overview home (counts + tasks +
  // recent), preceded by any archive/share banners.
  return (
    <div className="w-full">
      <div className="mx-auto w-full max-w-3xl px-6 pt-6 empty:hidden">
      {isArchived && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <Archive className="h-3.5 w-3.5" />
            This workspace is archived. Unarchive to start new chats under it.
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
        <div className="mb-4 flex items-center gap-2 rounded-card border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 text-xs text-[var(--text)]">
          <Users className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span>
            {canEdit ? (
              <>
                You have collaborator access to this workspace, shared by{" "}
                <span className="font-medium">{sharedByName}</span>. You can see
                and edit every chat in it.
              </>
            ) : (
              <>
                You have view-only access to this workspace, shared by{" "}
                <span className="font-medium">{sharedByName}</span>. You can read
                its chats and files but not change them.
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
}: {
  node: WorkspaceItemNode;
  workspaceId: string;
  onClose: () => void;
  onOpenItem: (node: WorkspaceItemNode) => void;
}) {
  const [file, setFile] = useState<FileItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Workspace tree → flat list of linkable targets (notes / canvases /
  // chats) for both the ``[[`` autocomplete and click-to-open title
  // lookup. Folders aren't linkable; they only nest.
  const { data: tree } = useWorkspaceTree(workspaceId);
  const linkables = useMemo(() => collectLinkables(tree ?? []), [tree]);

  // ``[[`` autocomplete source: substring-filter the flattened tree,
  // skip the current note itself, map to WikiTarget. Stable identity so
  // the editor's ``buildExtensions`` memo doesn't churn on every render.
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

  // Click-to-open: intercept clicks on wiki-link anchors (href carries
  // ``?item=``) and open the target inline instead of navigating. Capture
  // phase so we beat any default anchor handling.
  const handleEditorClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      const parsed = parseWikiHref(anchor.getAttribute("href"));
      if (!parsed) return;
      e.preventDefault();
      e.stopPropagation();
      // Prefer the real title from the tree so the pane header isn't blank
      // for a tick; the target pane refetches its own data regardless.
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
    if (!node.ref_id) {
      setError("This note has no underlying document.");
      return;
    }
    filesApi
      .getFile(node.ref_id)
      .then((f) => {
        if (!cancelled) setFile(f);
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

  // Inline editor fills the pane (rail + nav stay visible). The editor's
  // own X / onClose deselects the note back to the empty state. The
  // click-capture wrapper turns wiki-link anchors into inline navigation,
  // and the backlinks strip sits below the editor.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div className="flex min-h-0 flex-1 flex-col" onClickCapture={handleEditorClick}>
        <DocumentEditorModal
          file={file}
          inline
          onClose={onClose}
          onFileUpdated={(f) => setFile(f)}
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

/** Flatten the workspace tree into the set of wiki-linkable items
 *  (everything but folders). Used for ``[[`` autocomplete + click-to-open
 *  title resolution. */
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
 * editor — tldraw fills this positioned, full-height container.
 *
 * The canvas item's ``ref_id`` is the canvas id the collab room + token
 * endpoints key off. Viewers (no edit access) get a read-only board.
 */
function WorkspaceCanvasPaneFrame({
  node,
  canEdit,
  workspaceId,
  onOpenItem,
}: {
  node: WorkspaceItemNode;
  canEdit: boolean;
  workspaceId: string;
  onOpenItem: (node: WorkspaceItemNode) => void;
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
    // tldraw surface gets a real height inside the scrolling main pane.
    <div className="relative flex min-h-0 flex-1 flex-col">
      <WorkspaceCanvasPane
        canvasId={node.ref_id}
        readOnly={!canEdit}
        workspaceId={workspaceId}
        onOpenItem={onOpenItem}
      />
    </div>
  );
}

// ---------------------------------------------------------------------

async function handleNewChat(
  workspace: {
    id: string;
    default_model_id: string | null;
    default_provider_id: string | null;
  },
  onCreated: (conv: { id: string; title: string | null }) => void
) {
  const { selectedModelId, selectedProviderId } = useModelStore.getState();
  const modelId = workspace.default_model_id ?? selectedModelId ?? undefined;
  const providerId =
    workspace.default_provider_id ?? selectedProviderId ?? undefined;
  try {
    const conv = await chatApi.create({
      title: null,
      model_id: modelId,
      provider_id: providerId,
      web_search_mode: "off",
      workspace_id: workspace.id,
    });
    onCreated({ id: String(conv.id), title: conv.title ?? null });
  } catch {
    // Best-effort; failures already raise toasts via the axios interceptor.
  }
}
