import { Node, mergeAttributes } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";

/** The enclosing ``columns`` node and the ``column`` the cursor is in. */
function findColumns(state: EditorState) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "columns") {
      const colDepth = d + 1;
      return {
        node: $from.node(d),
        pos: $from.before(d),
        index: colDepth <= $from.depth ? $from.index(d) : 0,
      };
    }
  }
  return null;
}

/**
 * Multi-column layout — a ``columns`` container holding N ``column`` nodes,
 * each with normal block content. Plain schema nodes (no NodeView) so they
 * round-trip through the Yjs → HTML snapshot + backend document_render
 * walker exactly like the callout node. Rendered as a flex row via
 * ``.doc-columns`` / ``.doc-column`` in index.css. 100% ours — no Pro dep.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      /** Insert a fresh N-column layout (2–4) with an empty paragraph each. */
      setColumns: (count: number) => ReturnType;
      /** Add a column after the one the cursor is in (up to 4). */
      addColumn: () => ReturnType;
      /** Remove the column the cursor is in; one left → unwrap. */
      removeColumn: () => ReturnType;
      /** Dissolve the layout: its columns' blocks, one after another. */
      unsetColumns: () => ReturnType;
    };
  }
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "column",
        class: "doc-column",
      }),
      0,
    ];
  },
});

export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "columns",
        class: "doc-columns",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count) =>
        ({ commands }) => {
          const n = Math.max(2, Math.min(4, Math.floor(count) || 2));
          return commands.insertContent({
            type: this.name,
            content: Array.from({ length: n }, () => ({
              type: "column",
              content: [{ type: "paragraph" }],
            })),
          });
        },
      addColumn:
        () =>
        ({ state, tr, dispatch }) => {
          const found = findColumns(state);
          if (!found || found.node.childCount >= 4) return false;
          if (dispatch) {
            let at = found.pos + 1;
            for (let i = 0; i <= found.index; i++) at += found.node.child(i).nodeSize;
            const schema = state.schema;
            tr.insert(at, schema.nodes.column.create(null, schema.nodes.paragraph.create()));
            dispatch(tr);
          }
          return true;
        },
      removeColumn:
        () =>
        ({ state, tr, dispatch, commands }) => {
          const found = findColumns(state);
          if (!found) return false;
          if (found.node.childCount <= 2) return commands.unsetColumns();
          if (dispatch) {
            let at = found.pos + 1;
            for (let i = 0; i < found.index; i++) at += found.node.child(i).nodeSize;
            tr.delete(at, at + found.node.child(found.index).nodeSize);
            dispatch(tr);
          }
          return true;
        },
      unsetColumns:
        () =>
        ({ state, tr, dispatch }) => {
          const found = findColumns(state);
          if (!found) return false;
          if (dispatch) {
            const blocks: import("@tiptap/pm/model").Node[] = [];
            found.node.forEach((col) => col.forEach((block) => blocks.push(block)));
            tr.replaceWith(found.pos, found.pos + found.node.nodeSize, Fragment.from(blocks));
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
