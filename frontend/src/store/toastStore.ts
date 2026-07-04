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
const nextId = () => `toast-${++counter}`;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId();
    const duration = t.duration ?? DEFAULT_DURATION[t.type];
    // Cap the on-screen stack so a burst of errors can't bury the UI;
    // keep the most recent few.
    set((s) => ({ toasts: [...s.toasts, { ...t, id, duration }].slice(-4) }));
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
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
};
