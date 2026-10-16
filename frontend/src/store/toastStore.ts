import { create } from "zustand";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** Optional bold title shown above the message. */
  title?: string;
  /** ms before auto-dismiss. 0 = sticky until the user dismisses it. */
  duration: number;
  /** Optional inline action ("Undo") — clicking runs it and dismisses. */
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (
    t: Omit<Toast, "id" | "duration"> & { duration?: number },
  ) => string;
  dismiss: (id: string) => void;
  /** Change a toast that's showing (a progress message). */
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
  clear: () => void;
}

// Sensible per-type defaults: errors linger longest (the user needs to
// read them), successes flash briefly.
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3500,
  info: 4000,
  warning: 6000,
  error: 7000,
};

let counter = 0;
/** When the last error toast went up — lets the global "that didn't work"
 *  fallback stay quiet when the caller already said something. */
let lastErrorToastAt = 0;
export const lastErrorToast = () => lastErrorToastAt;
const nextId = () => `toast-${++counter}`;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId();
    // A toast with an action ("Undo", "Save") needs time to reach — at
    // least 10 s (R-122).
    const base = t.duration ?? DEFAULT_DURATION[t.type];
    const duration = t.action && base > 0 ? Math.max(base, 10_000) : base;
    if (t.type === "error") lastErrorToastAt = Date.now();
    // Cap the on-screen stack so a burst of errors can't bury the UI;
    // keep the most recent few.
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration }].slice(-4) }));
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  update: (id, patch) =>
    set((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
  clear: () => set({ toasts: [] }),
}));

/**
 * Imperative helper so non-React code (axios error handlers, event
 * callbacks, stores) can fire a toast without hooks. Inside components
 * you can also use this directly — it reads the live store instance.
 *
 *   toast.error("Couldn't save changes");
 *   toast.success("Task deleted", { duration: 2000 });
 */
function make(type: ToastType) {
  return (
    message: string,
    opts?: {
      title?: string;
      duration?: number;
      action?: Toast["action"];
    },
  ) => useToastStore.getState().push({ type, message, ...opts });
}

export const toast = {
  success: make("success"),
  error: make("error"),
  info: make("info"),
  warning: make("warning"),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => useToastStore.getState().update(id, patch),
};
