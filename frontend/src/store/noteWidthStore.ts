import { create } from "zustand";
import { persist } from "zustand/middleware";

export type NoteWidth = "default" | "wide" | "full";

interface NoteWidthState {
  width: NoteWidth;
  setWidth: (width: NoteWidth) => void;
  cycle: () => void;
}

// Cycle order for the editor's width toggle button.
const ORDER: NoteWidth[] = ["default", "wide", "full"];

/** Tailwind max-width class for each setting, applied to the document
 *  editor's content column. "full" drops the cap so the editor fills the
 *  pane (handy on a wide screen or for tables / wide content). */
export const NOTE_WIDTH_CLASS: Record<NoteWidth, string> = {
  default: "max-w-3xl",
  wide: "max-w-5xl",
  full: "max-w-none",
};

export const NOTE_WIDTH_LABEL: Record<NoteWidth, string> = {
  default: "Default width",
  wide: "Wide",
  full: "Full width",
};

/**
 * Per-user width preference for the rich-text document editor — shared by
 * workspace notes and standalone Drive documents (same editor). The default
 * 768px column reads well for prose; "wide" and "full" suit tables, wide
 * layouts, or simply a roomier writing area.
 *
 * Persisted to ``localStorage`` (per-user, per-device — same mechanism as
 * the theme stores). A cross-device "saved to profile" setting would live
 * in the backend user settings; a possible follow-up.
 */
export const useNoteWidthStore = create<NoteWidthState>()(
  persist(
    (set, get) => ({
      width: "default",
      setWidth: (width) => set({ width }),
      cycle: () =>
        set({
          width: ORDER[(ORDER.indexOf(get().width) + 1) % ORDER.length],
        }),
    }),
    { name: "promptly.noteWidth" }
  )
);
