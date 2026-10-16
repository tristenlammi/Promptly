import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { discardUnfinished, unfinishedUploads, type UnfinishedUpload } from "@/lib/tusUpload";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Image as ImageIcon,
  Loader2,
  Upload,
  X,
} from "lucide-react";

import {
  selectConflictTasks,
  selectActiveTasks,
  selectFinishedTasks,
  useUploadStore,
  type UploadTask,
} from "@/store/uploadStore";
import { cn } from "@/utils/cn";

import { humanSize } from "./helpers";

/**
 * Drive upload progress panel.
 *
 * Mounted once in ``AppLayout`` and gated to ``/files*`` — lives
 * module-level state in ``uploadStore`` so navigating between
 * Recent / Starred / Trash / Search / folders never interrupts an
 * upload, but hopping over to ``/chat`` hides the panel without
 * cancelling anything.
 *
 * Design notes:
 *   - Renders **nothing** when the queue is empty. Zero UI tax for
 *     everyone who isn't currently uploading something.
 *   - Matches the existing Drive palette (``var(--surface)``,
 *     ``var(--border)``, ``var(--accent)``) instead of inventing
 *     new colours.
 *   - Collapsible header so a long tail of "done" rows doesn't
 *     dominate the viewport on slow uploads.
 *   - Sits safely above the mobile bottom nav and above the
 *     ``FilePreviewModal`` z-layer (both use ``z-50``) — we pick
 *     ``z-40`` so previews can still land over the panel, matching
 *     Google Drive's behaviour.
 */
export function UploadProgressPanel() {
  const location = useLocation();
  const active = useUploadStore(selectActiveTasks);
  const finished = useUploadStore(selectFinishedTasks);
  const collapsed = useUploadStore((s) => s.panelCollapsed);
  const setCollapsed = useUploadStore((s) => s.setPanelCollapsed);
  const clearCompleted = useUploadStore((s) => s.clearCompleted);
  const cancelUpload = useUploadStore((s) => s.cancelUpload);
  const dismissTask = useUploadStore((s) => s.dismissTask);
  const retryUpload = useUploadStore((s) => s.retryUpload);
  const retryAllFailed = useUploadStore((s) => s.retryAllFailed);
  const resolveConflict = useUploadStore((s) => s.resolveConflict);
  const conflicts = useUploadStore(useShallow(selectConflictTasks));
  const failedCount = finished.filter((t) => t.status === "error").length;

  // The full panel where files are (Files, and a workspace's drive);
  // elsewhere a small pill while anything is still going (WP-8.2).
  const isDriveRoute = useMemo(
    () => /^\/(files|workspaces)(\/|$)/.test(location.pathname),
    [location.pathname]
  );
  const [pillOpen, setPillOpen] = useState(false);

  // Big uploads that never finished (a refresh, a closed tab): choose the
  // same file again to carry on (WP-8.2).
  const [unfinished, setUnfinished] = useState<UnfinishedUpload[]>([]);
  const taskCount = useUploadStore((s) => s.tasks.length);
  useEffect(() => {
    let alive = true;
    void unfinishedUploads().then((list) => {
      if (!alive) return;
      const running = useUploadStore.getState().tasks.filter((t) => t.status !== "done");
      // Not the ones going on in this tab right now.
      setUnfinished(list.filter((u) => !running.some((t) => t.name === u.name && t.size === u.size)));
    });
    return () => {
      alive = false;
    };
  }, [taskCount, active.length]);
  const startUploads = useUploadStore((s) => s.startUploads);

  const total = active.length + finished.length + conflicts.length + (isDriveRoute ? unfinished.length : 0);
  const pending = active.length + conflicts.length;
  if (total === 0 || (!isDriveRoute && pending === 0)) return null;

  const activeBytes = active.reduce((acc, t) => acc + t.size, 0);
  const uploadedBytes = active.reduce((acc, t) => acc + t.uploaded, 0);
  const aggregate =
    activeBytes === 0
      ? 1
      : Math.min(1, uploadedBytes / Math.max(1, activeBytes));

  if (!isDriveRoute && !pillOpen) {
    return (
      <button
        type="button"
        onClick={() => setPillOpen(true)}
        aria-label="Show uploads"
        className={cn(
          "fixed z-40 right-2 sm:right-4 bottom-[max(env(safe-area-inset-bottom,0),1rem)]",
          "inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5",
          "text-xs font-medium text-[var(--text)] shadow-lg hover:bg-[var(--hover)]"
        )}
      >
        {active.length > 0 ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-text)]" />
        ) : (
          <Upload className="h-3.5 w-3.5 text-[var(--accent-text)]" />
        )}
        {active.length > 0
          ? `Uploading ${active.length} · ${Math.round(aggregate * 100)}%`
          : `${conflicts.length} upload${conflicts.length === 1 ? "" : "s"} need you`}
      </button>
    );
  }

  const headerTitle =
    active.length > 0
      ? `Uploading ${active.length} file${active.length === 1 ? "" : "s"}`
      : finished.length === 0 && unfinished.length > 0
        ? `${unfinished.length} upload${unfinished.length === 1 ? "" : "s"} to finish`
        : `${finished.length} upload${finished.length === 1 ? "" : "s"} complete`;

  return (
    <div
      role="region"
      aria-label="Uploads"
      className={cn(
        // Anchored bottom-right everywhere; the horizontal inset is
        // generous enough to avoid clipping into the iOS rounded
        // corner. ``pb-safe`` + ``mb-4`` nudges the panel above the
        // iOS home indicator so the header + Dismiss button stay
        // tappable.
        "fixed z-40 w-[min(92vw,22rem)]",
        "right-2 sm:right-4",
        "bottom-[max(env(safe-area-inset-bottom,0),1rem)]",
        "rounded-card border border-[var(--border)] bg-[var(--surface)]",
        "text-[var(--text)] shadow-xl"
      )}
    >
      {/* Header — always visible, serves as the collapse toggle.
          Clicking the file-count row is the primary way to reveal/
          hide the list; the chevron is just an affordance. */}
      <button
        type="button"
        // Away from files, folding it goes back to the pill.
        onClick={() => (isDriveRoute ? setCollapsed(!collapsed) : setPillOpen(false))}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          "border-b border-transparent",
          !collapsed && "border-[var(--border)]"
        )}
        aria-expanded={!collapsed}
      >
        <div className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent-text)]">
          {active.length > 0 ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{headerTitle}</div>
          {active.length > 0 && (
            <div className="truncate text-[11px] text-[var(--text-muted)]">
              {humanSize(uploadedBytes)} of {humanSize(activeBytes)} ·{" "}
              {Math.round(aggregate * 100)}%
            </div>
          )}
        </div>
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--hover)]"
          aria-hidden="true"
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          )}
        </span>
      </button>

      {/* Aggregate progress bar — tucked just under the header so
          collapsed users still see a pulse while uploads are in
          flight. Hidden when nothing is active. */}
      {active.length > 0 && (
        <div className="h-0.5 w-full bg-[var(--border)]/60">
          <div
            className="h-0.5 bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${Math.round(aggregate * 100)}%` }}
          />
        </div>
      )}

      {!collapsed && (
        <div className="max-h-[45vh] overflow-y-auto">
          <ul className="divide-y divide-[var(--border)]/60">
            {unfinished.map((u) => (
              <UnfinishedRow
                key={u.key}
                upload={u}
                onPicked={(file) => {
                  startUploads({
                    files: [file],
                    scope: u.scope === "shared" ? "shared" : "mine",
                    folderId: u.folderId,
                    workspaceId: u.workspaceId ?? undefined,
                    onConflict: "keep_both",
                  });
                  setUnfinished((list) => list.filter((x) => x.key !== u.key));
                }}
                onDiscard={() => {
                  void discardUnfinished(u);
                  setUnfinished((list) => list.filter((x) => x.key !== u.key));
                }}
              />
            ))}
            {conflicts.map((t) => (
              <li key={t.id} className="px-3 py-2 text-xs">
                <div className="truncate text-[var(--text)]">
                  “{t.name}” is already in this folder
                </div>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => resolveConflict(t.id, "replace")}
                    className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
                    title="The file gets the new content; what it had is kept as a version you can go back to"
                  >
                    Replace (keep the old one as a version)
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveConflict(t.id, "keep_both")}
                    className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
                  >
                    Keep both
                  </button>
                  <button
                    type="button"
                    onClick={() => resolveConflict(t.id, "skip")}
                    className="rounded px-2 py-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    Skip
                  </button>
                </div>
              </li>
            ))}
            {active.map((t) => (
              <UploadRow
                key={t.id}
                task={t}
                onCancel={() => cancelUpload(t.id)}
              />
            ))}
            {finished.map((t) => (
              <UploadRow
                key={t.id}
                task={t}
                onDismiss={() => dismissTask(t.id)}
                onRetry={t.status === "error" ? () => retryUpload(t.id) : undefined}
              />
            ))}
          </ul>

          {finished.length > 0 && (
            <div className="flex justify-end gap-3 border-t border-[var(--border)]/60 px-3 py-1.5">
              {failedCount > 1 && (
                <button
                  type="button"
                  onClick={retryAllFailed}
                  className="text-[11px] font-medium text-[var(--accent-text)] hover:underline"
                >
                  Retry all failed
                </button>
              )}
              <button
                type="button"
                onClick={clearCompleted}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                Clear completed
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UploadRow({
  task,
  onCancel,
  onDismiss,
  onRetry,
}: {
  task: UploadTask;
  onCancel?: () => void;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  const pct =
    task.status === "done"
      ? 100
      : task.size === 0
        ? 0
        : Math.min(100, Math.round((task.uploaded / task.size) * 100));

  const Icon = pickFileIcon(task.name);
  const statusClass = statusRowClass(task.status);

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg)] text-[var(--text-muted)]">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[13px] font-medium text-[var(--text)]"
          title={task.name}
        >
          {task.name}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border)]/60">
            <div
              className={cn(
                "h-1 rounded-full transition-[width] duration-300",
                statusClass.bar
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={cn("text-[10px] tabular-nums", statusClass.pct)}>
            {statusLabel(task, pct)}
          </span>
        </div>
        {task.status === "error" && task.error && (
          <div className="mt-1 truncate text-[10px] text-red-500" title={task.error}>
            {task.error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center">
        {task.status === "queued" || task.status === "uploading" ? (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            aria-label="Cancel upload"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            {task.status === "done" && (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            )}
            {task.status === "error" && (
              <AlertCircle className="h-3.5 w-3.5 text-red-500" />
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                title="Retry"
                aria-label="Retry upload"
                className="inline-flex h-6 items-center justify-center rounded px-1.5 text-[11px] font-medium text-[var(--accent-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              title="Dismiss"
              aria-label="Dismiss upload"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

// ----------------------------------------------------------------
// Visual helpers
// ----------------------------------------------------------------

/** An upload that stopped part-way (WP-8.2): pick the same file to resume. */
function UnfinishedRow({
  upload,
  onPicked,
  onDiscard,
}: {
  upload: UnfinishedUpload;
  onPicked: (file: File) => void;
  onDiscard: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [wrong, setWrong] = useState(false);
  return (
    <li className="px-3 py-2 text-xs">
      <div className="truncate text-[var(--text)]" title={upload.name}>
        “{upload.name}” didn't finish
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
        {wrong ? "That's a different file — choose the same one to carry on." : "Choose the same file to carry on from where it stopped."}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
        >
          Choose file to continue
        </button>
        <button type="button" onClick={onDiscard} className="rounded px-2 py-0.5 text-[var(--text-muted)] hover:text-[var(--text)]">
          Discard
        </button>
        <input
          ref={input}
          type="file"
          className="hidden"
          aria-label={`Continue uploading ${upload.name}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.name !== upload.name || (upload.size !== null && file.size !== upload.size)) {
              setWrong(true);
              return;
            }
            onPicked(file);
          }}
        />
      </div>
    </li>
  );
}

function statusLabel(task: UploadTask, pct: number): string {
  switch (task.status) {
    case "queued":
      return "Queued";
    case "uploading":
      return `${pct}%`;
    case "done":
      return task.skipped ? "Already there" : "Done";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "conflict":
      return "Name taken";
  }
}

function statusRowClass(status: UploadTask["status"]): {
  bar: string;
  pct: string;
} {
  switch (status) {
    case "done":
      return {
        bar: "bg-emerald-500",
        pct: "text-emerald-600 dark:text-emerald-400",
      };
    case "error":
      return { bar: "bg-red-500", pct: "text-red-600 dark:text-red-400" };
    case "cancelled":
      return {
        bar: "bg-[var(--text-muted)]",
        pct: "text-[var(--text-muted)]",
      };
    default:
      return {
        bar: "bg-[var(--accent)]",
        pct: "text-[var(--text-muted)]",
      };
  }
}

function pickFileIcon(name: string): typeof FileText {
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(lower)) return ImageIcon;
  return FileText;
}
