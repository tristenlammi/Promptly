import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  Gauge,
  Lightbulb,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { WorkspaceModelField } from "@/components/workspaces/WorkspaceModelField";
import { WorkspaceMembersPanel } from "@/components/workspaces/WorkspaceMembersPanel";
import { WorkspaceConnectorsTab } from "@/components/workspaces/WorkspaceConnectorsTab";
import type { WorkspaceDetail, WorkspaceMemoryMode } from "@/api/workspaces";
import { workspacesApi } from "@/api/workspaces";
import { chatApi } from "@/api/chat";
import { apiErrorMessage } from "@/utils/apiError";
import {
  useUpdateWorkspace,
  useWorkspaceDrive,
  useWorkspaceMemory,
  useSaveWorkspaceMemory,
  useRegenerateWorkspaceMemory,
  useWorkspaceUsage,
} from "@/hooks/useWorkspaces";
import { confirm } from "@/components/shared/ConfirmDialog";
import { cn } from "@/utils/cn";
import { estimateTokens, formatTokens } from "@/utils/tokenEstimate";

// Local pretty-printer, mirrors the format used elsewhere.
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Tab = "settings" | "members" | "usage" | "connectors";

/**
 * Workspace settings drawer (Phase 1c).
 *
 * Relocates the old WorkspaceDetailPage tabs (instructions, default
 * model, members, pinned files, usage, archive/delete) into a right-hand
 * slide-over opened from the navigator's gear button. The tree + main
 * pane now own the page; this drawer owns "configuration".
 */
export function WorkspaceSettingsDrawer({
  open,
  onClose,
  workspace,
  isOwner,
  canManage,
  onArchive,
  onUnarchive,
  onDelete,
  archivePending,
  unarchivePending,
}: {
  open: boolean;
  onClose: () => void;
  workspace: WorkspaceDetail;
  isOwner: boolean;
  canManage: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  archivePending: boolean;
  unarchivePending: boolean;
}) {
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Workspace settings"
    >
      <button
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div
        className={cn(
          "relative flex h-full w-full max-w-xl flex-col border-l shadow-2xl",
          "border-[var(--border)] bg-[var(--bg)]"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <h2 className="truncate text-sm font-semibold">
            {workspace.title} · Settings
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <WorkspaceSettingsContent
          workspace={workspace}
          isOwner={isOwner}
          canManage={canManage}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          onDelete={onDelete}
          archivePending={archivePending}
          unarchivePending={unarchivePending}
        />
      </div>
    </div>,
    document.body
  );
}

/** The settings tabs + panels, decoupled from the drawer chrome so they can
 *  render inline as a dedicated page in the workspace's main pane. */
export function WorkspaceSettingsContent({
  workspace,
  isOwner,
  canManage,
  onArchive,
  onUnarchive,
  onDelete,
  archivePending,
  unarchivePending,
}: {
  workspace: WorkspaceDetail;
  isOwner: boolean;
  canManage: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  archivePending: boolean;
  unarchivePending: boolean;
}) {
  const [tab, setTab] = useState<Tab>("settings");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-1 px-3">
          <DrawerTab
            active={tab === "settings"}
            onClick={() => setTab("settings")}
            icon={<Settings2 className="h-3.5 w-3.5" />}
            label="General"
          />
          {/* "Pinned files" tab retired — the Workspace Drive (navigator
              rail) is the single file surface now. */}
          <DrawerTab
            active={tab === "members"}
            onClick={() => setTab("members")}
            icon={<Users className="h-3.5 w-3.5" />}
            label="Members"
            count={(workspace.collaborators?.length ?? 0) + 1}
          />
          <DrawerTab
            active={tab === "connectors"}
            onClick={() => setTab("connectors")}
            icon={<Plug className="h-3.5 w-3.5" />}
            label="Connectors"
          />
          <DrawerTab
            active={tab === "usage"}
            onClick={() => setTab("usage")}
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Usage"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-2xl">
          {tab === "settings" && (
            <SettingsTab
              workspace={workspace}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              onDelete={onDelete}
              archivePending={archivePending}
              unarchivePending={unarchivePending}
              isOwner={isOwner}
              canManage={canManage}
            />
          )}
          {tab === "members" && (
            <WorkspaceMembersPanel
              workspaceId={workspace.id}
              canManage={canManage}
              owner={workspace.owner}
              collaborators={workspace.collaborators ?? []}
            />
          )}
          {tab === "connectors" && (
            <WorkspaceConnectorsTab
              workspaceId={workspace.id}
              isOwner={isOwner}
            />
          )}
          {tab === "usage" && (
            <UsageTab workspaceId={workspace.id} isOwner={isOwner} />
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerTab({
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
// Usage
// ---------------------------------------------------------------------

function UsageTab({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const { data: usage, isLoading } = useWorkspaceUsage(workspaceId);

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
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="Conversations"
          value={usage.conversation_count.toLocaleString()}
        />
        <StatCard
          label="Messages"
          value={usage.message_count.toLocaleString()}
        />
        <StatCard label="Total tokens" value={formatTokens(usage.total_tokens)} />
        <StatCard label="Est. cost" value={fmtCost(usage.cost_usd)} />
      </div>

      <DriveStorageSection workspaceId={workspaceId} isOwner={isOwner} />

      <div>
        <h3 className="mb-2 text-sm font-semibold">By model</h3>
        {usage.by_model.length === 0 ? (
          <div className="rounded-card border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
            No usage recorded yet. Token + cost stats appear once chats in
            this workspace have replies.
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
                  <span>
                    {formatTokens(m.prompt_tokens + m.completion_tokens)} tok
                  </span>
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

/** Drive storage: usage bar + (owner-only) cap presets. */
function DriveStorageSection({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const { data: drive } = useWorkspaceDrive(workspaceId);
  const update = useUpdateWorkspace(workspaceId);
  if (!drive) return null;
  const used = drive.used_bytes;
  const cap = drive.quota_bytes;
  const pct = cap ? Math.min(100, (used / cap) * 100) : null;

  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  const presets: { label: string; value: number | null }[] = [
    { label: "No cap", value: null },
    { label: "100 MB", value: 100 * MB },
    { label: "500 MB", value: 500 * MB },
    { label: "1 GB", value: 1 * GB },
    { label: "5 GB", value: 5 * GB },
    { label: "10 GB", value: 10 * GB },
  ];

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Drive storage</h3>
      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[var(--text)]">
            {humanSize(used)}
            <span className="text-[var(--text-muted)]">
              {cap != null ? ` of ${humanSize(cap)}` : " · no cap set"}
            </span>
          </span>
          {isOwner && (
            <select
              value={cap ?? ""}
              onChange={(e) =>
                update.mutate({
                  storage_quota_bytes:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
              aria-label="Drive storage cap"
            >
              {presets.map((p) => (
                <option key={p.label} value={p.value ?? ""}>
                  {p.label}
                </option>
              ))}
              {cap != null && !presets.some((p) => p.value === cap) && (
                <option value={cap}>{humanSize(cap)}</option>
              )}
            </select>
          )}
        </div>
        {pct !== null && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--hover-strong)]">
            <div
              className={
                "h-full rounded-full " +
                (pct >= 95
                  ? "bg-[var(--danger)]"
                  : pct >= 80
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--success)]")
              }
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          The cap bounds this workspace's drive. Files always count against
          the owner's personal storage as well.
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="text-xs text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold text-[var(--text)]">
        {value}
      </div>
    </div>
  );
}


/** Per-turn context cost + retrieval state + embeddings nudge. Lives at
 *  the top of the Workspace Drive pane (exported) — it used to sit on the
 *  retired Pinned-files tab. */
export function ContextBudgetBar({ workspace }: { workspace: WorkspaceDetail }) {
  const {
    per_turn_tokens,
    retrieval_active,
    indexing_count,
    embeddings_configured,
    files,
  } = workspace;
  let tone = "text-[var(--success)]";
  if (per_turn_tokens >= 8000) tone = "text-[var(--danger)]";
  else if (per_turn_tokens >= 3000) tone = "text-[var(--warning)]";

  const showEmbeddingsNudge = !embeddings_configured && files.length > 0;

  return (
    <div className="mb-4 space-y-2">
      {showEmbeddingsNudge && (
        <div className="flex items-start gap-2 rounded-card border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--text)]">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
          <span>
            <span className="font-semibold">Semantic search not configured</span>
            {" — "}pinned files are injected in full on every turn. To enable
            retrieval-based context, ask your admin to set up an embedding
            provider in{" "}
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

// ---------------------------------------------------------------------
// General settings
// ---------------------------------------------------------------------

function SettingsTab({
  workspace,
  onArchive,
  onUnarchive,
  onDelete,
  archivePending,
  unarchivePending,
  isOwner,
  canManage,
}: {
  workspace: WorkspaceDetail;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
  archivePending: boolean;
  unarchivePending: boolean;
  isOwner: boolean;
  canManage: boolean;
}) {
  const [title, setTitle] = useState(workspace.title);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    workspace.system_prompt ?? ""
  );
  const [modelId, setModelId] = useState(workspace.default_model_id);
  const [providerId, setProviderId] = useState(workspace.default_provider_id);
  const [memModelId, setMemModelId] = useState(
    workspace.memory_model_id ?? null
  );
  const [memProviderId, setMemProviderId] = useState(
    workspace.memory_provider_id ?? null
  );
  const [exporting, setExporting] = useState(false);
  const update = useUpdateWorkspace(workspace.id);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await workspacesApi.exportZip(workspace.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `promptly-workspace-${workspace.title
        .replace(/[^\w\- ]+/g, "_")
        .slice(0, 60)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      await confirm({
        title: "Export failed",
        message: "The bundle couldn't be built — try again in a moment.",
        confirmLabel: "OK",
      });
    } finally {
      setExporting(false);
    }
  };

  const dirty =
    title.trim() !== workspace.title ||
    (description || "") !== (workspace.description || "") ||
    (systemPrompt || "") !== (workspace.system_prompt || "") ||
    (modelId || null) !== (workspace.default_model_id || null) ||
    (providerId || null) !== (workspace.default_provider_id || null) ||
    (memModelId || null) !== (workspace.memory_model_id || null) ||
    (memProviderId || null) !== (workspace.memory_provider_id || null);

  // Autosave: debounce changes and persist them, no Save button. The
  // indicator below reflects saving / saved / failed. ``title`` can't be
  // blanked (it's required), so an empty title just parks until refilled.
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const skipFirst = useRef(true);

  useEffect(() => {
    if (!canManage) return;
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    if (!dirty || !title.trim()) return;
    const t = setTimeout(async () => {
      setSaveState("saving");
      try {
        await update.mutateAsync({
          title: title.trim(),
          description: description.trim() || null,
          system_prompt: systemPrompt.trim() || null,
          default_model_id: modelId,
          default_provider_id: providerId,
          memory_model_id: memModelId,
          memory_provider_id: memProviderId,
        });
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    title,
    description,
    systemPrompt,
    modelId,
    providerId,
    memModelId,
    memProviderId,
    dirty,
    canManage,
  ]);

  // Let the "Saved" confirmation fade back to the resting hint.
  useEffect(() => {
    if (saveState !== "saved") return;
    const t = setTimeout(() => setSaveState("idle"), 2500);
    return () => clearTimeout(t);
  }, [saveState]);

  const setMemoryMode = async (mode: WorkspaceMemoryMode) => {
    if (mode === workspace.memory_mode) return;
    await update.mutateAsync({ memory_mode: mode });
  };

  const isArchived = Boolean(workspace.archived_at);

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
            disabled={!canManage}
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
            disabled={!canManage}
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
            maxLength={2000}
          />
        </div>
        <WorkspaceInstructionsEditor
          value={systemPrompt}
          onChange={setSystemPrompt}
          disabled={!canManage}
          providerId={providerId}
          modelId={modelId}
        />
        <WorkspaceModelField
          modelId={modelId}
          providerId={providerId}
          disabled={!canManage}
          onChange={(m, p) => {
            setModelId(m);
            setProviderId(p);
          }}
        />
        {canManage && (
          <div className="flex h-5 items-center justify-end">
            <AutosaveIndicator
              state={saveState}
              needsTitle={!title.trim()}
            />
          </div>
        )}
      </section>

      {canManage && (
        <section className="space-y-3 border-t border-[var(--border)] pt-6">
          <h3 className="text-sm font-semibold">Workspace memory</h3>
          <div className="flex flex-wrap items-center gap-2">
            <MemoryModeSelector
              value={workspace.memory_mode}
              onChange={(m) => void setMemoryMode(m)}
              disabled={update.isPending}
            />
            {update.isPending && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />
            )}
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            {workspace.memory_mode === "off" ? (
              <>
                <span className="font-medium text-[var(--text)]">Off</span> — no
                workspace memory. The pinned{" "}
                <strong>Workspace Memory.md</strong> isn't maintained or used in
                chats.
              </>
            ) : workspace.memory_mode === "manual" ? (
              <>
                <span className="font-medium text-[var(--text)]">
                  Self-managed
                </span>{" "}
                — the memory is used in every chat, but only you change it: edit
                it below, <strong>Save to memory</strong> from a chat message, or
                hit <strong>Regenerate</strong>. It's never rewritten on its own.
              </>
            ) : (
              <>
                <span className="font-medium text-[var(--text)]">Auto</span> — a
                pinned <strong>Workspace Memory.md</strong> is auto-maintained
                from recent chats and the workspace's notes, sheets, and boards,
                so other chats pick up the gist. Pinned items you{" "}
                <strong>Save</strong> are kept verbatim.
              </>
            )}
          </p>
          {workspace.memory_mode !== "off" && (
            <>
          <WorkspaceModelField
            modelId={memModelId}
            providerId={memProviderId}
            disabled={!canManage}
            label="Memory model"
            labelHint="(maintains the memory — pick any model from your stack)"
            clearLabel="Use the workspace default model"
            onChange={(m, p) => {
              setMemModelId(m);
              setMemProviderId(p);
            }}
          />
          <div className="space-y-2 text-xs text-[var(--text-muted)]">
            <p>
              This model reads recent chats and rewrites the memory file in the
              background, so good judgment and low cost matter more than speed.
              Which to pick:
            </p>
            <ul className="space-y-1.5">
              <li className="flex gap-2">
                <span className="font-semibold text-[var(--accent)]">
                  Cost-effective
                </span>
                <span>
                  <span className="font-medium text-[var(--text)]">
                    (recommended)
                  </span>{" "}
                  — a fast, cheap model like Claude Haiku, Gemini Flash, or
                  GPT-4o mini. The sweet spot: it runs often without the cost
                  adding up.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-[var(--text)]">
                  Higher-end
                </span>
                <span>
                  — a frontier model (Claude Opus / Sonnet, GPT-4o) when memory
                  accuracy is critical and the extra spend is worth it.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="font-semibold text-[var(--text)]">Local</span>
                <span>
                  — a capable Ollama model (8B+, e.g. Llama 3.1 8B) for zero
                  cost and full privacy. Needs a machine that can run it well;
                  smaller models distill less reliably.
                </span>
              </li>
            </ul>
            <p>
              Leave on the default if you're unsure. Saves automatically.
            </p>
          </div>
          <WorkspaceMemoryEditor
            workspaceId={workspace.id}
            canManage={canManage}
          />
            </>
          )}
        </section>
      )}

      {isOwner && (
        <section className="space-y-3 border-t border-[var(--border)] pt-6">
          <h3 className="text-sm font-semibold">Export</h3>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={
                exporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )
              }
              onClick={() => void handleExport()}
              disabled={exporting}
            >
              {exporting ? "Preparing bundle..." : "Export workspace (.zip)"}
            </Button>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Everything in one archive: notes as Markdown, boards and sheets
            as CSV, chat transcripts, pinned files, and a manifest. Good for
            backups, hand-offs, and records requests.
          </p>
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
              Delete workspace...
            </Button>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Deleting a workspace preserves every conversation inside it — they
            move back to your top-level chat list.
          </p>
        </section>
      )}
    </div>
  );
}

const MEMORY_MODE_OPTIONS: {
  value: WorkspaceMemoryMode;
  label: string;
  title: string;
}[] = [
  { value: "off", label: "Off", title: "No workspace memory" },
  {
    value: "auto",
    label: "Auto",
    title: "Auto-maintained from chats and the workspace's docs",
  },
  {
    value: "manual",
    label: "Self-managed",
    title: "Used in chats, but only you change it",
  },
];

/** Segmented Off / Auto / Self-managed control — mirrors the account memory
 *  toggle so the two memory systems feel consistent. */
function MemoryModeSelector({
  value,
  onChange,
  disabled,
}: {
  value: WorkspaceMemoryMode;
  onChange: (v: WorkspaceMemoryMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Workspace memory mode"
      className="inline-flex rounded-input border border-[var(--border)] p-0.5"
    >
      {MEMORY_MODE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-[1.25rem] px-2.5 py-1 text-xs font-medium transition",
              "disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Tiny status line that replaces the old "Save changes" button — the
 *  General settings now autosave on change. */
function AutosaveIndicator({
  state,
  needsTitle,
}: {
  state: "idle" | "saving" | "saved" | "error";
  needsTitle: boolean;
}) {
  if (needsTitle && state !== "saving") {
    return (
      <span className="text-xs text-[var(--warning)]">
        Title can't be empty — changes pause until you add one.
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--success)]">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--danger)]">
        <CircleAlert className="h-3 w-3" />
        Couldn't save — keep editing to retry
      </span>
    );
  }
  return (
    <span className="text-xs text-[var(--text-muted)]">
      Changes save automatically
    </span>
  );
}

/**
 * View + hand-edit the librarian-maintained Workspace Memory. Collapsed by
 * default (the section above already explains the feature); expanding reveals
 * the stored Markdown, editable in place. Saving replaces the pinned memory
 * file and re-indexes it. Viewers (no edit access) see it read-only.
 */
function WorkspaceMemoryEditor({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const { data, isLoading } = useWorkspaceMemory(workspaceId);
  const save = useSaveWorkspaceMemory(workspaceId);
  const regen = useRegenerateWorkspaceMemory(workspaceId);
  const [open, setOpen] = useState(false);
  // ``draft === null`` means "in sync with the server copy"; any string is an
  // unsaved edit. This keeps the textarea live-updating from auto-runs until
  // the moment the user starts typing.
  const [draft, setDraft] = useState<string | null>(null);

  const loaded = data?.markdown ?? "";
  const value = draft ?? loaded;
  const dirty = draft !== null && draft !== loaded;

  const status = isLoading
    ? "Loading…"
    : data?.exists
      ? data.updated_at
        ? `Updated ${new Date(data.updated_at).toLocaleString()}`
        : "Stored"
      : "Not created yet";

  const busy = save.isPending || regen.isPending;

  const handleSave = async () => {
    if (!dirty) return;
    try {
      await save.mutateAsync(value);
      setDraft(null);
    } catch {
      // Surfaced by the axios interceptor's error toast.
    }
  };

  const handleRegenerate = async () => {
    if (dirty) {
      const ok = await confirm({
        title: "Regenerate memory",
        message:
          "Rebuild the memory from recent chats now? This discards your unsaved edits above.",
        confirmLabel: "Regenerate",
      });
      if (!ok) return;
    }
    try {
      await regen.mutateAsync();
      setDraft(null); // show the freshly distilled doc
    } catch {
      // 422 (no model / no chats) or other failure → toast via interceptor.
    }
  };

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-[var(--text)]">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Stored memory
        </span>
        <span className="truncate text-[11px] text-[var(--text-muted)]">
          {status}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--border)] px-3 py-3">
          {!data?.exists && !isLoading && (
            <p className="text-xs text-[var(--text-muted)]">
              No memory yet. In <strong>Auto</strong> it's created after the
              first chat; in <strong>Self-managed</strong> use{" "}
              <strong>Regenerate</strong>, <strong>Save to memory</strong> from a
              chat, or just write it here and save.
            </p>
          )}
          <textarea
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!canManage || isLoading}
            rows={14}
            placeholder={
              canManage
                ? "# Workspace overview\n\n## Durable facts\n- …\n\n## Decisions\n- …"
                : "No memory stored yet."
            }
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
            maxLength={40000}
          />
          {canManage && (
            <>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="secondary"
                  leftIcon={
                    regen.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={handleRegenerate}
                  disabled={busy}
                  title="Rebuild the memory from this workspace's recent chats now"
                >
                  {regen.isPending ? "Regenerating…" : "Regenerate from chats"}
                </Button>
                <div className="flex shrink-0 items-center gap-2">
                  {dirty && (
                    <button
                      type="button"
                      onClick={() => setDraft(null)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-50"
                    >
                      Reset
                    </button>
                  )}
                  <Button
                    variant="primary"
                    leftIcon={
                      save.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )
                    }
                    onClick={handleSave}
                    disabled={!dirty || busy}
                  >
                    {save.isPending ? "Saving…" : "Save memory"}
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                <strong>Regenerate</strong> distils the workspace's recent chats
                into a fresh memory (merging with what's here). Hand-edits you{" "}
                <strong>Save</strong> may be rewritten on the next run if chats
                contradict them — anything inside the{" "}
                <code className="rounded bg-[var(--hover)] px-1">📌 Pinned</code>{" "}
                block is kept verbatim and never auto-changed.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const WORKSPACE_INSTRUCTIONS_PLACEHOLDER = `Durable facts about this workspace — they go into every chat in it.

Examples:
- I'm writing this in Python 3.11 on Ubuntu; my database is Postgres 15.
- Target audience: high-school physics teachers in Australia.
- Always answer concisely. Skip pleasantries and preamble.
- My team is 3 people — Sarah (PM), Raj (designer), me (engineer).
- When I paste code, default to assuming it's production-ready, not a draft.`;

const WORKSPACE_INSTRUCTIONS_TIPS: string[] = [
  'Write facts and conventions, not tasks. Good: "I use metric units." Bad: "Help me write my report."',
  "Bullet points beat paragraphs — each line is something the AI should treat as always-true.",
  "Include preferences the AI keeps getting wrong (tone, verbosity, formatting). They're why this field exists.",
  "Aim for under ~500 tokens. Larger prompts work, but every chat pays that cost on every turn.",
];

function WorkspaceInstructionsEditor({
  value,
  onChange,
  disabled = false,
  providerId,
  modelId,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  providerId?: string | null;
  modelId?: string | null;
}) {
  const [showTips, setShowTips] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const tokens = useMemo(() => estimateTokens(value), [value]);

  const handleEnhance = async () => {
    if (enhancing || disabled || !value.trim()) return;
    setEnhanceError(null);
    setEnhancing(true);
    try {
      // Uses the workspace's own model; the endpoint 400s with a clear
      // message if no model is set. The "workspace_instructions" mode makes
      // the rewrite fit how Promptly workspaces work (RAG over notes +
      // human-approved write-back), not an autonomous memory.
      const improved = await chatApi.enhancePrompt(
        value,
        providerId,
        modelId,
        "workspace_instructions"
      );
      const cleaned = improved.trim();
      if (cleaned && cleaned !== value.trim()) onChange(cleaned);
    } catch (err) {
      setEnhanceError(apiErrorMessage(err, "Couldn't enhance — try again."));
    } finally {
      setEnhancing(false);
    }
  };

  let toneClass = "text-[var(--success)]";
  let toneLabel = "compact";
  if (tokens >= 1500) {
    toneClass = "text-[var(--danger)]";
    toneLabel = "long — consider trimming";
  } else if (tokens >= 500) {
    toneClass = "text-[var(--warning)]";
    toneLabel = "getting long";
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-xs font-medium text-[var(--text-muted)]">
          Workspace instructions{" "}
          <span className="text-[var(--text-muted)]/70">
            (shared across every chat in this workspace)
          </span>
        </label>
        <button
          type="button"
          onClick={handleEnhance}
          disabled={disabled || enhancing || !value.trim()}
          title="Rewrite these instructions to be clearer and fit how workspaces work"
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent)] transition hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {enhancing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          {enhancing ? "Enhancing…" : "Enhance"}
        </button>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        disabled={disabled || enhancing}
        placeholder={WORKSPACE_INSTRUCTIONS_PLACEHOLDER}
        className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60"
        maxLength={20000}
      />
      {enhanceError && (
        <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
          {enhanceError}
        </div>
      )}
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
          Tips for good workspace instructions
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
            {WORKSPACE_INSTRUCTIONS_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
