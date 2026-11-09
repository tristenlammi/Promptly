/**
 * Starting a Notes note from anywhere in Promptly (N1.7): Files' New → Note
 * and its home tile, and the Ctrl+K palette's "New note", "New list" and
 * "Record a voice note". It opens Notes on a new note (``/notes?new=…``,
 * which the installed app's shortcuts use too). Words typed in the palette
 * ("note gate code 4471") are handed over in memory — never in the address.
 */

export type NewNoteKind = "note" | "list" | "voice";

let pending: { kind: NewNoteKind; text: string } | null = null;

export function openNewNote(navigate: (to: string) => void, kind: NewNoteKind, text = ""): void {
  pending = text.trim() ? { kind, text: text.trim() } : null;
  navigate(`/notes?new=${kind}`);
}

/** Notes' side: the words to start the new note with (once). */
export function takeNewNoteText(kind: NewNoteKind): string {
  const p = pending;
  pending = null;
  return p && p.kind === kind ? p.text : "";
}
