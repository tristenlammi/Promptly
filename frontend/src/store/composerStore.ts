import { create } from "zustand";
import { persist } from "zustand/middleware";

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
 * message — a small bonus over the old behaviour.
 *
 * Phase 3.4 — true draft persistence. The store is now wrapped with
 * ``persist`` so a half-typed message survives a full reload / tab
 * close / PWA restart (like Gmail keeping an unsent draft), not just a
 * rotation remount. Only the **text** is written to ``localStorage``
 * (attachments reference uploaded files/blobs that don't round-trip
 * cleanly) and each persisted draft carries a timestamp so stale
 * drafts expire after {@link DRAFT_TTL_MS}. Attachments still live in
 * memory, so they survive rotation but not a reload — an acceptable
 * trade for not resurrecting orphaned file chips.
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
  // Phase 3.3 — bumped to ask the mounted ``InputBar`` to focus its
  // textarea (e.g. from a global keyboard shortcut). Transient; never
  // persisted (partialize only writes ``drafts``).
  focusNonce: number;
  requestComposerFocus: () => void;
  // Subchat → "Insert into chat". Bumped to ask the mounted ``InputBar``
  // to append ``insertText`` to its current draft and focus. Transient
  // (partialize only writes ``drafts``), mirroring the focus-nonce
  // pattern so we don't have to make the textarea a controlled prop.
  insertNonce: number;
  insertText: string;
  requestComposerInsert: (text: string) => void;
}

/** Text-only shape written to localStorage, with a TTL stamp. */
interface PersistedDraft {
  text: string;
  savedAt: number;
}

/** Drafts older than this are dropped on rehydrate. Long enough to
 *  survive an accidental refresh / overnight gap, short enough that a
 *  message abandoned a week ago doesn't silently reappear. */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const useComposerStore = create<ComposerState>()(
  persist(
    (set, get) => ({
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
      focusNonce: 0,
      requestComposerFocus: () =>
        set((state) => ({ focusNonce: state.focusNonce + 1 })),
      insertNonce: 0,
      insertText: "",
      requestComposerInsert: (text) =>
        set((state) => ({
          insertText: text,
          insertNonce: state.insertNonce + 1,
        })),
    }),
    {
      name: "promptly.composer-drafts",
      // Persist text only (no attachments) with a fresh timestamp.
      // Empty drafts are skipped so we don't leak blank keys.
      partialize: (state) => {
        const out: Record<string, PersistedDraft> = {};
        for (const [key, draft] of Object.entries(state.drafts)) {
          if (draft.text.trim()) {
            out[key] = { text: draft.text, savedAt: Date.now() };
          }
        }
        return { drafts: out } as unknown as ComposerState;
      },
      // Rehydrate persisted text-only drafts into full drafts (empty
      // attachments), dropping anything past the TTL.
      merge: (persisted, current) => {
        const restored: Record<string, ComposerDraft> = {};
        const saved = (persisted as { drafts?: Record<string, PersistedDraft> })
          ?.drafts;
        if (saved) {
          const cutoff = Date.now() - DRAFT_TTL_MS;
          for (const [key, d] of Object.entries(saved)) {
            if (d && typeof d.text === "string" && (d.savedAt ?? 0) >= cutoff) {
              restored[key] = { text: d.text, attachments: [] };
            }
          }
        }
        return { ...current, drafts: restored };
      },
    }
  )
);
