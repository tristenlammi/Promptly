/**
 * The "what didn't come across" note an import leaves for the editor page
 * it opens (WP-4.3 Word, WP-4.4 spreadsheets): written just before
 * navigating, read once when the page mounts.
 */
const NOTES_KEY = (id: string) => `promptly.import-notes.${id}`;

export function rememberImportNotes(fileId: string, from: string, notes: string[]): void {
  try {
    window.sessionStorage.setItem(NOTES_KEY(fileId), JSON.stringify({ from, notes }));
  } catch {
    /* the note is a nicety */
  }
}

export function takeImportNotes(fileId: string): { from: string; notes: string[] } | null {
  try {
    const raw = window.sessionStorage.getItem(NOTES_KEY(fileId));
    if (!raw) return null;
    window.sessionStorage.removeItem(NOTES_KEY(fileId));
    return JSON.parse(raw) as { from: string; notes: string[] };
  } catch {
    return null;
  }
}
