import { create } from "zustand";

import { apiClient } from "@/api/client";
import type { FileItem, FileScope } from "@/api/files";

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
  | "cancelled";

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
  route?: "chat" | "generated";
  /** Surfaced to the panel for "Just uploaded" / "3s ago" copy. */
  startedAt: number;
  completedAt?: number;
  /** Populated on success so the watcher can surface the new row
   *  in any list that's already displayed. */
  result?: FileItem;
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
  status: "done" | "error" | "cancelled";
  name: string;
  error?: string;
}

interface StartArgs {
  files: File[];
  scope: FileScope;
  folderId: string | null;
  route?: "chat" | "generated";
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

/** Friendly error extraction — mirrors ``extractError`` from
 *  ``components/files/helpers`` but inlined here so the store has
 *  zero React imports (keeps it tree-shakable). */
function toMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as {
      response?: { data?: { detail?: unknown } };
      message?: string;
    };
    const detail = anyErr.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object" && "msg" in first) {
        return String((first as { msg: unknown }).msg);
      }
    }
    if (typeof anyErr.message === "string") return anyErr.message;
  }
  return "Upload failed";
}

export const useUploadStore = create<UploadStoreState>((set, get) => ({
  tasks: [],
  pendingCompletions: [],
  panelCollapsed: false,

  startUploads: ({ files, scope, folderId, route }) => {
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
      route,
      startedAt: now,
    }));
    // Stash the File blobs in a side-map keyed by task id. We keep
    // them outside the store so Zustand isn't diffing ~MB-sized
    // File refs on every progress tick.
    newTasks.forEach((t, i) => pendingBlobs.set(t.id, files[i]));
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
          { id, scope: task.scope, status: "cancelled", name: task.name },
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
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  clearCompleted: () => {
    set((s) => ({
      tasks: s.tasks.filter(
        (t) => t.status === "queued" || t.status === "uploading"
      ),
    }));
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
  const abort = new AbortController();
  useUploadStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === taskId ? { ...t, status: "uploading", _abort: abort } : t
    ),
  }));

  const form = new FormData();
  form.append("file", blob);
  form.append("scope", task.scope);
  if (task.folderId) form.append("folder_id", task.folderId);
  if (task.route && !task.folderId && task.scope === "mine") {
    form.append("route", task.route);
  }

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
    if (aborted) {
      finishTask(taskId, "cancelled");
    } else {
      finishTask(taskId, "error", toMessage(err));
    }
  } finally {
    pendingBlobs.delete(taskId);
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
