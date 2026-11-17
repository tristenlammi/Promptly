/** Which row of the Ctrl+K list is selected.
 *
 *  The list changes under the person while they type: a command's row can
 *  arrive a moment after the words (it waits on a list of people, files or
 *  voice rooms), and the search results land later still. The selected row
 *  used to be a number kept in step with the list by an effect, one render
 *  behind it. For that moment the row on screen was highlighted-to-be but
 *  the keyboard still held the old number, so an Enter pressed right then
 *  did nothing. Results landing also threw away a row picked with the arrows.
 *
 *  Here the selection is worked out from the list itself, in the same render:
 *  the row the person picked (by its key, for the words they picked it under)
 *  if it is still there, otherwise the list's own default. */

export interface PalettePick {
  /** The words in the box when the row was picked. */
  query: string;
  /** The row's own key (not its place: places move as rows arrive). */
  key: string;
}

/** The selected row's index, or -1 for none. */
export function cursorFor(pick: PalettePick | null, query: string, rowKeys: readonly string[], defaultCursor: number): number {
  if (pick && pick.query === query) {
    const at = rowKeys.indexOf(pick.key);
    if (at >= 0) return at;
  }
  return defaultCursor < rowKeys.length ? defaultCursor : -1;
}

/** Where ↓ (+1) or ↑ (-1) lands from `cursor`: never past either end, and ↑
 *  from "nothing selected" lands on the first row. Null when the list is empty. */
export function step(cursor: number, dir: 1 | -1, rowKeys: readonly string[]): string | null {
  if (!rowKeys.length) return null;
  const next = dir === 1 ? Math.min(rowKeys.length - 1, cursor + 1) : Math.max(0, cursor - 1);
  return rowKeys[next];
}
