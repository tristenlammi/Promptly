import { create } from "zustand";

/**
 * Shared state for the Files shell (WP-3.5): the folder tree in the rail
 * reloads when a page bumps ``treeVersion`` after a folder change, and
 * the rail opens as a drawer below 1024 px.
 */
interface FilesShellState {
  treeVersion: number;
  bumpTree: () => void;
  /** "folder:<id>" / "file:<id>" just made here — the page scrolls to it
   *  and selects it once it's listed (the list is virtualised, WP-7.6). */
  revealKey: string | null;
  reveal: (key: string | null) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

export const useFilesShellStore = create<FilesShellState>((set) => ({
  treeVersion: 0,
  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
  revealKey: null,
  reveal: (revealKey) => set({ revealKey }),
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
}));
