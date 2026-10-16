import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

/**
 * Suggestion mode (Stage 6 stretch) — track changes for Docs.
 *
 * Two marks carry what's suggested, with who and when:
 *   suggestionInsert → <span data-suggest="ins">, shown underlined
 *   suggestionDelete → <span data-suggest="del">, shown struck through
 * They're ordinary marks, so they sync through the collaborative Y.Doc and
 * travel in the HTML snapshot (and become Word tracked changes on export).
 *
 * In suggesting mode (per person, not per document) the plugin rewrites
 * your edits as you make them: new text is marked as your insertion;
 * deleting text strikes it through instead of removing it — unless it was
 * your own pending insertion, which simply goes. Structure (a new
 * paragraph, joining two) and formatting are applied directly.
 *
 * Accepting an insertion keeps the text; accepting a deletion removes it.
 * Rejecting does the opposite. Those, and changes from other people (or
 * undo), are never tracked again.
 */

export const SUGGESTION_CLICK_EVENT = "promptly:suggestion-click";
const INTERNAL = "promptly-suggestion-internal";
const key = new PluginKey("suggestions");

export interface SuggestionAuthor {
  id: string;
  name: string;
}

export interface SuggestionClick {
  id: string;
  kind: "ins" | "del";
  author: string;
  at: string;
  rect: { left: number; top: number; bottom: number };
}

const attrs = {
  id: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-id"), renderHTML: (a: Record<string, unknown>) => ({ "data-id": a.id }) },
  author: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-author") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-author": a.author }) },
  authorId: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-author-id") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-author-id": a.authorId }) },
  at: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-at") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-at": a.at }) },
};

export const SuggestionInsert = Mark.create({
  name: "suggestionInsert",
  inclusive: false,
  excludes: "suggestionDelete",
  addAttributes: () => attrs,
  parseHTML: () => [{ tag: 'span[data-suggest="ins"]' }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-suggest": "ins", class: "suggestion-ins" }), 0],
});

export const SuggestionDelete = Mark.create({
  name: "suggestionDelete",
  inclusive: false,
  excludes: "suggestionInsert",
  addAttributes: () => attrs,
  parseHTML: () => [{ tag: 'span[data-suggest="del"]' }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { "data-suggest": "del", class: "suggestion-del" }), 0],
});

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function markOf(node: PMNode, name: string): PMMark | undefined {
  return node.marks.find((m) => m.type.name === name);
}

/** Every range carrying a suggestion mark with this id: [from, to, kind]. */
function rangesOf(doc: PMNode, id: string | null): { from: number; to: number; kind: "ins" | "del" }[] {
  const out: { from: number; to: number; kind: "ins" | "del" }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const [name, kind] of [["suggestionInsert", "ins"], ["suggestionDelete", "del"]] as const) {
      const m = markOf(node, name);
      if (m && (id === null || m.attrs.id === id)) out.push({ from: pos, to: pos + node.nodeSize, kind });
    }
  });
  return out;
}

/** Accept or reject one suggestion (by id) or all of them; a transaction. */
function resolve(state: EditorState, id: string | null, accept: boolean): Transaction | null {
  const ranges = rangesOf(state.doc, id);
  if (!ranges.length) return null;
  const tr = state.tr.setMeta(INTERNAL, true);
  const ins = state.schema.marks.suggestionInsert;
  const del = state.schema.marks.suggestionDelete;
  // Back to front, so earlier positions stay put.
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    const drop = (r.kind === "ins") !== accept; // reject an insert, accept a delete
    if (drop) tr.delete(r.from, r.to);
    else tr.removeMark(r.from, r.to, r.kind === "ins" ? ins : del);
  }
  return tr;
}

export const SuggestionExtension = Extension.create<{ author: SuggestionAuthor | null }, { enabled: boolean }>({
  name: "suggestions",

  addOptions: () => ({ author: null }),
  addStorage: () => ({ enabled: false }),

  addExtensions: () => [SuggestionInsert, SuggestionDelete],

  addCommands() {
    return {
      setSuggesting:
        (on: boolean) =>
        ({ editor }) => {
          this.storage.enabled = on;
          editor.view.dispatch(editor.state.tr.setMeta(key, { enabled: on }));
          return true;
        },
      acceptSuggestion:
        (id: string) =>
        ({ state, dispatch }) => {
          const tr = resolve(state, id, true);
          if (tr && dispatch) dispatch(tr);
          return !!tr;
        },
      rejectSuggestion:
        (id: string) =>
        ({ state, dispatch }) => {
          const tr = resolve(state, id, false);
          if (tr && dispatch) dispatch(tr);
          return !!tr;
        },
      acceptAllSuggestions:
        () =>
        ({ state, dispatch }) => {
          const tr = resolve(state, null, true);
          if (tr && dispatch) dispatch(tr);
          return !!tr;
        },
      rejectAllSuggestions:
        () =>
        ({ state, dispatch }) => {
          const tr = resolve(state, null, false);
          if (tr && dispatch) dispatch(tr);
          return !!tr;
        },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key,
        props: {
          // A click on a suggestion opens its accept / reject bubble.
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos);
            const node = $pos.parent.maybeChild($pos.index()) ?? $pos.nodeBefore;
            const marks = [...(node?.marks ?? []), ...($pos.nodeBefore?.marks ?? [])];
            const m = marks.find((x) => x.type.name === "suggestionInsert" || x.type.name === "suggestionDelete");
            if (!m) return false;
            const c = view.coordsAtPos(pos);
            document.dispatchEvent(
              new CustomEvent<SuggestionClick>(SUGGESTION_CLICK_EVENT, {
                detail: {
                  id: m.attrs.id, kind: m.type.name === "suggestionInsert" ? "ins" : "del", author: m.attrs.author, at: m.attrs.at,
                  rect: { left: c.left, top: c.top, bottom: c.bottom },
                },
              }),
            );
            return false;
          },
        },
        appendTransaction(transactions, oldState, newState) {
          if (!ext.storage.enabled) return null;
          const author = ext.options.author;
          if (!author) return null;
          // Only your own edits: not someone else's (or undo), not accept/reject.
          const mine = transactions.filter(
            (t) => t.docChanged && !t.getMeta(INTERNAL) && !t.getMeta(ySyncPluginKey)?.isChangeOrigin,
          );
          if (mine.length !== 1 || transactions.length !== 1) return null;
          const t = mine[0];
          const steps = t.steps.filter((s): s is ReplaceStep => s instanceof ReplaceStep);
          if (steps.length !== t.steps.length) return null; // structure-only changes go through
          const insType = newState.schema.marks.suggestionInsert;
          const delType = newState.schema.marks.suggestionDelete;
          const now = new Date().toISOString();
          const tr = newState.tr.setMeta(INTERNAL, true);
          let selection: number | null = null;

          steps.forEach((step, i) => {
            const before = t.docs[i];
            const { from, to, slice } = step as unknown as { from: number; to: number; slice: { size: number; content: PMNode["content"] } };
            const deleted = before.slice(from, to);
            const later = t.mapping.slice(i + 1);
            const a = tr.mapping.map(later.map(from, -1), -1);
            const b = tr.mapping.map(later.map(from + slice.size, 1), 1);

            // What was typed or pasted: your insertion (joining one just before it).
            if (b > a) {
              // Typing on from your own suggestion carries it on (one mark, so one suggestion).
              const prev = a > 0 ? tr.doc.resolve(a).nodeBefore : null;
              const prevIns = prev ? markOf(prev, "suggestionInsert") : undefined;
              const carry = prevIns && prevIns.attrs.authorId === author.id ? prevIns.attrs : null;
              tr.removeMark(a, b, delType);
              tr.addMark(a, b, insType.create(carry ?? { id: newId(), author: author.name, authorId: author.id, at: now }));
            }

            // What was removed: kept, struck through — except text that was only
            // ever your own pending insertion, and structure (no text at all).
            const deletedText = before.textBetween(from, to, "", "");
            if (!deletedText) return;
            let ownOnly = true;
            before.nodesBetween(from, to, (n) => {
              if (n.isText) {
                const m = markOf(n, "suggestionInsert");
                if (!m || m.attrs.authorId !== author.id) ownOnly = false;
              }
            });
            if (ownOnly) return;
            const start = a;
            tr.replace(start, start, deleted);
            const end = start + deleted.size;
            // Mark the restored text, drop the parts that were your own insertions.
            const own: [number, number][] = [];
            tr.doc.nodesBetween(start, end, (n, pos) => {
              if (!n.isText) return;
              const m = markOf(n, "suggestionInsert");
              if (m && m.attrs.authorId === author.id) own.push([Math.max(pos, start), Math.min(pos + n.nodeSize, end)]);
            });
            // Next to your own struck text (Backspace, Backspace…): the same suggestion.
            const neighbour = [tr.doc.resolve(start).nodeBefore, tr.doc.resolve(end).nodeAfter]
              .map((n) => (n ? markOf(n, "suggestionDelete") : undefined))
              .find((m) => m && m.attrs.authorId === author.id);
            const delAttrs = neighbour?.attrs ?? { id: newId(), author: author.name, authorId: author.id, at: now };
            tr.doc.nodesBetween(start, end, (n, pos) => {
              if (!n.isText || markOf(n, "suggestionDelete") || markOf(n, "suggestionInsert")) return;
              tr.addMark(Math.max(pos, start), Math.min(pos + n.nodeSize, end), delType.create(delAttrs));
            });
            for (const [x, y] of own.reverse()) tr.delete(x, y);
            // The cursor: Backspace moves before what you struck, Delete after it.
            const head = oldState.selection.head;
            if (slice.size === 0) selection = head <= from ? end - own.reduce((n, [x, y]) => n + (y - x), 0) : start;
          });

          if (selection !== null) tr.setSelection(TextSelection.create(tr.doc, Math.min(selection, tr.doc.content.size)));
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    suggestions: {
      /** Turn suggesting mode on or off (for this person). */
      setSuggesting: (on: boolean) => ReturnType;
      acceptSuggestion: (id: string) => ReturnType;
      rejectSuggestion: (id: string) => ReturnType;
      acceptAllSuggestions: () => ReturnType;
      rejectAllSuggestions: () => ReturnType;
    };
  }
}

/** How many suggestions a document holds (by id). */
export function countSuggestions(doc: PMNode): number {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const name of ["suggestionInsert", "suggestionDelete"]) {
      const m = markOf(node, name);
      if (m?.attrs.id) ids.add(m.attrs.id);
    }
  });
  return ids.size;
}
