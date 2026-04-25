import { useMemo } from "react";
import { useLocation } from "react-router-dom";
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

  const isDriveRoute = useMemo(
    () =>
      location.pathname === "/files" ||
      location.pathname.startsWith("/files/"),
    [location.pathname]
  );

  const total = active.length + finished.length;
  if (!isDriveRoute || total === 0) return null;

  const activeBytes = active.reduce((acc, t) => acc + t.size, 0);
  const uploadedBytes = active.reduce((acc, t) => acc + t.uploaded, 0);
  const aggregate =
    activeBytes === 0
      ? 1
      : Math.min(1, uploadedBytes / Math.max(1, activeBytes));

  const headerTitle =
    active.length > 0
      ? `Uploading ${active.length} file${active.length === 1 ? "" : "s"}`
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
        onClick={() => setCollapsed(!collapsed)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          "border-b border-transparent",
          !collapsed && "border-[var(--border)]"
        )}
        aria-expanded={!collapsed}
      >
        <div className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
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
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
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
              />
            ))}
          </ul>

          {finished.length > 0 && (
            <div className="flex justify-end border-t border-[var(--border)]/60 px-3 py-1.5">
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
}: {
  task: UploadTask;
  onCancel?: () => void;
  onDismiss?: () => void;
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

function statusLabel(task: UploadTask, pct: number): string {
  switch (task.status) {
    case "queued":
      return "Queued";
    case "uploading":
      return `${pct}%`;
    case "done":
      return "Done";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
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
