import { useEditorState, type Editor } from "@tiptap/react";

/**
 * Re-render on what a toolbar shows, not on every transaction (WP-4.6,
 * R-234). The editor no longer re-renders the whole modal per transaction
 * (each keystroke, remote edit and remote caret move did); components that
 * read ``editor.isActive`` / ``getAttributes`` / ``can()`` during render
 * call this instead, and update only when the formatting at the cursor
 * changes — the marks there, the blocks around it, the kind of selection,
 * and whether undo / redo are possible. Typing plain text inside a
 * paragraph changes none of that.
 */
export function formatKey(editor: Editor): string {
  const { state } = editor;
  const sel = state.selection;
  const json = sel.toJSON() as { type: string };
  const marks = (m: readonly { type: { name: string }; attrs: Record<string, unknown> }[]) =>
    m.map((x) => (Object.keys(x.attrs).length ? `${x.type.name}${JSON.stringify(x.attrs)}` : x.type.name)).join(",");
  const $from = sel.$from;
  const path: string[] = [];
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    path.push(Object.keys(n.attrs).length ? `${n.type.name}${JSON.stringify(n.attrs)}` : n.type.name);
  }
  const node = json.type === "node" ? `${(sel as unknown as { node: { type: { name: string }; attrs: unknown } }).node.type.name}${JSON.stringify((sel as unknown as { node: { attrs: unknown } }).node.attrs)}` : "";
  let undo = "";
  try {
    undo = `${editor.can().undo() ? 1 : 0}${editor.can().redo() ? 1 : 0}`;
  } catch {
    /* no history plugin */
  }
  return [
    json.type,
    sel.empty ? "c" : "r",
    node,
    marks(state.storedMarks ?? $from.marks()),
    sel.empty ? "" : marks(sel.$to.marks()),
    path.join(">"),
    undo,
    editor.isEditable ? "e" : "v",
  ].join("|");
}

export function useEditorFormatState(editor: Editor | null): void {
  useEditorState({
    editor,
    selector: ({ editor: ed }) => (ed ? formatKey(ed) : ""),
  });
}

/** Re-render when the document itself changes (not on selection or
 *  remote-caret transactions) — e.g. to re-order comment threads. */
export function useEditorDoc(editor: Editor | null): void {
  useEditorState({
    editor,
    selector: ({ editor: ed }) => ed?.state.doc ?? null,
    equalityFn: (a, b) => a === b,
  });
}
