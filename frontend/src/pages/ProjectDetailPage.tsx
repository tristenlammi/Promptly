import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Lightbulb,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Settings2,
  Share2,
  Trash2,
  Upload,
  Users,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { ConfirmDoubleModal } from "@/components/study/ConfirmDoubleModal";
import { AttachmentPickerModal } from "@/components/chat/AttachmentPickerModal";
import { ImportConversationsModal } from "@/components/chat/ImportConversationsModal";
import { ShareProjectDialog } from "@/components/chat/ShareProjectDialog";
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
import { estimateTokens, formatTokens } from "@/utils/tokenEstimate";

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
  const [shareOpen, setShareOpen] = useState(false);

  const archive = useArchiveChatProject();
  const unarchive = useUnarchiveChatProject();
  const remove = useDeleteChatProject();

  if (!id) return null;

  const isArchived = Boolean(project?.archived_at);
  const isOwner = (project?.role ?? "owner") === "owner";
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
                  {isOwner && (
                    <Button
                      variant="ghost"
                      leftIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
                      onClick={() => unarchive.mutate(project.id)}
                    >
                      Unarchive
                    </Button>
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
                    You have collaborator access to this project, shared by{" "}
                    <span className="font-medium">
                      {project.shared_by.username}
                    </span>
                    . You can see and edit every chat in it.
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
                    isOwner={isOwner}
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
  isOwner,
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
        <ProjectInstructionsEditor
          value={systemPrompt}
          onChange={setSystemPrompt}
        />
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
}: {
  value: string;
  onChange: (v: string) => void;
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
        placeholder={PROJECT_INSTRUCTIONS_PLACEHOLDER}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
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
