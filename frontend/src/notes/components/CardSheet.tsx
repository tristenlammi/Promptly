import { Archive, ArchiveRestore, BellPlus, CheckCircle2, Pin, PinOff, RotateCcw, Tag, Trash2, UserPlus, Users } from "lucide-react";

import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { displayTitle, type Note } from "../types";
import type { CardActions } from "./NoteCard";
import { ColorGrid } from "./pickers";

/**
 * Everything you can do with one note, as a sheet: what a card's hover
 * buttons do on a computer, for a finger (press and hold a card). Picking
 * one closes the sheet and does it.
 */
export function CardSheet({ note, trash, actions, onClose }: { note: Note; trash: boolean; actions: CardActions; onClose: () => void }) {
  // "Remind me" and labels open under the card the sheet was for.
  const card = () => document.querySelector<HTMLElement>(`[data-note-card="${note.id}"]`);
  const row = (Icon: React.ComponentType<{ className?: string }>, label: string, run: () => void, danger = false) => (
    <button
      type="button"
      onClick={() => {
        onClose();
        run();
      }}
      className={cn(
        "flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none",
        danger ? "text-[var(--danger)]" : "text-[var(--text)]",
      )}
    >
      <Icon className={cn("h-5 w-5 shrink-0", !danger && "text-[var(--text-muted)]")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  return (
    <Sheet open onClose={onClose} title={displayTitle(note)} size="sm">
      {trash ? (
        <div className="flex flex-col">
          {row(RotateCcw, "Restore", () => actions.restore(note.id))}
          {row(Trash2, "Delete forever", () => actions.forever(note.id), true)}
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="mb-1 flex justify-center border-b border-[var(--border)] pb-2">
            <ColorGrid
              value={note.color}
              onPick={(c) => {
                actions.color(note.id, c);
                onClose();
              }}
            />
          </div>
          {row(CheckCircle2, "Select", () => actions.select(note.id, "toggle"))}
          {row(note.pinned ? PinOff : Pin, note.pinned ? "Unpin" : "Pin", () => actions.pin(note.id, !note.pinned))}
          {row(BellPlus, note.reminder ? "Change the reminder" : "Remind me", () => {
            const a = card();
            if (a) actions.remind(note.id, a);
          })}
          {row(note.is_owner ? UserPlus : Users, note.is_owner ? "Share" : "People on this note", () => actions.share(note.id))}
          {row(Tag, note.labels.length ? "Change labels" : "Add a label", () => {
            const a = card();
            if (a) actions.labels(note.id, a);
          })}
          {row(note.archived ? ArchiveRestore : Archive, note.archived ? "Unarchive" : "Archive", () => actions.archive(note.id, !note.archived))}
          {row(Trash2, note.is_owner ? "Delete" : "Remove from my notes", () => actions.trash(note.id), true)}
        </div>
      )}
    </Sheet>
  );
}
