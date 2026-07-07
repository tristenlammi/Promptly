import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Per-folder sidebar expand state (0148).
 *
 * Folders are collapsed by default; only the ids the user has explicitly
 * expanded are stored. Persisted so the open/closed shape survives reloads
 * (the workspace navigator's in-memory ``Set`` collapse state notably does
 * NOT persist — folders should feel stickier than that).
 */
interface FolderUiState {
  /** Folder ids the user has expanded. Absent = collapsed (the default). */
  expanded: Record<string, boolean>;
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Force a folder open — used when creating a chat inside it so the new
   *  chat is visible without a manual expand. */
  expand: (id: string) => void;
}

export const useFolderUiStore = create<FolderUiState>()(
  persist(
    (set, get) => ({
      expanded: {},
      isExpanded: (id) => !!get().expanded[id],
      toggle: (id) =>
        set((s) => {
          const next = { ...s.expanded };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { expanded: next };
        }),
      expand: (id) =>
        set((s) =>
          s.expanded[id]
            ? s
            : { expanded: { ...s.expanded, [id]: true } }
        ),
    }),
    { name: "promptly.chat-folders-ui" }
  )
);
