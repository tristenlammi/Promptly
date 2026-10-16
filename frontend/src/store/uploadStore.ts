import { create } from "zustand";

import { apiClient } from "@/api/client";
import type { FileItem, FileScope } from "@/api/files";
import { TusRejected, tusUpload } from "@/lib/tusUpload";
import { alreadyThere } from "@/lib/uploadPrecheck";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Upload store — persistent Drive upload queue.
 *
 * Why a module-level store instead of a React-Query mutation:
 * ----------------------------------------------------------
 * React-Query mutations are scoped to the component that invokes
 * them. That's fine for "click upload, get a result, move on" but
 * breaks the moment the user navigates away mid-upload — the
 * mutation is unmounted along with the page and the request is
 * abandoned (or at best untracked).
 *
 * The Drive MVP wants the opposite behaviour:
 *   1. A user can queue ten files in the Files surface, then
 *      immediately switch to Chat without losing progress.
 *   2. When they come back to any ``/files`` surface, the progress
 *      panel is still there, still accurate, and still cancelable.
 *   3. Individual uploads are parallel (not sequential), because a
 *      50 MB PDF and a 40 KB text file shouldn't block each other.
 *
 * So we hoist the queue into a Zustand store that lives at module
 * scope for the whole app lifetime. The queue runner is a plain
 * async function — no hooks involved — which means it keeps running
 * across navigation and even keeps running if every Files page is
 * unmounted.
 *
 * A tiny companion ``UploadQueueWatcher`` component (mounted once
 * at ``AppLayout``) pulls completed tasks off the store and fires
 * the React-Query invalidations that would normally live in
 * ``useUploadFile``'s ``onSuccess``.
 */

export type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  | "error"
  | "cancelled"
  // The folder already has a file with this name — waiting for the user
  // to pick Replace or Keep both (R-212).
  | "conflict";

export type ConflictMode = "ask" | "keep_both" | "replace";

export interface UploadTask {
  /** Client-generated, stable for the life of the panel. */
  id: string;
  /** Filename as it will appear in Drive. */
  name: string;
  /** Reported total bytes — may differ slightly from the blob for
   *  large files with trailing metadata; we use it as the denominator
   *  for the progress bar. */
  size: number;
  /** Bytes reported uploaded so far. */
  uploaded: number;
  status: UploadStatus;
  /** Human-friendly error string when ``status === "error"``. */
  error?: string;
  /** Routing metadata — the watcher uses this to call the right
   *  ``invalidateQueries`` key after a successful upload. */
  scope: FileScope;
  folderId: string | null;
  /** Into this workspace's drive (WP-7.6): the same upload, pinned there. */
  workspaceId?: string;
  route?: "chat" | "generated" | "camera";
  /** How a name clash is handled; "ask" turns one into a ``conflict``. */
  onConflict?: ConflictMode;
  /** Surfaced to the panel for "Just uploaded" / "3s ago" copy. */
  startedAt: number;
  completedAt?: number;
  /** Populated on success so the watcher can surface the new row
   *  in any list that's already displayed. */
  result?: FileItem;
  /** Done without uploading: the same file was already there (WP-8.2). */
  skipped?: boolean;
  /** Internal — allows cancelling the in-flight XHR. Not surfaced
   *  through the public API so components can't accidentally mutate
   *  it; the ``cancel`` action below handles abort properly. */
  _abort?: AbortController;
}

/** Snapshot of a finished task that the watcher has drained, used
 *  by React components to fire side effects (toast, query
 *  invalidation). The store hands these out once each — after the
 *  next read, the same task is no longer reported. */
export interface CompletedTaskEvent {
  id: string;
  scope: FileScope;
  /** The folder it landed in (WP-7.6: only that folder is refreshed). */
  folderId: string | null;
  /** The new file, on success. */
  fileId?: string;
  /** Uploaded into this workspace's drive. */
  workspaceId?: string;
  status: "done" | "error" | "cancelled";
  name: string;
  error?: string;
}

interface StartArgs {
  files: File[];
  scope: FileScope;
  folderId: string | null;
  /** A workspace's drive (WP-7.6); ``folderId`` is then a folder in it. */
  workspaceId?: string;
  route?: "chat" | "generated" | "camera";
  /** Drive surfaces pass "ask" so a clash can be resolved by the user. */
  onConflict?: ConflictMode;
}

interface UploadStoreState {
  tasks: UploadTask[];
  /** Tasks that have moved to ``done``/``error``/``cancelled`` but
   *  haven't been drained by the watcher yet. Drained atomically
   *  in ``consumeCompleted()``. */
  pendingCompletions: CompletedTaskEvent[];
  /** Panel collapse — persisted in the store so navigating away
   *  and back preserves the user's choice. */
  panelCollapsed: boolean;

  /** Enqueue one or more uploads. Kicks off the runner if idle. */
  startUploads: (args: StartArgs) => void;
  /** Abort an in-flight upload or drop a queued one. Idempotent. */
  cancelUpload: (id: string) => void;
  /** Remove a terminal task from the list (e.g. after the user hits
   *  the "x" on a completed row). In-flight tasks are ignored. */
  dismissTask: (id: string) => void;
  /** Remove every finished task — "Clear" button. */
  clearCompleted: () => void;
  /** Send a failed upload again — the file is kept until the task is
   *  dismissed, so nothing needs re-picking (R-212). */
  retryUpload: (id: string) => void;
  retryAllFailed: () => void;
  /** Answer a name clash. */
  resolveConflict: (id: string, mode: "keep_both" | "replace" | "skip") => void;
  /** Panel UI state. */
  setPanelCollapsed: (v: boolean) => void;
  /** Drain completion events for the watcher. */
  consumeCompleted: () => CompletedTaskEvent[];
}

/** Max simultaneous in-flight uploads. Matches what Chrome will
 *  happily open to a single origin before it starts queueing them
 *  anyway, and keeps the progress panel readable. */
const CONCURRENCY = 3;

/** Client-side id — ``crypto.randomUUID`` is ubiquitous in modern
 *  browsers; the fallback only exists for ancient fallbacks. */
function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countActive(tasks: UploadTask[]): number {
  return tasks.filter((t) => t.status === "uploading").length;
}

/** Friendly error extraction — delegates to the shared helper.
 *  (``utils/apiError`` has zero React imports, so the store stays
 *  tree-shakable.) */
function toMessage(err: unknown): string {
  return apiErrorMessage(err, "Upload failed");
}

export const useUploadStore = create<UploadStoreState>((set, get) => ({
  tasks: [],
  pendingCompletions: [],
  panelCollapsed: false,

  startUploads: ({ files, scope, folderId, workspaceId, route, onConflict }) => {
    if (files.length === 0) return;
    const now = Date.now();
    const newTasks: UploadTask[] = files.map((f) => ({
      id: uid(),
      name: f.name,
      size: f.size,
      uploaded: 0,
      status: "queued",
      scope,
      folderId,
      workspaceId,
      route,
      onConflict,
      startedAt: now,
    }));
    void loadPolicy();
    // Stash the File blobs in a side-map keyed by task id. We keep
    // them outside the store so Zustand isn't diffing ~MB-sized
    // File refs on every progress tick.
    newTasks.forEach((t, i) => pendingBlobs.set(t.id, files[i]));
    // Which are already there, byte for byte — one check for the batch
    // (WP-8.2). Auto-routed uploads (chat) are deduped by the server.
    if (!route) {
      const check = alreadyThere({ files, scope, folderId, workspaceId });
      newTasks.forEach((t, i) => prechecks.set(t.id, check.then((skip) => skip.has(i))));
    }
    set((s) => ({ tasks: [...s.tasks, ...newTasks] }));
    schedule();
  },

  cancelUpload: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "queued") {
      pendingBlobs.delete(id);
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: "cancelled", completedAt: Date.now() } : t
        ),
        pendingCompletions: [
          ...s.pendingCompletions,
          { id, scope: task.scope, folderId: task.folderId, workspaceId: task.workspaceId, status: "cancelled", name: task.name },
        ],
      }));
      return;
    }
    if (task.status === "uploading") {
      task._abort?.abort();
      // The runner catches the abort and calls ``finishTask`` below,
      // so we don't touch the task state here beyond the abort.
    }
  },

  dismissTask: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === "uploading" || task.status === "queued") return;
    pendingBlobs.delete(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  clearCompleted: () => {
    const keep = (t: UploadTask) =>
      t.status === "queued" || t.status === "uploading" || t.status === "conflict";
    get().tasks.forEach((t) => {
      if (!keep(t)) pendingBlobs.delete(t.id);
    });
    set((s) => ({ tasks: s.tasks.filter(keep) }));
  },

  retryUpload: (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.status !== "error" || !pendingBlobs.has(id)) return;
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: "queued", error: undefined, uploaded: 0, completedAt: undefined }
          : t
      ),
    }));
    schedule();
  },

  retryAllFailed: () => {
    get()
      .tasks.filter((t) => t.status === "error" && pendingBlobs.has(t.id))
      .forEach((t) => get().retryUpload(t.id));
  },

  resolveConflict: (id, mode) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task || task.status !== "conflict") return;
    if (mode === "skip") {
      pendingBlobs.delete(id);
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: "cancelled", completedAt: Date.now() } : t
        ),
      }));
      return;
    }
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, status: "queued", onConflict: mode, error: undefined } : t
      ),
    }));
    schedule();
  },

  setPanelCollapsed: (v) => set({ panelCollapsed: v }),

  consumeCompleted: () => {
    const events = get().pendingCompletions;
    if (events.length === 0) return [];
    set({ pendingCompletions: [] });
    return events;
  },
}));

// ----------------------------------------------------------------
// Queue runner
// ----------------------------------------------------------------
//
// We intentionally live entirely outside React. Each call to
// ``schedule()`` tops up the in-flight pool until we either run out
// of queued tasks or hit ``CONCURRENCY``. The runner never recurses;
// each finished task simply calls ``schedule()`` again so the slot
// is reclaimed.

/** File blobs kept side-channel so the store doesn't serialize
 *  multi-MB ArrayBuffers on every progress tick. Keyed by task id,
 *  cleared when the task settles. */
const pendingBlobs = new Map<string, File>();
/** Per task: "the same file is already there" (WP-8.2). */
const prechecks = new Map<string, Promise<boolean>>();

/** The server's allowlist + size cap, fetched once (R-212): a disallowed
 *  or oversized file is refused here instead of after a full upload. */
interface UploadPolicy {
  max_bytes: number;
  allowed_extensions: string[];
  /** Resumable uploads (WP-8.2): files over ``tus_threshold`` go to
   *  ``tus_endpoint`` (null when it isn't running), up to ``large_max_bytes``. */
  tus_endpoint?: string | null;
  tus_threshold?: number;
  large_max_bytes?: number;
}
let policy: UploadPolicy | null = null;
let policyLoading: Promise<void> | null = null;

function loadPolicy(): Promise<void> {
  if (policy || policyLoading) return policyLoading ?? Promise.resolve();
  policyLoading = apiClient
    .get<UploadPolicy>("/files/upload-policy")
    .then((r) => {
      policy = r.data;
    })
    .catch(() => {
      /* the server still checks — this is only a shortcut */
    })
    .finally(() => {
      policyLoading = null;
    });
  return policyLoading;
}

/** Does this file go the resumable way? */
function viaTus(file: File): boolean {
  return !!policy?.tus_endpoint && file.size > (policy.tus_threshold ?? Infinity);
}

function preflight(file: File): string | null {
  if (!policy) return null;
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!policy.allowed_extensions.includes(ext)) {
    return ext
      ? `${ext} files can't be uploaded here`
      : "Files without an extension can't be uploaded here";
  }
  const limit = viaTus(file) ? (policy.large_max_bytes ?? policy.max_bytes) : policy.max_bytes;
  if (file.size > limit) {
    const gb = limit >= 1024 ** 3;
    return `Too large — the limit is ${gb ? `${Math.round((limit / 1024 ** 3) * 10) / 10} GB` : `${Math.round(limit / (1024 * 1024))} MB`}`;
  }
  if (file.size === 0) return "The file is empty";
  return null;
}

function schedule(): void {
  const state = useUploadStore.getState();
  if (countActive(state.tasks) >= CONCURRENCY) return;
  const next = state.tasks.find((t) => t.status === "queued");
  if (!next) return;
  void runTask(next.id);
  // If there's still room, schedule another. We pick one at a time
  // to keep things simple and because ``startUploads`` calls
  // ``schedule()`` once per batch.
  if (countActive(useUploadStore.getState().tasks) < CONCURRENCY) {
    queueMicrotask(schedule);
  }
}

async function runTask(taskId: string): Promise<void> {
  const state = useUploadStore.getState();
  const task = state.tasks.find((t) => t.id === taskId);
  const blob = pendingBlobs.get(taskId);
  if (!task || !blob) return;
  // Claim the slot before any await, or the scheduler starts it twice.
  const abort = new AbortController();
  useUploadStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === taskId ? { ...t, status: "uploading", _abort: abort } : t
    ),
  }));
  const same = prechecks.get(taskId);
  prechecks.delete(taskId);
  if (same && (await same.catch(() => false))) {
    useUploadStore.setState((s) => ({
      tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, skipped: true } : t)),
    }));
    finishTask(taskId, "done");
    pendingBlobs.delete(taskId);
    schedule();
    return;
  }
  await loadPolicy();
  const refused = preflight(blob);
  if (refused) {
    finishTask(taskId, "error", refused);
    pendingBlobs.delete(taskId); // retrying can't fix this one
    schedule();
    return;
  }

  if (viaTus(blob)) {
    await runTus(taskId, task, blob, abort);
    return;
  }

  const form = new FormData();
  form.append("file", blob);
  form.append("scope", task.scope);
  if (task.folderId) form.append("folder_id", task.folderId);
  if (task.workspaceId) form.append("workspace_id", task.workspaceId);
  if (task.route && !task.folderId && task.scope === "mine") {
    form.append("route", task.route);
  }
  if (task.onConflict) form.append("on_conflict", task.onConflict);

  try {
    const res = await apiClient.post<FileItem>("/files/", form, {
      headers: { "Content-Type": "multipart/form-data" },
      signal: abort.signal,
      // No explicit timeout — the default 30s is way too short for a
      // big PDF on a slow connection. Upload progress itself is the
      // guardrail; if nothing moves for minutes the user can cancel.
      timeout: 0,
      onUploadProgress: (evt) => {
        // ``evt.total`` can be undefined if the server didn't echo
        // Content-Length (rare with multipart, but belt-and-braces);
        // fall back to the blob size we already know.
        const total = evt.total ?? task.size;
        const uploaded = Math.min(evt.loaded, total);
        useUploadStore.setState((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === taskId ? { ...t, uploaded, size: total } : t
          ),
        }));
      },
    });
    finishTask(taskId, "done", undefined, res.data);
    // Fall through to ``schedule()`` in finally.
  } catch (err: unknown) {
    const aborted =
      (err as { code?: string })?.code === "ERR_CANCELED" ||
      (err as { name?: string })?.name === "CanceledError" ||
      (err as { name?: string })?.name === "AbortError";
    const conflict =
      (err as { response?: { status?: number; data?: { detail?: { code?: string } } } })
        ?.response;
    if (aborted) {
      finishTask(taskId, "cancelled");
      pendingBlobs.delete(taskId);
    } else if (conflict?.status === 409 && conflict.data?.detail?.code === "name_exists") {
      // Keep the file: the user chooses Replace or Keep both.
      useUploadStore.setState((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, status: "conflict", uploaded: 0, _abort: undefined } : t
        ),
      }));
    } else {
      // Kept so "Retry" doesn't need the file picked again (R-212).
      finishTask(taskId, "error", toMessage(err));
    }
  } finally {
    if (useUploadStore.getState().tasks.find((t) => t.id === taskId)?.status === "done") {
      pendingBlobs.delete(taskId);
    }
    schedule();
  }
}

/** A big file, resumably (WP-8.2). */
async function runTus(taskId: string, task: UploadTask, blob: File, abort: AbortController): Promise<void> {
  const metadata: Record<string, string> = {
    filename: blob.name,
    filetype: blob.type || "application/octet-stream",
    scope: task.scope,
    last_modified: String(blob.lastModified || ""),
  };
  if (task.folderId) metadata.folder_id = task.folderId;
  if (task.workspaceId) metadata.workspace_id = task.workspaceId;
  if (task.onConflict) metadata.on_conflict = task.onConflict;
  if (task.route && !task.folderId && task.scope === "mine") metadata.route = task.route;
  try {
    const fileId = await tusUpload({
      file: blob,
      metadata,
      signal: abort.signal,
      onProgress: (sent, total) =>
        useUploadStore.setState((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, uploaded: Math.min(sent, total), size: total } : t)),
        })),
    });
    const { data } = await apiClient.get<FileItem>(`/files/${fileId}`);
    finishTask(taskId, "done", undefined, data);
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") {
      finishTask(taskId, "cancelled");
      pendingBlobs.delete(taskId);
    } else if (err instanceof TusRejected && err.status === 409 && (err.detail as { code?: string })?.code === "name_exists") {
      useUploadStore.setState((s) => ({
        tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: "conflict", uploaded: 0, _abort: undefined } : t)),
      }));
    } else {
      finishTask(taskId, "error", err instanceof Error ? err.message : "Upload failed");
    }
  } finally {
    if (useUploadStore.getState().tasks.find((t) => t.id === taskId)?.status === "done") pendingBlobs.delete(taskId);
    schedule();
  }
}

function finishTask(
  taskId: string,
  status: "done" | "error" | "cancelled",
  error?: string,
  result?: FileItem
): void {
  const completedAt = Date.now();
  useUploadStore.setState((s) => {
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) return s;
    return {
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status,
              error,
              result,
              completedAt,
              // Snap uploaded → size on success so the progress bar
              // lands cleanly at 100% even if the last progress tick
              // was just under the total.
              uploaded:
                status === "done" ? t.size : t.uploaded,
              _abort: undefined,
            }
          : t
      ),
      pendingCompletions: [
        ...s.pendingCompletions,
        {
          id: taskId,
          scope: task.scope,
          // Auto-routed uploads (chat / generated) land where the server
          // put them.
          folderId: result?.folder_id ?? task.folderId,
          fileId: result?.id,
          workspaceId: task.workspaceId,
          status,
          name: task.name,
          error,
        },
      ],
    };
  });
}

// ----------------------------------------------------------------
// Selectors — centralised so components stay simple + we don't
// re-implement the same "active vs finished" split ten times.
// ----------------------------------------------------------------

export function selectActiveTasks(state: UploadStoreState): UploadTask[] {
  return state.tasks.filter(
    (t) => t.status === "uploading" || t.status === "queued"
  );
}

export function selectFinishedTasks(state: UploadStoreState): UploadTask[] {
  return state.tasks.filter(
    (t) =>
      t.status === "done" || t.status === "error" || t.status === "cancelled"
  );
}

export function selectConflictTasks(state: UploadStoreState): UploadTask[] {
  return state.tasks.filter((t) => t.status === "conflict");
}

export function selectHasActive(state: UploadStoreState): boolean {
  return selectActiveTasks(state).length > 0;
}

/** Aggregate upload progress (0–1). Used by the nav pill on
 *  surfaces that want a single number rather than a list. */
export function selectAggregateProgress(state: UploadStoreState): number {
  const active = selectActiveTasks(state);
  if (active.length === 0) return 0;
  const total = active.reduce((acc, t) => acc + t.size, 0);
  const done = active.reduce((acc, t) => acc + t.uploaded, 0);
  if (total === 0) return 0;
  return Math.min(1, done / total);
}

/** Warn the user before navigating away if there are in-flight
 *  uploads. Called once at module import — ``beforeunload`` is a
 *  cheap global listener so it's fine to register eagerly. Browsers
 *  ignore the message text and show their own "Changes you made
 *  may not be saved" copy, so we just need to ``preventDefault``. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (selectHasActive(useUploadStore.getState())) {
      e.preventDefault();
      // Chrome requires ``returnValue`` to trigger the dialog.
      e.returnValue = "";
    }
  });
}
