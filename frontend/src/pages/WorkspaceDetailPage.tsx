import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  FolderX,
  Loader2,
  Plus,
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
import { WorkspaceNavigatorTree } from "@/components/workspaces/WorkspaceNavigatorTree";
import { WorkspaceSettingsDrawer } from "@/components/workspaces/WorkspaceSettingsDrawer";
import { chatApi } from "@/api/chat";
import { filesApi, type FileItem } from "@/api/files";
import type { WorkspaceItemNode } from "@/api/workspaces";
import {
  useArchiveWorkspace,
  useBulkRemoveConversationsFromWorkspace,
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
  const { data: workspace, isLoading } = useWorkspace(id);
  const { data: conversations } = useWorkspaceConversations(id);
  const { data: tree, isLoading: treeLoading } = useWorkspaceTree(id);

  const [selected, setSelected] = useState<WorkspaceItemNode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

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

  const handleSelect = (node: WorkspaceItemNode) => {
    if (node.kind === "chat") {
      // Chats live in the main chat UI — low-risk navigate.
      if (node.ref_id) navigate(`/chat/${node.ref_id}`);
      return;
    }
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
                onClick={() => workspace && handleNewChat(workspace, navigate)}
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
          <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            <WorkspaceMainPane
              key={selected?.id ?? "empty"}
              node={selected}
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
    </>
  );
}

// ---------------------------------------------------------------------
// Main pane
// ---------------------------------------------------------------------

function WorkspaceMainPane({
  node,
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
    return <WorkspaceNotePane node={node} onClose={onCloseNote} />;
  }

  // No item selected → an overview / empty state with the banners that
  // used to live at the top of the old tabbed page.
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
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

      <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-[var(--border)] px-6 py-20 text-center">
        <FileText className="mb-3 h-8 w-8 text-[var(--text-muted)]" />
        <p className="text-sm font-medium text-[var(--text)]">
          Select an item to open it
        </p>
        <p className="mt-1 max-w-sm text-xs text-[var(--text-muted)]">
          Pick a note or chat from the left, or use{" "}
          <span className="font-medium text-[var(--text)]">+ New</span> to create
          a note. Chats open in the main chat view.
        </p>
      </div>
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
  onClose,
}: {
  node: WorkspaceItemNode;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FileItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFile(null);
    setOpen(true);
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

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      {error ? (
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening "{node.title || "note"}"…
        </div>
      )}

      {file && open && (
        <DocumentEditorModal
          file={file}
          onClose={() => {
            setOpen(false);
            // Deselect so the pane returns to its empty state instead of
            // getting stuck behind a closed editor.
            onClose();
          }}
          onFileUpdated={(f) => setFile(f)}
        />
      )}
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
  navigate: (path: string) => void
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
    navigate(`/chat/${conv.id}`);
  } catch {
    // Best-effort; failures already raise toasts via the axios interceptor.
  }
}
