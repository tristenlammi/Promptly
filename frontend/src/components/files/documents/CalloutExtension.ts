import { Node, mergeAttributes } from "@tiptap/core";

/**
 * Callout / admonition block — a coloured info/warning/success/danger box
 * that holds normal block content (paragraphs, lists, …). A plain schema
 * node (no NodeView) so it round-trips cleanly through the Yjs → HTML
 * snapshot pipeline and the backend's document_render walker; the variant
 * rides on ``data-variant`` (allow-listed server-side) and drives the CSS
 * colour + icon. 100% our own code — no Tiptap Pro dependency.
 */
export type CalloutVariant = "info" | "warning" | "success" | "danger";

export const CALLOUT_VARIANTS: CalloutVariant[] = [
  "info",
  "warning",
  "success",
  "danger",
];

function normaliseVariant(value: unknown): CalloutVariant {
  return CALLOUT_VARIANTS.includes(value as CalloutVariant)
    ? (value as CalloutVariant)
    : "info";
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block(s) in a callout. */
      setCallout: (attrs?: { variant?: CalloutVariant }) => ReturnType;
      /** Wrap if not in a callout, unwrap if already in one. */
      toggleCallout: (attrs?: { variant?: CalloutVariant }) => ReturnType;
      /** Lift the current block back out of its callout. */
      unsetCallout: () => ReturnType;
      /** Recolour the callout the selection sits in. */
      setCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

export const CalloutExtension = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info" as CalloutVariant,
        parseHTML: (el) => normaliseVariant(el.getAttribute("data-variant")),
        renderHTML: (attrs) => ({ "data-variant": attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "callout",
        class: "doc-callout",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      toggleCallout:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, attrs),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
      setCalloutVariant:
        (variant) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, {
            variant: normaliseVariant(variant),
          }),
    };
  },
});
