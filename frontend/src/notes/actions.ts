/** The things you do to whole notes, with their Undo (shared by the grid,
 *  the selection bar and the editor). */
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";

import { notesActions, useNotes } from "./store";
import type { NoteLabel } from "./types";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** True while "Delete forever?" is up, so its Escape only answers the
 *  question (the note or the selection behind it stays as it was). */
let asking = false;
export const askingToDelete = () => asking;

export const noteOps = {
  pin(ids: string[], pinned: boolean) {
    for (const id of ids) notesActions.me(id, { pinned });
  },
  color(ids: string[], color: string) {
    for (const id of ids) notesActions.patch(id, { color });
  },
  archive(ids: string[], archived: boolean) {
    const wasPinned = new Map(ids.map((id) => [id, useNotes.getState().notes[id]?.pinned ?? false]));
    for (const id of ids) notesActions.me(id, { archived });
    toast.info(archived ? `${plural(ids.length, "Note", "notes")} archived` : `${plural(ids.length, "Note", "notes")} unarchived`, {
      action: {
        label: "Undo",
        onClick: () => {
          for (const id of ids) notesActions.me(id, archived ? { archived: false, pinned: wasPinned.get(id) || undefined } : { archived: true });
        },
      },
    });
  },
  trash(ids: string[]) {
    const s = useNotes.getState();
    const mine = ids.filter((id) => s.notes[id]?.is_owner !== false && !s.drafts[id]);
    const theirs = ids.filter((id) => s.notes[id]?.is_owner === false);
    for (const id of ids) notesActions.trash(id);
    if (mine.length) {
      toast.info(`${plural(mine.length, "Note", "notes")} moved to Trash`, {
        action: { label: "Undo", onClick: () => mine.forEach((id) => notesActions.restore(id)) },
      });
    }
    if (theirs.length) toast.info(theirs.length === 1 ? "Removed from your notes" : `${theirs.length} shared notes removed from your notes`);
  },
  restore(ids: string[]) {
    for (const id of ids) notesActions.restore(id);
    toast.info(`${plural(ids.length, "Note", "notes")} restored`);
  },
  /** Asks first (there's no Undo after this). Resolves true when deleted. */
  async forever(ids: string[]): Promise<boolean> {
    if (!ids.length) return false;
    asking = true;
    let ok = false;
    try {
      ok = await confirm({
        title: ids.length === 1 ? "Delete this note forever?" : `Delete ${ids.length} notes forever?`,
        message: ids.length === 1 ? "It will be gone for good. This can't be undone." : "They will be gone for good. This can't be undone.",
        confirmLabel: "Delete forever",
        danger: true,
      });
    } finally {
      // After the key press that answered it has finished going round.
      setTimeout(() => (asking = false), 0);
    }
    if (!ok) return false;
    for (const id of ids) notesActions.forever(id);
    toast.info(ids.length === 1 ? "Note deleted forever" : `${ids.length} notes deleted forever`);
    return true;
  },
  /** Add or take off one label on several notes. */
  label(ids: string[], label: NoteLabel, on: boolean) {
    const s = useNotes.getState();
    for (const id of ids) {
      const n = s.drafts[id] ?? s.notes[id];
      if (!n) continue;
      const has = n.labels.some((l) => l.name.toLowerCase() === label.name.toLowerCase());
      if (on && !has) notesActions.setLabels(id, [...n.labels, label]);
      if (!on && has) notesActions.setLabels(id, n.labels.filter((l) => l.name.toLowerCase() !== label.name.toLowerCase()));
    }
  },
};
