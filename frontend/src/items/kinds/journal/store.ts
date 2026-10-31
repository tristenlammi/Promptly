import { useSyncExternalStore } from "react";

/*
 * Which entry the writing overlay is open on. Module-level so the shell's
 * header button (``primaryAction``), any tab and the reading pane can all
 * open the same editor.
 */

export interface EditorRequest {
  /** Bumped on every open, so the editor remounts fresh. */
  seq?: number;
  /** Edit this entry; absent = a new one. */
  entryId?: string;
  /** Presets for a new entry. */
  date?: string;
  templateId?: string | null;
  prompt?: string;
  mood?: number | null;
}

let current: EditorRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const editor = {
  open(req: EditorRequest = {}) {
    seq += 1;
    current = { ...req, seq };
    emit();
  },
  close() {
    current = null;
    emit();
  },
  get() {
    return current;
  },
};

export function useEditorRequest(): EditorRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
