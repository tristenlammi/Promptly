import { create } from "zustand";

import type { ArtifactLanguage } from "@/components/codeArtifacts/previewable";

/**
 * Lightweight global store for the Code Artifact side panel.
 *
 * Deliberately minimal — the panel is a singleton (there's only
 * ever one open at a time) so storing it globally is simpler than
 * threading state through the message bubble, chat page, and
 * preview modal. Same pattern as {@link useEditorStore}.
 *
 * When ``sourceFileId`` is set the panel came from Drive (we hide
 * the Save-to-Drive button); otherwise it came from a chat bubble
 * (we show it and populate the suggested filename).
 */

export interface CodeArtifactPayload {
  /** Raw source — the canonical reference copy. CodeMirror edits
   *  never mutate this; they live in the store's ``draft`` field
   *  so we can "Reset" back to it. */
  source: string;
  /** Normalised language key — see {@link normaliseLanguage}. */
  language: ArtifactLanguage;
  /** Suggested filename stem. If omitted we use "artifact". */
  filenameStem?: string;
  /** Chat message that spawned this artifact. Currently only used
   *  for telemetry / future "scroll back to message" affordance. */
  sourceMessageId?: string | null;
  /** When opened from the Drive preview modal this is the file's
   *  UUID; the panel will hide the Save-to-Drive button and can
   *  optionally surface "Open in Drive" (already visible behind). */
  sourceFileId?: string | null;
}

interface State {
  open: boolean;
  payload: CodeArtifactPayload | null;
  /** Current working copy of the source, mutated by CodeMirror.
   *  Reset button snaps this back to ``payload.source``. */
  draft: string;
  activeTab: "preview" | "code";
}

interface Actions {
  openArtifact: (payload: CodeArtifactPayload) => void;
  closeArtifact: () => void;
  setDraft: (draft: string) => void;
  resetDraft: () => void;
  setActiveTab: (tab: "preview" | "code") => void;
}

export const useCodeArtifactStore = create<State & Actions>((set, get) => ({
  open: false,
  payload: null,
  draft: "",
  activeTab: "preview",
  openArtifact: (payload) =>
    set({
      open: true,
      payload,
      draft: payload.source,
      // Default to preview tab — users who open the panel for a
      // previewable language almost always want to see the live
      // result first. The panel falls back to "code" automatically
      // when the language is non-previewable.
      activeTab: "preview",
    }),
  closeArtifact: () => set({ open: false, payload: null, draft: "" }),
  setDraft: (draft) => set({ draft }),
  resetDraft: () => {
    const current = get().payload;
    if (current) set({ draft: current.source });
  },
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
