import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Find and replace (WP-4.5, R-226). Highlights every match of the search
 * term, steps through them, and replaces one or all. The matches live in
 * plugin state (decorations), so typing elsewhere — or a collaborator's
 * edit — just re-runs the search; nothing is written into the document
 * until a replace.
 *
 * Matches are found per textblock, so a phrase split across marks
 * (``some **bold** text``) still matches; a match never spans blocks.
 */
export interface FindMatch {
  from: number;
  to: number;
}

interface FindState {
  term: string;
  caseSensitive: boolean;
  matches: FindMatch[];
  current: number;
  decorations: DecorationSet;
}

export const findReplaceKey = new PluginKey<FindState>("findReplace");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      setFindTerm: (term: string, caseSensitive?: boolean) => ReturnType;
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
      clearFind: () => ReturnType;
    };
  }
}

export function findMatches(doc: PMNode, term: string, caseSensitive: boolean): FindMatch[] {
  if (!term) return [];
  const needle = caseSensitive ? term : term.toLowerCase();
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text with a position for each character.
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          text += child.text[i];
          at.push(pos + 1 + offset + i);
        }
      } else {
        // An inline atom (emoji, math, hard break) breaks a match.
        text += "\u0000";
        at.push(-1);
      }
    });
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const from = at[i];
      const last = at[i + needle.length - 1];
      if (from >= 0 && last >= 0) out.push({ from, to: last + 1 });
      i = hay.indexOf(needle, i + Math.max(needle.length, 1));
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, term: string, caseSensitive: boolean, current: number): FindState {
  const matches = findMatches(doc, term, caseSensitive);
  const cur = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : 0;
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === cur ? "find-match find-match-current" : "find-match" })
    )
  );
  return { term, caseSensitive, matches, current: cur, decorations };
}

function select(_state: EditorState, tr: Transaction, m: FindMatch | undefined): Transaction {
  if (!m) return tr;
  return tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
}

export const FindReplaceExtension = Extension.create({
  name: "findReplace",

  addCommands() {
    return {
      setFindTerm:
        (term, caseSensitive = false) =>
        ({ state, tr, dispatch }) => {
          if (dispatch) {
            const next = build(state.doc, term, caseSensitive, 0);
            // Start from the first match after the cursor, like a browser.
            const head = state.selection.from;
            const idx = next.matches.findIndex((m) => m.from >= head);
            const current = idx === -1 ? 0 : idx;
            tr.setMeta(findReplaceKey, { term, caseSensitive, current });
            dispatch(select(state, tr, next.matches[current]));
          }
          return true;
        },
      findNext:
        () =>
        ({ state, tr, dispatch }) => {
          const s = findReplaceKey.getState(state);
          if (!s || !s.matches.length) return false;
          const current = (s.current + 1) % s.matches.length;
          if (dispatch) dispatch(select(state, tr.setMeta(findReplaceKey, { current }), s.matches[current]));
          return true;
        },
      findPrevious:
        () =>
        ({ state, tr, dispatch }) => {
          const s = findReplaceKey.getState(state);
          if (!s || !s.matches.length) return false;
          const current = (s.current - 1 + s.matches.length) % s.matches.length;
          if (dispatch) dispatch(select(state, tr.setMeta(findReplaceKey, { current }), s.matches[current]));
          return true;
        },
      replaceCurrent:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = findReplaceKey.getState(state);
          const m = s?.matches[s.current];
          if (!s || !m) return false;
          if (dispatch) {
            if (replacement) tr.insertText(replacement, m.from, m.to);
            else tr.delete(m.from, m.to);
            // Stay on the same index — the next match slides into it.
            tr.setMeta(findReplaceKey, { current: s.current });
            const after = findMatches(tr.doc, s.term, s.caseSensitive);
            dispatch(select(state, tr, after[Math.min(s.current, after.length - 1)]));
          }
          return true;
        },
      replaceAll:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = findReplaceKey.getState(state);
          if (!s || !s.matches.length) return false;
          if (dispatch) {
            // Back to front so earlier positions stay valid.
            for (const m of [...s.matches].reverse()) {
              if (replacement) tr.insertText(replacement, m.from, m.to);
              else tr.delete(m.from, m.to);
            }
            tr.setMeta(findReplaceKey, { current: 0 });
            dispatch(tr);
          }
          return true;
        },
      clearFind:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findReplaceKey, { term: "", current: 0 }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findReplaceKey,
        state: {
          init: (_config, state) => build(state.doc, "", false, 0),
          apply(tr, prev) {
            const meta = tr.getMeta(findReplaceKey) as Partial<FindState> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const term = meta?.term ?? prev.term;
            const caseSensitive = meta?.caseSensitive ?? prev.caseSensitive;
            const current = meta?.current ?? prev.current;
            if (!term) return build(tr.doc, "", false, 0);
            return build(tr.doc, term, caseSensitive, current);
          },
        },
        props: {
          decorations(state) {
            return findReplaceKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
