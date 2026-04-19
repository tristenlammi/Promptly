import { create } from "zustand";

import type { MessageAttachmentSnapshot } from "@/api/types";

/**
 * Light-weight state for the side-panel artefact editor.
 *
 * We deliberately don't cache the loaded source content here — the
 * panel component owns that and refetches on open via React Query so
 * a save in one panel can't go stale next to a chip elsewhere. This
 * store just answers "is the panel open, and which file is it on?"
 * which is the only thing other components (chips, ChatPage layout)
 * actually need.
 *
 * Open / close is a per-tab concept: closing the panel discards any
 * unsaved edits silently after a confirm prompt the panel itself
 * shows. We don't try to persist drafts across sessions — too much
 * surface area for an undocumented behaviour, and the user can just
 * download the markdown if they want a backup.
 */
interface EditorState {
  /** The PDF (or other rendered) attachment the panel should display.
   *  ``null`` means the panel is closed. We keep the whole snapshot
   *  (not just the id) so the panel can render its header even before
   *  the source content has loaded over the network. */
  open: MessageAttachmentSnapshot | null;

  /** Open the editor for ``attachment``. Replaces any in-flight panel
   *  silently; callers are expected to gate this on the user's
   *  confirmation if they want to protect unsaved edits. In practice
   *  the only call site is the chip click handler, which doesn't have
   *  enough context to know about dirty state — the panel itself
   *  holds the discard-confirm. */
  openEditor: (attachment: MessageAttachmentSnapshot) => void;

  /** Close the panel. Idempotent. */
  closeEditor: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  open: null,
  openEditor: (attachment) => set({ open: attachment }),
  closeEditor: () => set({ open: null }),
}));
