import { create } from "zustand";

import type { AttachedFile } from "@/components/chat/AttachmentPickerModal";

/**
 * Persists the chat composer's in-progress draft (typed text + pending
 * attachments) outside the React tree.
 *
 * Why this exists: ``AppLayout`` renders two structurally different
 * trees for desktop vs mobile (static sidebar vs slide-in drawer),
 * switched on ``useIsMobile`` (768px). Rotating a phone to landscape
 * frequently crosses that breakpoint — most phones are wider than
 * 768px in landscape — which unmounts the entire ``Outlet`` → page →
 * ``InputBar`` subtree and would wipe any local component state. The
 * uploaded files behind an attachment chip still exist on the server,
 * but the chips (and the typed message) used to vanish on rotation.
 *
 * Keeping the draft in a module-level Zustand store means it survives
 * that remount. Drafts are keyed by conversation id (``"__new__"`` for
 * a not-yet-saved chat) so each thread keeps its own in-progress
 * message — a small bonus over the old behaviour. State is in-memory
 * only: a full page reload still starts fresh, which is fine because
 * the reported issue is rotation, not reload.
 */
export interface ComposerDraft {
  text: string;
  attachments: AttachedFile[];
}

interface ComposerState {
  drafts: Record<string, ComposerDraft>;
  getDraft: (key: string) => ComposerDraft | undefined;
  saveDraft: (key: string, draft: ComposerDraft) => void;
  clearDraft: (key: string) => void;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  drafts: {},
  getDraft: (key) => get().drafts[key],
  saveDraft: (key, draft) =>
    set((state) => ({ drafts: { ...state.drafts, [key]: draft } })),
  clearDraft: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const next = { ...state.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));
