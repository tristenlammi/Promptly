import { create } from "zustand";

import type { ChatMessage } from "@/api/types";

/**
 * In-memory transcripts for floating **Subchats**, keyed by the ephemeral
 * subchat conversation id.
 *
 * Why a module store instead of the hook's local state: the SubchatModal is
 * unmounted whenever you navigate to a different chat (it only renders for the
 * chat that owns it). If the transcript lived in {@link useSubchatStream}'s
 * ``useState`` it would be wiped on every such unmount, so returning to the
 * chat would show a blank subchat even though the conversation still exists.
 * Holding turns here lets the exact transcript survive navigation and re-render
 * when you come back.
 *
 * Deliberately NOT persisted to localStorage — subchats are ephemeral (swept
 * server-side after 24h unless kept), so in-memory-across-navigation is the
 * right lifetime. Entries are purged when a subchat is closed / kept / reset.
 */
interface SubchatStoreState {
  transcripts: Record<string, ChatMessage[]>;
  get: (subchatId: string) => ChatMessage[];
  set: (
    subchatId: string,
    updater: (prev: ChatMessage[]) => ChatMessage[]
  ) => void;
  clear: (subchatId: string) => void;
}

const EMPTY: ChatMessage[] = [];

export const useSubchatStore = create<SubchatStoreState>((set, get) => ({
  transcripts: {},
  get: (subchatId) => get().transcripts[subchatId] ?? EMPTY,
  set: (subchatId, updater) =>
    set((state) => ({
      transcripts: {
        ...state.transcripts,
        [subchatId]: updater(state.transcripts[subchatId] ?? EMPTY),
      },
    })),
  clear: (subchatId) =>
    set((state) => {
      if (!(subchatId in state.transcripts)) return state;
      const next = { ...state.transcripts };
      delete next[subchatId];
      return { transcripts: next };
    }),
}));
