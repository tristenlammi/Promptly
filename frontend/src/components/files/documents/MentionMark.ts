import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Person-mention styling — a lightweight mark (not a node) so it survives
 * the Yjs → HTML → bleach snapshot pipeline the same way Link/Highlight do.
 * Rendered as ``<span data-type="mention" class="doc-mention">@name</span>``
 * (span + class + data-type are all allow-listed server-side), and the
 * backend document_render walker wraps ``mention``-marked text in the same
 * span. ``@date`` inserts plain text, so it needs no mark. Ours, MIT-clean.
 */
export const MentionMark = Mark.create({
  name: "mention",
  inclusive: false,
  excludes: "_", // don't co-mingle with other marks on the same run

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": "mention",
        class: "doc-mention",
      }),
      0,
    ];
  },
});
