import { Node, mergeAttributes } from "@tiptap/core";

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
    };
  },
});
