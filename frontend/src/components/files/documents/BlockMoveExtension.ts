import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";

/**
 * Move the block the cursor is in up or down past its neighbour (WP-4.6,
 * R-231): the drag handle is mouse-only, so phones had no way to reorder.
 * The "block" is the nearest list item, or else the top-level block.
 * Alt+Shift+↑ / ↓ on a keyboard; arrows in the block bar on a phone.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockMove: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

const ITEMS = new Set(["listItem", "taskItem"]);

function movable(state: EditorState): { depth: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if (ITEMS.has($from.node(d).type.name)) return { depth: d };
  }
  return $from.depth >= 1 ? { depth: 1 } : null;
}

function move(state: EditorState, dir: -1 | 1, dispatch?: (tr: import("@tiptap/pm/state").Transaction) => void): boolean {
  const found = movable(state);
  if (!found) return false;
  const $from = state.selection.$from;
  const { depth } = found;
  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const target = index + dir;
  if (target < 0 || target >= parent.childCount) return false;
  if (!dispatch) return true;
  const node = $from.node(depth);
  const start = $from.before(depth);
  const end = start + node.nodeSize;
  const offsetInBlock = state.selection.from - start;
  const tr = state.tr;
  if (dir === -1) {
    const prev = parent.child(target);
    const insertAt = start - prev.nodeSize;
    tr.delete(start, end).insert(insertAt, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(insertAt + offsetInBlock, tr.doc.content.size))));
  } else {
    const next = parent.child(target);
    tr.delete(start, end);
    const insertAt = start + next.nodeSize;
    tr.insert(insertAt, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(insertAt + offsetInBlock, tr.doc.content.size))));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

export const BlockMoveExtension = Extension.create({
  name: "blockMove",
  addCommands() {
    return {
      moveBlockUp:
        () =>
        ({ state, dispatch }) =>
          move(state, -1, dispatch),
      moveBlockDown:
        () =>
        ({ state, dispatch }) =>
          move(state, 1, dispatch),
    };
  },
  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": () => this.editor.commands.moveBlockUp(),
      "Alt-Shift-ArrowDown": () => this.editor.commands.moveBlockDown(),
    };
  },
});
