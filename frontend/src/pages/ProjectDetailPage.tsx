import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { AttachmentPickerModal } from "@/components/chat/AttachmentPickerModal";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { TopNav } from "@/components/layout/TopNav";
import { chatApi } from "@/api/chat";
import {
  useArchiveChatProject,
  useChatProject,
  useChatProjectConversations,
  useDeleteChatProject,
  usePinChatProjectFile,
  useUnarchiveChatProject,
  useUnpinChatProjectFile,
  useUpdateChatProject,
} from "@/hooks/useChatProjects";
import { useModelStore } from "@/store/modelStore";
import { cn } from "@/utils/cn";

// Small pretty-printer; matches the format used elsewhere (e.g. the
// attachment picker) for visual consistency. Intentionally local —
// we don't have a shared util module for this yet and it's 5 lines.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Tab = "conversations" | "files" | "settings";

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

  const archive = useArchiveChatProject();
  const unarchive = useUnarchiveChatProject();
  const remove = useDeleteChatProject();

  if (!id) return null;

  const isArchived = Boolean(project?.archived_at);

  return (
    <>
      <TopNav
        title={project?.title ?? "Project"}
        subtitle={
          project?.description
            ? project.description
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
            {!isArchived && (
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
                  onClick={() => handleNewChat(id, navigate)}
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
                <div className="mb-4 flex items-center justify-between rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
                  <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
                    <Archive className="h-3.5 w-3.5" />
                    This project is archived. Unarchive to start new chats
                    under it.
                  </span>
                  <Button
                    variant="ghost"
                    leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                    onClick={() => unarchive.mutate(project.id)}
                  >
                    Unarchive
                  </Button>
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
                    conversations={conversations ?? []}
                    onOpen={(cid) => navigate(`/chat/${cid}`)}
                  />
                )}
                {tab === "files" && <FilesTab project={project} />}
                {tab === "settings" && (
                  <SettingsTab
                    project={project}
                    onArchive={() => archive.mutate(project.id)}
                    onUnarchive={() => unarchive.mutate(project.id)}
                    onDelete={() => setDeleteOpen(true)}
                    archivePending={archive.isPending}
                    unarchivePending={unarchive.isPending}
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
  projectId: string,
  navigate: (path: string) => void
) {
  // Creates an empty conversation under the project and navigates to
  // it. The backend inherits the project's default model + system
  // prompt + pinned files on the first send automatically.
  const { selectedModelId, selectedProviderId } =
    useModelStore.getState();
  try {
    const conv = await chatApi.create({
      title: null,
      model_id: selectedModelId ?? undefined,
      provider_id: selectedProviderId ?? undefined,
      web_search_mode: "off",
      project_id: projectId,
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
  conversations,
  onOpen,
}: {
  conversations: Array<{
    id: string;
    title: string | null;
    updated_at: string;
  }>;
  onOpen: (id: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
        No conversations yet. Start a new chat — it will inherit this
        project's instructions and pinned files.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
      {conversations.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => onOpen(c.id)}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition hover:bg-[var(--accent)]/5"
          >
            <span className="truncate font-medium text-[var(--text)]">
              {c.title ?? "Untitled chat"}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {new Date(c.updated_at).toLocaleDateString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------
// Tab: Files
// ---------------------------------------------------------------------

function FilesTab({
  project,
}: {
  project: ReturnType<typeof useChatProject>["data"] extends
    | infer D
    | undefined
    ? Exclude<D, undefined>
    : never;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pin = usePinChatProjectFile(project.id);
  const unpin = useUnpinChatProjectFile(project.id);

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
        <Button
          variant="secondary"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setPickerOpen(true)}
        >
          Add file
        </Button>
      </div>

      {project.files.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
          No files pinned yet. Pin a PDF, image, or text file and every
          chat in this project will have it in context.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {project.files.map((f) => (
            <li
              key={f.file_id}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-[var(--text)]">
                    {f.filename}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {humanSize(f.size_bytes)} · {f.mime_type}
                  </div>
                </div>
              </div>
              <button
                onClick={() => unpin.mutate(f.file_id)}
                title="Unpin"
                className="rounded p-1 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500"
                disabled={unpin.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
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
    </div>
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
}) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    project.system_prompt ?? ""
  );
  const update = useUpdateChatProject(project.id);

  const dirty =
    title.trim() !== project.title ||
    (description || "") !== (project.description || "") ||
    (systemPrompt || "") !== (project.system_prompt || "");

  const handleSave = async () => {
    if (!dirty || !title.trim()) return;
    await update.mutateAsync({
      title: title.trim(),
      description: description.trim() || null,
      system_prompt: systemPrompt.trim() || null,
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
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
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
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={2000}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            System prompt{" "}
            <span className="text-[var(--text-muted)]/70">
              (shared across every chat in this project)
            </span>
          </label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder="e.g. You are a research assistant for my thesis on..."
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            maxLength={20000}
          />
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            {systemPrompt.length} / 20,000
          </div>
        </div>
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
      </section>

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
    </div>
  );
}
