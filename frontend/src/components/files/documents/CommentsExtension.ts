import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { isTextAnchor, type CommentAnchor } from "@/api/documentComments";

/**
 * Comment highlights (WP-4.5, R-227). Each thread's anchor is a pair of
 * Yjs relative positions, so it follows the text through every edit —
 * yours or a collaborator's — and the highlight is a decoration (nothing
 * is written into the document, so exports and viewers are unaffected).
 * Clicking highlighted text fires ``OPEN_COMMENT_EVENT`` with the thread.
 */
export const OPEN_COMMENT_EVENT = "promptly:open-comment";

export interface CommentMark {
  id: string;
  anchor: CommentAnchor;
  resolved: boolean;
}

interface CommentsState {
  marks: CommentMark[];
  active: string | null;
}

export const commentsKey = new PluginKey<CommentsState>("docComments");

interface SyncBinding {
  doc: Y.Doc;
  type: Y.XmlFragment;
  mapping: Map<unknown, unknown>;
}

function binding(state: EditorState): SyncBinding | null {
  const b = (ySyncPluginKey.getState(state) as { binding?: SyncBinding } | undefined)?.binding;
  return b && b.type && b.mapping ? b : null;
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Anchor + quoted text for the editor's current selection (null when the
 *  selection is empty or there's no Y.Doc binding yet). */
export function anchorFromSelection(editor: Editor): { anchor: CommentAnchor; quote: string } | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const b = binding(editor.state);
  if (!b) return null;
  const relFrom = absolutePositionToRelativePosition(from, b.type, b.mapping as never);
  const relTo = absolutePositionToRelativePosition(to, b.type, b.mapping as never);
  const quote = editor.state.doc.textBetween(from, to, " ").trim().slice(0, 500);
  return {
    anchor: {
      from: toB64(Y.encodeRelativePosition(relFrom)),
      to: toB64(Y.encodeRelativePosition(relTo)),
    },
    quote,
  };
}

/** Where an anchor sits now; null when its text was deleted. */
export function resolveAnchor(state: EditorState, anchor: CommentAnchor | null): { from: number; to: number } | null {
  if (!isTextAnchor(anchor)) return null;
  const b = binding(state);
  if (!b) return null;
  try {
    const from = relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(fromB64(anchor.from)), b.mapping as never);
    const to = relativePositionToAbsolutePosition(b.doc, b.type, Y.decodeRelativePosition(fromB64(anchor.to)), b.mapping as never);
    if (from == null || to == null || to <= from) return null;
    const size = state.doc.content.size;
    return { from: Math.max(0, Math.min(from, size)), to: Math.max(0, Math.min(to, size)) };
  } catch {
    return null;
  }
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docComments: {
      setCommentMarks: (marks: CommentMark[]) => ReturnType;
      setActiveComment: (id: string | null) => ReturnType;
    };
  }
}

export const CommentsExtension = Extension.create({
  name: "docComments",

  addCommands() {
    return {
      setCommentMarks:
        (marks) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(commentsKey, { marks }).setMeta("addToHistory", false));
          return true;
        },
      setActiveComment:
        (id) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(commentsKey, { active: id }).setMeta("addToHistory", false));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<CommentsState>({
        key: commentsKey,
        state: {
          init: () => ({ marks: [], active: null }),
          apply(tr, prev) {
            const meta = tr.getMeta(commentsKey) as Partial<CommentsState> | undefined;
            return meta ? { ...prev, ...meta } : prev;
          },
        },
        props: {
          decorations(state) {
            const s = commentsKey.getState(state);
            if (!s || !s.marks.length) return DecorationSet.empty;
            const decos: Decoration[] = [];
            for (const m of s.marks) {
              if (m.resolved) continue;
              const at = resolveAnchor(state, m.anchor);
              if (!at) continue;
              decos.push(
                Decoration.inline(at.from, at.to, {
                  class: m.id === s.active ? "doc-comment doc-comment-active" : "doc-comment",
                  "data-comment-id": m.id,
                })
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest("[data-comment-id]");
            const id = el?.getAttribute("data-comment-id");
            if (!id) return false;
            document.dispatchEvent(new CustomEvent(OPEN_COMMENT_EVENT, { detail: { id } }));
            view.dispatch(view.state.tr.setMeta(commentsKey, { active: id }));
            return false; // still place the caret
          },
        },
      }),
    ];
  },
});
