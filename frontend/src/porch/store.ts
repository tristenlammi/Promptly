import { create } from "zustand";

/** Porch's own UI state (what isn't server data). */
interface PorchState {
  /** Posts the live feed says arrived in your feed while you were looking:
   *  the "↑ 3 new posts" pill. */
  fresh: string[];
  addFresh: (id: string) => void;
  clearFresh: () => void;
  /** The feed's "Photos only" filter (not saved, by design). */
  photosOnly: boolean;
  setPhotosOnly: (v: boolean) => void;
  /** Sheets any page can open. */
  newGroupOpen: boolean;
  setNewGroupOpen: (v: boolean) => void;
}

export const usePorchStore = create<PorchState>((set) => ({
  fresh: [],
  addFresh: (id) => set((s) => (s.fresh.includes(id) ? s : { fresh: [...s.fresh, id] })),
  clearFresh: () => set({ fresh: [] }),
  photosOnly: false,
  setPhotosOnly: (v) => set({ photosOnly: v, fresh: [] }),
  newGroupOpen: false,
  setNewGroupOpen: (v) => set({ newGroupOpen: v }),
}));
