import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderMinus,
  FolderX,
  Gauge,
  Lightbulb,
  RefreshCw,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  Share2,
  Star,
  Trash2,
  Upload,
  Users,
  Zap,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { AttachmentPickerModal } from "@/components/chat/AttachmentPickerModal";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { ShareProjectDialog } from "@/components/chat/ShareProjectDialog";
import { ProjectModelField } from "@/components/projects/ProjectModelField";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { TopNav } from "@/components/layout/TopNav";
import { chatApi } from "@/api/chat";
import type { ConversationSummary } from "@/api/types";
import { filesApi, isDocumentFile, type FileItem } from "@/api/files";
import {
  useArchiveChatProject,
  useBulkRemoveConversationsFromProject,
  useChatProject,
  useChatProjectConversations,
  useChatProjectUsage,
  useDeleteChatProject,
  usePinChatProjectFile,
  useReindexProject,
  useUnarchiveChatProject,
  useUnpinChatProjectFile,
  useUpdateChatProject,
} from "@/hooks/useChatProjects";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";
import { estimateTokens, formatTokens } from "@/utils/tokenEstimate";

// Small pretty-printer; matches the format used elsewhere (e.g. the
// attachment picker) for visual consistency. Intentionally local —
// we don't have a shared util module for this yet and it's 5 lines.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Tab = "conversations" | "files" | "usage" | "settings";

/** Project detail page — three tabs (Conversations, Files, Settings).
 * Laid out to match Study's unit-list page at a glance: left-aligned
 * TopNav title, tabbed body, card list. */
export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: project, isLoading } = useChatProject(id);
  const { data: conversations } = useChatProjectConversations(id);

  const [tab, setTab] = useState<Tab>("conversations");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const archive = useArchiveChatProject();
  const unarchive = useUnarchiveChatProject();
  const remove = useDeleteChatProject();
  const bulkRemoveConversations = useBulkRemoveConversationsFromProject(id ?? "");

  if (!id) return null;

  const isArchived = Boolean(project?.archived_at);
  const isOwner = (project?.role ?? "owner") === "owner";
  // Fine-grained: viewers get a read-only project page.
  const canEdit = (project?.access_role ?? "owner") !== "viewer";
  const collaboratorCount = project?.collaborators?.length ?? 0;

  return (
    <>
      <TopNav
        title={project?.title ?? "Project"}
        subtitle={
          project?.description
            ? project.description
            : project?.role === "collaborator" && project?.shared_by
              ? `Shared by ${project.shared_by.username}`
              : "Shared instructions, files, and conversations"
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              leftIcon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => navigate("/projects")}
            >
              Back
            </Button>
            {!isArchived && isOwner && (
              <Button
                variant="ghost"
                leftIcon={<Share2 className="h-4 w-4" />}
                onClick={() => setShareOpen(true)}
                title="Share this project with a teammate"
              >
                {collaboratorCount > 0
                  ? `Share (${collaboratorCount})`
                  : "Share"}
              </Button>
            )}
            {!isArchived && canEdit && (
              <>
                <Button
                  variant="ghost"
                  leftIcon={<Upload className="h-4 w-4" />}
                  onClick={() => setImportOpen(true)}
                >
                  Import
                </Button>
                <Button
                  variant="primary"
                  leftIcon={<Plus className="h-4 w-4" />}
                  onClick={() =>
                    project && handleNewChat(project, navigate)
                  }
                >
                  New chat
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          {isLoading || !project ? (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading project...
            </div>
          ) : (
            <>
              {isArchived && (
                <div className="mb-4 flex items-center justify-between gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
                  <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
                    <Archive className="h-3.5 w-3.5" />
                    This project is archived. Unarchive to start new chats
                    under it.
                  </span>
                  {isOwner && (
                    <div className="flex shrink-0 items-center gap-2">
                      {(conversations?.length ?? 0) > 0 && (
                        <Button
                          variant="ghost"
                          leftIcon={<FolderX className="h-3.5 w-3.5" />}
                          onClick={() => bulkRemoveConversations.mutate()}
                          disabled={bulkRemoveConversations.isPending}
                          title="Move all chats back to your top-level list"
                        >
                          {bulkRemoveConversations.isPending
                            ? "Moving…"
                            : "Move all chats out"}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                        onClick={() => unarchive.mutate(project.id)}
                      >
                        Unarchive
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {isOwner && collaboratorCount > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)]">
                  <Users className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Shared with{" "}
                    <span className="font-medium text-[var(--text)]">
                      {(project.collaborators ?? [])
                        .map((c) => c.username)
                        .join(", ")}
                    </span>
                    . They can see and edit every chat in this project.
                  </span>
                </div>
              )}

              {!isOwner && project.shared_by && (
                <div className="mb-4 flex items-center gap-2 rounded-card border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 text-xs text-[var(--text)]">
                  <Users className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  <span>
                    {canEdit ? (
                      <>
                        You have collaborator access to this project, shared by{" "}
                        <span className="font-medium">
                          {project.shared_by.username}
                        </span>
                        . You can see and edit every chat in it.
                      </>
                    ) : (
                      <>
                        You have view-only access to this project, shared by{" "}
                        <span className="font-medium">
                          {project.shared_by.username}
                        </span>
                        . You can read its chats and files but not change them.
                      </>
                    )}
                  </span>
                </div>
              )}

              <Tabs
                tab={tab}
                onChange={setTab}
                conversationCount={conversations?.length ?? 0}
                fileCount={project.files.length}
              />

              <div className="mt-6">
                {tab === "conversations" && (
                  <ConversationsTab
                    projectId={id}
                    conversations={conversations ?? []}
                    onOpen={(cid) => navigate(`/chat/${cid}`)}
                  />
                )}
                {tab === "files" && (
                  <FilesTab project={project} canEdit={canEdit} />
                )}
                {tab === "usage" && <UsageTab projectId={id} />}
                {tab === "settings" && (
                  <SettingsTab
                    project={project}
                    onArchive={() => archive.mutate(project.id)}
                    onUnarchive={() => unarchive.mutate(project.id)}
                    onDelete={() => setDeleteOpen(true)}
                    archivePending={archive.isPending}
                    unarchivePending={unarchive.isPending}
                    isOwner={isOwner}
                    canEdit={canEdit}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <ImportConversationsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        defaultProjectId={id}
      />

      {project && isOwner && (
        <ShareProjectDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          projectId={project.id}
          projectTitle={project.title}
        />
      )}

      <ConfirmDoubleModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (!project) return;
          await remove.mutateAsync(project.id);
          navigate("/projects");
        }}
        destructive
        pending={remove.isPending}
        firstTitle="Delete this project?"
        firstDescription={
          project
            ? `"${project.title}" will be deleted. Conversations inside it are preserved and will move back to your top-level chat list. Pinned files stay in your library.`
            : ""
        }
        firstConfirmLabel="Continue"
        secondTitle="Delete permanently"
        secondDescription={
          project
            ? `Type the project title to confirm permanent deletion of "${project.title}".`
            : ""
        }
        typeToConfirm={project?.title}
        secondConfirmLabel="Delete project"
      />
    </>
  );
}

// ---------------------------------------------------------------------

async function handleNewChat(
  project: { id: string; default_model_id: string | null; default_provider_id: string | null },
  navigate: (path: string) => void
) {
  // Creates an empty conversation under the project and navigates to
  // it. The project's default model wins when set — sending it
  // explicitly keeps the chat header correct on first paint (rather
  // than relying solely on the backend's send-time fallback). When the
  // project has no default we fall back to the user's current global
  // selection, matching the pre-default behaviour. System prompt +
  // pinned files are still applied by the backend on the first send.
  const { selectedModelId, selectedProviderId } = useModelStore.getState();
  const modelId = project.default_model_id ?? selectedModelId ?? undefined;
  const providerId =
    project.default_provider_id ?? selectedProviderId ?? undefined;
  try {
    const conv = await chatApi.create({
      title: null,
      model_id: modelId,
      provider_id: providerId,
      web_search_mode: "off",
      project_id: project.id,
    });
    navigate(`/chat/${conv.id}`);
  } catch {
    // Best-effort; creation failures already raise toasts via the
    // axios interceptor elsewhere.
  }
}

// ---------------------------------------------------------------------

function Tabs({
  tab,
  onChange,
  conversationCount,
  fileCount,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  conversationCount: number;
  fileCount: number;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[var(--border)]">
      <TabButton
        active={tab === "conversations"}
        onClick={() => onChange("conversations")}
        icon={<MessageSquare className="h-3.5 w-3.5" />}
        label="Conversations"
        count={conversationCount}
      />
      <TabButton
        active={tab === "files"}
        onClick={() => onChange("files")}
        icon={<FileText className="h-3.5 w-3.5" />}
        label="Files"
        count={fileCount}
      />
      <TabButton
        active={tab === "usage"}
        onClick={() => onChange("usage")}
        icon={<BarChart3 className="h-3.5 w-3.5" />}
        label="Usage"
      />
      <TabButton
        active={tab === "settings"}
        onClick={() => onChange("settings")}
        icon={<Settings2 className="h-3.5 w-3.5" />}
        label="Settings"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative -mb-px inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition",
        active
          ? "border-b-2 border-[var(--accent)] text-[var(--text)]"
          : "border-b-2 border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {icon}
      {label}
      {typeof count === "number" && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[10px]",
            active
              ? "bg-[var(--accent)]/15 text-[var(--accent)]"
              : "bg-[var(--border)]/40 text-[var(--text-muted)]"
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------
// Tab: Conversations
// ---------------------------------------------------------------------

function ConversationsTab({
  projectId,
  conversations,
  onOpen,
}: {
  projectId: string;
  conversations: ConversationSummary[];
  onOpen: (id: string) => void;
}) {
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");

  // Debounce the FTS/semantic call so we don't hit the endpoint on
  // every keystroke (200ms matches the command-palette feel).
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 200);
    return () => clearTimeout(t);
  }, [rawQuery]);

  const { data: hits, isFetching } = useQuery({
    queryKey: ["chat-project-search", projectId, query],
    queryFn: () => chatApi.search(query, 20, projectId),
    enabled: query.length > 0,
  });

  return (
    <div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          placeholder="Search this project's chats…"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] py-2 pl-9 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      </div>

      {query.length > 0 ? (
        <SearchResults
          hits={hits ?? []}
          loading={isFetching}
          onOpen={onOpen}
        />
      ) : conversations.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
          No conversations yet. Start a new chat — it will inherit this
          project's instructions and pinned files.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conv={c}
              projectId={projectId}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchResults({
  hits,
  loading,
  onOpen,
}: {
  hits: Array<{
    conversation_id: string;
    message_id: string;
    conversation_title: string | null;
    snippet: string;
    created_at: string;
  }>;
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  if (!hits.length) {
    return (
      <div className="rounded-card border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
        {loading ? "Searching…" : "No matches in this project."}
      </div>
    );
  }
  // Snippets carry [[HL]]…[[/HL]] markers from ts_headline; render the
  // highlighted spans inline without trusting raw HTML.
  const renderSnippet = (s: string) =>
    s.split(/\[\[HL\]\]|\[\[\/HL\]\]/).map((part, i) =>
      i % 2 === 1 ? (
        <mark
          key={i}
          className="rounded bg-[var(--accent)]/20 px-0.5 text-[var(--text)]"
        >
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      )
    );
  return (
    <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
      {hits.map((h) => (
        <li key={h.message_id}>
          <button
            onClick={() => onOpen(h.conversation_id)}
            className="block w-full px-4 py-3 text-left transition hover:bg-[var(--accent)]/5"
          >
            <div className="truncate text-sm font-medium text-[var(--text)]">
              {h.conversation_title ?? "Untitled chat"}
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">
              {renderSnippet(h.snippet)}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ConversationRow({
  conv,
  projectId,
  onOpen,
}: {
  conv: ConversationSummary;
  projectId: string;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const available = useModelStore((s) => s.available);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(conv.title ?? "");
  const [busy, setBusy] = useState(false);

  const modelLabel = useMemo(() => {
    if (!conv.model_id) return null;
    return (
      available.find((m) => m.model_id === conv.model_id)?.display_name ??
      conv.model_id
    );
  }, [available, conv.model_id]);

  const refresh = () =>
    qc.invalidateQueries({
      queryKey: ["chat-projects", "conversations", projectId],
    });

  const mutate = async (patch: {
    title?: string;
    starred?: boolean;
    project_id?: string | null;
  }) => {
    setBusy(true);
    try {
      await chatApi.update(conv.id, patch);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = async () => {
    const t = title.trim();
    setRenaming(false);
    if (t && t !== conv.title) await mutate({ title: t });
    else setTitle(conv.title ?? "");
  };

  return (
    <li className="group flex items-center gap-2 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveTitle();
              if (e.key === "Escape") {
                setRenaming(false);
                setTitle(conv.title ?? "");
              }
            }}
            className="w-full rounded border border-[var(--accent)] bg-[var(--surface)] px-2 py-1 text-sm outline-none"
          />
        ) : (
          <button
            onClick={() => onOpen(conv.id)}
            className="block w-full text-left"
          >
            <span className="truncate font-medium text-[var(--text)] hover:text-[var(--accent)]">
              {conv.title ?? "Untitled chat"}
            </span>
            <span className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
              {modelLabel && (
                <span className="truncate rounded bg-[var(--border)]/40 px-1.5 py-0.5">
                  {modelLabel}
                </span>
              )}
              {new Date(conv.updated_at).toLocaleDateString()}
            </span>
          </button>
        )}
      </div>

      {!renaming && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <RowAction
            label={conv.starred ? "Unstar" : "Star"}
            onClick={() => mutate({ starred: !conv.starred })}
            disabled={busy}
          >
            <Star
              className={cn(
                "h-3.5 w-3.5",
                conv.starred && "fill-[var(--accent)] text-[var(--accent)]"
              )}
            />
          </RowAction>
          <RowAction
            label="Rename"
            onClick={() => {
              setTitle(conv.title ?? "");
              setRenaming(true);
            }}
            disabled={busy}
          >
            <Pencil className="h-3.5 w-3.5" />
          </RowAction>
          <RowAction
            label="Remove from project"
            onClick={() => mutate({ project_id: null })}
            disabled={busy}
          >
            <FolderMinus className="h-3.5 w-3.5" />
          </RowAction>
        </div>
      )}
    </li>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1.5 text-[var(--text-muted)] transition hover:bg-[var(--accent)]/10 hover:text-[var(--text)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------
// Tab: Usage
// ---------------------------------------------------------------------

function UsageTab({ projectId }: { projectId: string }) {
  const { data: usage, isLoading } = useChatProjectUsage(projectId);

  if (isLoading || !usage) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading usage…
      </div>
    );
  }

  const fmtCost = (c: number) =>
    c >= 0.01 ? `$${c.toFixed(2)}` : c > 0 ? `$${c.toFixed(4)}` : "$0.00";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Conversations" value={usage.conversation_count.toLocaleString()} />
        <StatCard label="Messages" value={usage.message_count.toLocaleString()} />
        <StatCard label="Total tokens" value={formatTokens(usage.total_tokens)} />
        <StatCard label="Est. cost" value={fmtCost(usage.cost_usd)} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">By model</h3>
        {usage.by_model.length === 0 ? (
          <div className="rounded-card border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
            No usage recorded yet. Token + cost stats appear once chats in
            this project have replies.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
            {usage.by_model.map((m) => (
              <li
                key={m.model_id ?? "unknown"}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="truncate font-medium text-[var(--text)]">
                  {m.model_id ?? "Unknown model"}
                </span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-[var(--text-muted)]">
                  <span>{formatTokens(m.prompt_tokens + m.completion_tokens)} tok</span>
                  <span>{fmtCost(m.cost_usd)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold text-[var(--text)]">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Tab: Files
// ---------------------------------------------------------------------

function FilesTab({
  project,
  canEdit,
}: {
  project: ReturnType<typeof useChatProject>["data"] extends
    | infer D
    | undefined
    ? Exclude<D, undefined>
    : never;
  canEdit: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pin = usePinChatProjectFile(project.id);
  const unpin = useUnpinChatProjectFile(project.id);
  const reindex = useReindexProject(project.id);

  // Preview state. ``previewFile`` is the full ``FileItem`` returned
  // by ``filesApi.getFile`` — we lazy-fetch it on click so we have
  // the rich metadata (``source_kind`` etc.) that
  // ``FilePreviewModal`` needs to route between document /
  // PDF / code-artifact / image / text previewers correctly. The
  // pinned-file row only carries the minimal pin-side fields, so a
  // synthesised stub would mis-route Drive Documents / rendered
  // PDFs.
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  // Drive Documents jump straight into the editor on click — every
  // other pinned file type still falls back to the generic preview
  // modal. We have to lazy-fetch the row first because the pinned
  // ``ChatProjectFilePin`` shape doesn't carry ``source_kind``.
  const [editingDoc, setEditingDoc] = useState<FileItem | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const openPreview = async (fileId: string) => {
    if (previewLoadingId) return;
    setPreviewLoadingId(fileId);
    setPreviewError(null);
    try {
      const file = await filesApi.getFile(fileId);
      if (isDocumentFile(file) && !file.trashed_at) {
        setEditingDoc(file);
      } else {
        setPreviewFile(file);
      }
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't load this file. It may have been removed.";
      setPreviewError(detail);
    } finally {
      setPreviewLoadingId(null);
    }
  };

  // Sibling list for Prev/Next inside the preview modal — same
  // affordance Drive's preview gives. We can't pass our minimal
  // ``ChatProjectFilePin`` shape, so we only enable navigation
  // between files we've already fetched and cache; for simplicity
  // we just hand the modal a single-element list (the open file).
  // If the user wants to flip between project files they can close
  // and reopen — keeps this MVP focused.
  const siblings = previewFile ? [previewFile] : [];

  // Project's existing files, reshaped into the ``AttachedFile`` shape
  // the picker uses so it can show "already pinned" state correctly.
  const alreadyAttached = useMemo(
    () =>
      project.files.map((f) => ({
        id: f.file_id,
        filename: f.filename,
        mime_type: f.mime_type,
        size_bytes: f.size_bytes,
      })),
    [project.files]
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Pinned files are auto-attached to every new chat in this project.
        </p>
        {canEdit && (
          <div className="flex items-center gap-2">
            {/* Reindex: owner-only, shown when files need indexing */}
            {project.role === "owner" &&
              project.files.some(
                (f) =>
                  f.indexing_status === "queued" ||
                  f.indexing_status === "failed"
              ) && (
                <Button
                  variant="ghost"
                  leftIcon={
                    <RefreshCw
                      className={cn(
                        "h-3.5 w-3.5",
                        reindex.isPending && "animate-spin"
                      )}
                    />
                  }
                  onClick={() => reindex.mutate()}
                  disabled={reindex.isPending || project.indexing_count > 0}
                  title="Re-index all queued or failed files for semantic search"
                >
                  {reindex.isPending ? "Indexing…" : "Reindex"}
                </Button>
              )}
            <Button
              variant="secondary"
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setPickerOpen(true)}
            >
              Add file
            </Button>
          </div>
        )}
      </div>

      <ContextBudgetBar project={project} />

      {previewError && (
        <div
          role="alert"
          className="mb-3 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
        >
          {previewError}
        </div>
      )}

      {project.files.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
          No files pinned yet. Pin a PDF, image, or text file and every
          chat in this project will have it in context.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {project.files.map((f) => {
            const loading = previewLoadingId === f.file_id;
            return (
              <li
                key={f.file_id}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <button
                  type="button"
                  onClick={() => openPreview(f.file_id)}
                  disabled={loading}
                  title={`Preview ${f.filename}`}
                  aria-label={`Preview ${f.filename}`}
                  className={cn(
                    "group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left",
                    "transition hover:text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                    "disabled:cursor-wait"
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition group-hover:text-[var(--accent)]" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-[var(--text)] group-hover:text-[var(--accent)]">
                        {f.filename}
                      </span>
                      <IndexStatusChip
                        status={f.indexing_status}
                        error={f.indexing_error}
                      />
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {humanSize(f.size_bytes)} · {f.mime_type}
                    </div>
                  </div>
                </button>
                {canEdit && (
                  <button
                    onClick={() => unpin.mutate(f.file_id)}
                    title="Unpin"
                    className="rounded p-1 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500"
                    disabled={unpin.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AttachmentPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        alreadyAttached={alreadyAttached}
        onAttach={async (files) => {
          // Pin anything the user selected that isn't already pinned.
          // Sequential (not ``Promise.all``) so a single bad file
          // doesn't nuke the others mid-flight; most users pin one
          // or two files at a time.
          const already = new Set(alreadyAttached.map((f) => f.id));
          for (const f of files) {
            if (already.has(f.id)) continue;
            try {
              await pin.mutateAsync(f.id);
            } catch {
              // Ignore per-file failure; the hook surface doesn't
              // currently emit toasts and we'd rather let the user
              // retry than abort the whole batch.
            }
          }
        }}
      />

      <FilePreviewModal
        open={!!previewFile}
        file={previewFile}
        siblings={siblings}
        onClose={() => setPreviewFile(null)}
      />

      {editingDoc && (
        <DocumentEditorModal
          file={editingDoc}
          onClose={() => setEditingDoc(null)}
          onFileUpdated={(f) => setEditingDoc(f)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Files tab — context budget + per-file indexing status
// ---------------------------------------------------------------------

/** Per-turn context cost readout. Makes the otherwise-invisible "every
 *  chat pays for the pinned files on every message" tax legible, and
 *  explains when retrieval has kicked in to cap it.
 *
 *  Also shows a first-run nudge when the workspace hasn't configured an
 *  embedding provider yet — so the user understands why files stay in
 *  full-dump mode even after pinning lots of content. */
function ContextBudgetBar({
  project,
}: {
  project: NonNullable<ReturnType<typeof useChatProject>["data"]>;
}) {
  const {
    per_turn_tokens,
    retrieval_active,
    indexing_count,
    embeddings_configured,
    files,
  } = project;
  // Mirror the instructions editor's green/amber/red tiers.
  let tone = "text-emerald-500";
  if (per_turn_tokens >= 8000) tone = "text-red-500";
  else if (per_turn_tokens >= 3000) tone = "text-amber-500";

  // Show the onboarding nudge when files are pinned but embeddings
  // aren't configured — distinguishes "small project (full-dump is fine)"
  // from "admin hasn't set up semantic search yet".
  const showEmbeddingsNudge = !embeddings_configured && files.length > 0;

  return (
    <div className="mb-4 space-y-2">
      {showEmbeddingsNudge && (
        <div className="flex items-start gap-2 rounded-card border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            <span className="font-semibold">Semantic search not configured</span>
            {" — "}pinned files are injected in full on every turn. To enable
            retrieval-based context (so large projects don't blow the context
            window), ask your admin to set up an embedding provider in{" "}
            <span className="font-medium">Settings → Models → Defaults</span>.
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5" />
          Per-turn context:{" "}
          <span className={cn("font-medium", tone)}>
            ~{formatTokens(per_turn_tokens)} tokens
          </span>
        </span>
        {retrieval_active ? (
          <span className="inline-flex items-center gap-1 text-[var(--accent)]">
            <Zap className="h-3.5 w-3.5" />
            Retrieval on — only the most relevant chunks are sent each turn
          </span>
        ) : (
          <span>Pinned files are sent in full on every turn</span>
        )}
        {indexing_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Indexing {indexing_count} file{indexing_count > 1 ? "s" : ""}…
          </span>
        )}
      </div>
    </div>
  );
}

/** Small lifecycle chip on a pinned-file row. Hidden for the common
 *  "queued" state on non-RAG files so an image doesn't look stuck. */
function IndexStatusChip({
  status,
  error,
}: {
  status: "queued" | "embedding" | "ready" | "failed";
  error: string | null;
}) {
  if (status === "queued") return null;
  if (status === "embedding") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--border)]/40 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        indexing
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
        <Zap className="h-2.5 w-2.5" />
        searchable
      </span>
    );
  }
  // failed
  return (
    <span
      title={error ?? undefined}
      className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500"
    >
      <CircleAlert className="h-2.5 w-2.5" />
      not indexed
    </span>
  );
}

// ---------------------------------------------------------------------
// Tab: Settings
// ---------------------------------------------------------------------

function SettingsTab({
  project,
  onArchive,
  onUnarchive,
  onDelete,
  archivePending,
  unarchivePending,
  isOwner,
  canEdit,
}: {
  project: ReturnType<typeof useChatProject>["data"] extends
    | infer D
    | undefined
    ? Exclude<D, undefined>
    : never;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  archivePending: boolean;
  unarchivePending: boolean;
  isOwner: boolean;
  canEdit: boolean;
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    project.system_prompt ?? ""
  );
  const [modelId, setModelId] = useState(project.default_model_id);
  const [providerId, setProviderId] = useState(project.default_provider_id);
  const update = useUpdateChatProject(project.id);

  const dirty =
    title.trim() !== project.title ||
    (description || "") !== (project.description || "") ||
    (systemPrompt || "") !== (project.system_prompt || "") ||
    (modelId || null) !== (project.default_model_id || null) ||
    (providerId || null) !== (project.default_provider_id || null);

  const handleSave = async () => {
    if (!dirty || !title.trim()) return;
    await update.mutateAsync({
      title: title.trim(),
      description: description.trim() || null,
      system_prompt: systemPrompt.trim() || null,
      default_model_id: modelId,
      default_provider_id: providerId,
    });
  };

  const toggleAutoMemory = async () => {
    await update.mutateAsync({
      auto_memory_enabled: !project.auto_memory_enabled,
    });
  };

  const isArchived = Boolean(project.archived_at);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={!canEdit}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
            maxLength={255}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            disabled={!canEdit}
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
            maxLength={2000}
          />
        </div>
        <ProjectInstructionsEditor
          value={systemPrompt}
          onChange={setSystemPrompt}
          disabled={!canEdit}
        />
        {canEdit && (
          <ProjectModelField
            modelId={modelId}
            providerId={providerId}
            onChange={(m, p) => {
              setModelId(m);
              setProviderId(p);
            }}
          />
        )}
        {canEdit && (
          <div className="flex items-center justify-end">
            <Button
              variant="primary"
              leftIcon={<Save className="h-3.5 w-3.5" />}
              onClick={handleSave}
              disabled={!dirty || !title.trim() || update.isPending}
            >
              {update.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        )}
      </section>

      {canEdit && (
        <section className="space-y-3 border-t border-[var(--border)] pt-6">
          <h3 className="text-sm font-semibold">Project memory</h3>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={project.auto_memory_enabled}
              onChange={toggleAutoMemory}
              disabled={update.isPending}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              <span className="font-medium text-[var(--text)]">
                Keep a rolling project memory
              </span>
              <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                When on, a pinned <strong>Project Memory.md</strong> file is
                auto-maintained from the project's most recently active chat,
                so other chats pick up the gist. Off by default — distinct
                from the manual “Save summary to project”.
              </span>
            </span>
          </label>
        </section>
      )}

      {isOwner && (
        <section className="space-y-3 border-t border-[var(--border)] pt-6">
          <h3 className="text-sm font-semibold">Lifecycle</h3>
          <div className="flex items-center gap-2">
            {isArchived ? (
              <Button
                variant="secondary"
                leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                onClick={onUnarchive}
                disabled={unarchivePending}
              >
                {unarchivePending ? "Unarchiving..." : "Unarchive"}
              </Button>
            ) : (
              <Button
                variant="secondary"
                leftIcon={<Archive className="h-3.5 w-3.5" />}
                onClick={onArchive}
                disabled={archivePending}
              >
                {archivePending ? "Archiving..." : "Archive"}
              </Button>
            )}
            <Button
              variant="ghost"
              leftIcon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={onDelete}
            >
              Delete project...
            </Button>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Deleting a project preserves every conversation inside it — they
            move back to your top-level chat list.
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Project instructions editor
//
// Richer wrapper around the bare ``<textarea>`` we used to have for the
// project's ``system_prompt`` field. Visually it's still a textarea — no
// structured bullet CRUD — but the surrounding chrome nudges the user
// toward treating it as a *project memory* surface rather than a
// generic instruction blob:
//
//   * Friendlier placeholder with example bullets so new users have a
//     concrete starting point.
//   * Live token counter (not just a raw character count) with a
//     green / amber / red tint so the user can see when they're
//     eating into the context budget shown by the chat-window pill.
//   * A collapsible "Tips for writing good project instructions"
//     block so the guidance is one click away but not loud by default.
//
// Character cap stays the same; this is pure UI polish on top of the
// existing ``chat_projects.system_prompt`` column — no schema change.
// ---------------------------------------------------------------------

const PROJECT_INSTRUCTIONS_PLACEHOLDER = `Durable facts about this project — they go into every chat in it.

Examples:
- I'm writing this in Python 3.11 on Ubuntu; my database is Postgres 15.
- Target audience: high-school physics teachers in Australia.
- Always answer concisely. Skip pleasantries and preamble.
- My team is 3 people — Sarah (PM), Raj (designer), me (engineer).
- When I paste code, default to assuming it's production-ready, not a draft.`;

const PROJECT_INSTRUCTIONS_TIPS: string[] = [
  "Write facts and conventions, not tasks. Good: \"I use metric units.\" Bad: \"Help me write my report.\"",
  "Bullet points beat paragraphs — each line is something the AI should treat as always-true.",
  "Include preferences the AI keeps getting wrong (tone, verbosity, formatting). They're why this field exists.",
  "Aim for under ~500 tokens. Larger prompts work, but every chat pays that cost on every turn.",
];

function ProjectInstructionsEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [showTips, setShowTips] = useState(false);
  const tokens = useMemo(() => estimateTokens(value), [value]);

  // Soft thresholds. Under 500 tokens is "plenty of room"; 500-1500 is
  // "fine but starting to eat into the budget"; 1500+ is "this will
  // measurably reduce every chat's context window". We never hard-block
  // — the 20k-char maxLength already does that at the boundary.
  let toneClass = "text-emerald-500";
  let toneLabel = "compact";
  if (tokens >= 1500) {
    toneClass = "text-red-500";
    toneLabel = "long — consider trimming";
  } else if (tokens >= 500) {
    toneClass = "text-amber-500";
    toneLabel = "getting long";
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        Project instructions{" "}
        <span className="text-[var(--text-muted)]/70">
          (shared across every chat in this project)
        </span>
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        disabled={disabled}
        placeholder={PROJECT_INSTRUCTIONS_PLACEHOLDER}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
        maxLength={20000}
      />
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <button
          type="button"
          onClick={() => setShowTips((s) => !s)}
          className="inline-flex items-center gap-1 text-[var(--text-muted)] transition hover:text-[var(--text)]"
        >
          {showTips ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Lightbulb className="h-3 w-3" />
          Tips for good project instructions
        </button>
        <span className="text-[var(--text-muted)]">
          <span className={cn("font-medium", toneClass)}>
            ~{formatTokens(tokens)} tokens
          </span>{" "}
          · {toneLabel} · {value.length.toLocaleString()} / 20,000 chars
        </span>
      </div>

      {showTips && (
        <div className="mt-2 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text-muted)]">
          <ul className="list-disc space-y-1 pl-4">
            {PROJECT_INSTRUCTIONS_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
