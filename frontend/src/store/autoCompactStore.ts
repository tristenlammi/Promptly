import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AutoCompactState {
  /** When on, a conversation is automatically compacted the moment its
   *  estimated context usage crosses ~90% of the model's window — so the
   *  user never hits silent truncation. Off by default (compaction is
   *  destructive, so it stays opt-in). */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

/**
 * Per-device preference for automatic context compaction. Persisted to
 * ``localStorage`` (same mechanism as the note-width / theme stores). The
 * trigger threshold lives in the context-window pill, which already
 * computes the live usage ratio.
 */
export const useAutoCompactStore = create<AutoCompactState>()(
  persist(
    (set, get) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
      toggle: () => set({ enabled: !get().enabled }),
    }),
    { name: "promptly.autoCompact" }
  )
);

/** Fraction of the context window at which auto-compaction fires. */
export const AUTO_COMPACT_THRESHOLD = 0.9;
/** Hysteresis floor — once fired, we don't re-arm until usage drops
 *  back below this, so a single high-usage episode compacts once. */
export const AUTO_COMPACT_REARM = 0.85;
