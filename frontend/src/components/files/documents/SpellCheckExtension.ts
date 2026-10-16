import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { NspellLike } from "./spellDictionaries";

/**
 * Real-time spell-checking as a ProseMirror decoration overlay, plus optional
 * type-time autocorrect.
 *
 * Unlike the browser's native ``spellcheck`` attribute (unreliable, un-
 * styleable, no language control, no custom suggestions), this walks the
 * document, checks each word against an ``nspell`` (Hunspell) instance, and
 * draws a red wavy underline under misspellings via view-only Decorations.
 * Because decorations never touch the document, this is completely safe
 * alongside Yjs collaboration — peers don't see each other's squiggles and
 * the CRDT is untouched.
 *
 *  - **Squiggles** (``enabled``): the word the caret is currently inside is
 *    skipped, so a word doesn't get underlined mid-typing — only once you
 *    move on from it.
 *  - **Autocorrect** (``autocorrect``): when you type a word boundary
 *    (space / punctuation), a confidently-misspelled preceding word is
 *    replaced with the top suggestion. It's a normal transaction, so one
 *    undo reverts it.
 *
 * Words inside code (inline ``code`` mark or ``codeBlock``), links, and
 * ``@mention`` chips are skipped for both — flagging or "fixing" a URL or a
 * variable name is just noise.
 */

export const spellCheckPluginKey = new PluginKey<SpellCheckPluginState>(
  "promptlySpellcheck"
);

/** DOM CustomEvent fired when a user clicks a misspelled word; the editor
 *  host listens for it to open the suggestion popover. ``detail`` is a
 *  {@link SpellCheckWordClick}. */
export const SPELLCHECK_WORD_EVENT = "promptly:spellcheck-word";

/** Transaction meta flag marking our own autocorrect edit, so it can't
 *  re-trigger the checker or be mistaken for user input. */
const AUTOCORRECT_META = "promptlyAutocorrectApplied";

export interface SpellCheckWordClick {
  word: string;
  from: number;
  to: number;
  /** Viewport coords of the click, used to anchor the popover. */
  x: number;
  y: number;
}

export interface SpellCheckConfig {
  /** Draw the misspelling underlines. */
  enabled: boolean;
  /** Auto-replace misspelled words on a typed word boundary. */
  autocorrect: boolean;
  spell: NspellLike | null;
  /** Lower-cased words to treat as correct (personal dictionary + ignores). */
  ignored: Set<string>;
}

interface SpellCheckPluginState extends SpellCheckConfig {
  deco: DecorationSet;
  /** word → correct?, for the current dictionary + ignore list (R-234). */
  cache: Map<string, boolean>;
}

export interface SpellCheckOptions {
  onWordClick: ((info: SpellCheckWordClick) => void) | null;
}

// Marks / node types whose text should never be spell-checked.
const SKIP_MARKS = new Set(["code", "link"]);
const SKIP_NODES = new Set(["codeBlock", "mention"]);

// A "word": a letter (any script) followed by letters / apostrophes / hyphens.
// Digits and other symbols split words apart, so code-ish tokens (``abc123``)
// don't get flagged or corrected.
const WORD_RE = /\p{L}[\p{L}'’-]*/gu;
const WORD_TAIL_RE = /([\p{L}][\p{L}'’-]*)$/u;
// A single word-constituent character (for expanding a click to its word).
const WORD_CHAR_RE = /[\p{L}'’-]/u;
// Characters that end a word for autocorrect purposes.
const BOUNDARY_RE = /[\s.,;:!?)\]}"»]/;

// Guard against pathological docs — past this many characters we stop
// decorating so a giant paste can't jank typing.
const MAX_CHARS = 200_000;

function shouldSkip(node: PMNode, parent: PMNode | null): boolean {
  if (parent && SKIP_NODES.has(parent.type.name)) return true;
  return node.marks.some((m) => SKIP_MARKS.has(m.type.name));
}

function trim(word: string): string {
  return word.replace(/^['’-]+|['’-]+$/g, "");
}

/**
 * The misspelled word span at a document position, or null.
 *
 * Deliberately independent of the decoration set: the decorations skip the
 * word the caret is inside (so it isn't underlined mid-typing), but clicking a
 * squiggle moves the caret into that very word *before* ``handleClick`` runs —
 * so reading the decoration set there would miss it (the "nothing happens
 * unless I select it first" bug). Scanning the doc at the click position finds
 * the word regardless of caret/selection. Uses the same per-text-node word
 * semantics as ``buildDecorations`` so what's clickable matches what's flagged.
 */
function misspelledWordAt(
  state: EditorState,
  pos: number,
  spell: NspellLike,
  ignored: Set<string>
): { from: number; to: number; word: string } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (SKIP_NODES.has(parent.type.name)) return null;
  const contentStart = $pos.start();
  let result: { from: number; to: number; word: string } | null = null;
  let handled = false;
  parent.descendants((node, offset) => {
    if (handled || !node.isText || !node.text) return;
    const nodeStart = contentStart + offset;
    const nodeEnd = nodeStart + node.text.length;
    if (pos < nodeStart || pos > nodeEnd) return;
    handled = true;
    if (node.marks.some((m) => SKIP_MARKS.has(m.type.name))) return false;
    const text = node.text;
    let a = pos - nodeStart;
    let b = a;
    while (a > 0 && WORD_CHAR_RE.test(text[a - 1])) a--;
    while (b < text.length && WORD_CHAR_RE.test(text[b])) b++;
    const clean = trim(text.slice(a, b));
    if (
      clean.length >= 2 &&
      !ignored.has(clean.toLowerCase()) &&
      !spell.correct(clean)
    ) {
      result = { from: nodeStart + a, to: nodeStart + b, word: clean };
    }
    return false;
  });
  return result;
}

/** Squiggles for the text inside ``node`` (the whole doc, or one
 *  textblock), whose content starts at ``offset``. Word verdicts go
 *  through ``cache`` — most words repeat, and ``spell.correct`` is the
 *  expensive part (R-234). */
function checkWithin(
  node: PMNode,
  offset: number,
  spell: NspellLike,
  ignored: Set<string>,
  cache: Map<string, boolean>,
  caret: number | null,
  out: Decoration[]
): void {
  node.descendants((child, pos, parent) => {
    if (!child.isText || !child.text) return;
    if (shouldSkip(child, parent)) return;
    const text = child.text;
    const base = offset + pos;
    for (const m of text.matchAll(WORD_RE)) {
      if (m.index === undefined) continue;
      const raw = m[0];
      const clean = trim(raw);
      if (clean.length < 2) continue;
      let ok = cache.get(clean);
      if (ok === undefined) {
        ok = ignored.has(clean.toLowerCase()) || spell.correct(clean);
        if (cache.size > 50_000) cache.clear();
        cache.set(clean, ok);
      }
      if (ok) continue;
      const from = base + m.index;
      const to = from + raw.length;
      // Don't underline the word the caret is currently in — it reads as
      // flagging a word "before it's finished". Once the caret leaves, it
      // gets checked like everything else.
      if (caret !== null && caret >= from && caret <= to) continue;
      out.push(Decoration.inline(from, to, { class: "spellcheck-error" }));
    }
  });
}

function buildDecorations(
  doc: PMNode,
  spell: NspellLike,
  ignored: Set<string>,
  caret: number | null,
  cache: Map<string, boolean> = new Map()
): DecorationSet {
  if (doc.content.size > MAX_CHARS) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  checkWithin(doc, 0, spell, ignored, cache, caret, decorations);
  return DecorationSet.create(doc, decorations);
}

/** Re-check only the textblocks overlapping ``ranges`` (R-234): drop their
 *  old squiggles, add fresh ones. Everything else keeps its (mapped) set. */
function recheckRanges(
  set: DecorationSet,
  doc: PMNode,
  ranges: [number, number][],
  spell: NspellLike,
  ignored: Set<string>,
  cache: Map<string, boolean>,
  caret: number | null
): DecorationSet {
  const size = doc.content.size;
  const blocks = new Map<number, PMNode>();
  for (const [a, b] of ranges) {
    // Positions can sit at the very end of the document; never ask for a
    // range past it (that threw on an edit at the end).
    const from = Math.max(0, Math.min(a, b, size));
    const to = Math.min(size, Math.max(a, b, from + 1));
    if (to <= from) continue;
    doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) {
        blocks.set(pos, node);
        return false;
      }
      return true;
    });
  }
  let next = set;
  for (const [pos, node] of blocks) {
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    next = next.remove(next.find(start, end));
    const fresh: Decoration[] = [];
    checkWithin(node, start, spell, ignored, cache, caret, fresh);
    if (fresh.length) next = next.add(doc, fresh);
  }
  return next;
}

/** Where a transaction changed the document, in the new document's
 *  positions. */
function changedRanges(tr: import("@tiptap/pm/state").Transaction): [number, number][] {
  const out: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => {
      out.push([rest.map(ns, -1), rest.map(ne, 1)]);
    });
  });
  return out;
}

// ---- Autocorrect helpers -------------------------------------------------

/** Bounded Levenshtein — returns ``cap + 1`` as soon as it's certain the
 *  distance exceeds ``cap`` (cheap for the tiny strings we compare). */
function levenshtein(a: string, b: string, cap: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > cap) return cap + 1;
  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[bl];
}

/** Re-apply the source word's capitalisation to a suggestion. */
function matchCase(src: string, dst: string): string {
  if (src.length > 1 && src === src.toUpperCase() && src !== src.toLowerCase()) {
    return dst.toUpperCase();
  }
  if (src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) {
    return dst.charAt(0).toUpperCase() + dst.slice(1);
  }
  return dst;
}

/** The confident correction for a word, or null if we shouldn't touch it.
 *  Conservative on purpose — a wrong autocorrect is far more annoying than a
 *  missed one, so we only fix close, unambiguous typos. */
function autoCorrection(
  word: string,
  spell: NspellLike,
  ignored: Set<string>
): string | null {
  if (word.length < 3) return null;
  const lower = word.toLowerCase();
  if (ignored.has(lower)) return null;
  // Leave short all-caps tokens alone — they're usually acronyms.
  if (word === word.toUpperCase() && word !== lower && word.length <= 4) {
    return null;
  }
  if (spell.correct(word)) return null;
  const suggestions = spell.suggest(word);
  if (suggestions.length === 0) return null;
  const top = suggestions[0];
  if (top.toLowerCase() === lower) return null;
  const maxDist = word.length <= 4 ? 1 : 2;
  if (levenshtein(lower, top.toLowerCase(), maxDist) > maxDist) return null;
  const corrected = matchCase(word, top);
  return corrected === word ? null : corrected;
}

/** On a typed word boundary, replace a confidently-misspelled preceding word.
 *  Runs from ``handleTextInput`` (fires only on real typing, never deletes or
 *  programmatic edits), so it can't fire on backspace. The replacement is
 *  deferred to a microtask so the boundary character inserts first; the word
 *  positions are before that insertion, so they stay valid. */
function maybeAutocorrect(
  view: EditorView,
  from: number,
  text: string,
  st: SpellCheckConfig
): void {
  if (!st.spell) return;
  if (!BOUNDARY_RE.test(text)) return;
  const $from = view.state.doc.resolve(from);
  const start = $from.start();
  if (from <= start) return;
  const before = view.state.doc.textBetween(start, from, "\n", "\0");
  const m = WORD_TAIL_RE.exec(before);
  if (!m) return;
  const word = m[1];
  // Don't correct inside code / links.
  const $word = view.state.doc.resolve(from - word.length + 1);
  if ($word.marks().some((mk) => SKIP_MARKS.has(mk.type.name))) return;
  const corrected = autoCorrection(word, st.spell, st.ignored);
  if (!corrected) return;
  const wordFrom = from - word.length;
  const wordTo = from;
  queueMicrotask(() => {
    if (view.isDestroyed) return;
    const now = view.state.doc.textBetween(wordFrom, wordTo, "\n", "\0");
    if (now !== word) return; // doc shifted under us — bail
    view.dispatch(
      view.state.tr
        .insertText(corrected, wordFrom, wordTo)
        .setMeta(AUTOCORRECT_META, true)
    );
  });
}

export const SpellCheckExtension = Extension.create<SpellCheckOptions>({
  name: "promptlySpellcheck",

  addOptions() {
    return {
      onWordClick: null,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<SpellCheckPluginState>({
        key: spellCheckPluginKey,
        state: {
          init() {
            return {
              enabled: false,
              autocorrect: false,
              spell: null,
              ignored: new Set<string>(),
              deco: DecorationSet.empty,
              cache: new Map<string, boolean>(),
            };
          },
          apply(tr, value, oldState, newState) {
            const meta = tr.getMeta(spellCheckPluginKey) as
              | Partial<SpellCheckConfig>
              | undefined;
            // A new dictionary or ignore list invalidates every verdict.
            const cfg: SpellCheckPluginState = meta
              ? { ...value, ...meta, cache: new Map<string, boolean>() }
              : value;

            if (!tr.docChanged && !tr.selectionSet && !meta) {
              return { ...cfg, deco: value.deco.map(tr.mapping, tr.doc) };
            }
            if (!cfg.enabled || !cfg.spell) {
              return { ...cfg, deco: DecorationSet.empty };
            }
            const caret = newState.selection.empty ? newState.selection.head : null;
            if (meta || newState.doc.content.size > MAX_CHARS || value.deco === DecorationSet.empty && tr.docChanged) {
              // Config changed (or first content): check the whole document.
              return { ...cfg, deco: buildDecorations(newState.doc, cfg.spell, cfg.ignored, caret, cfg.cache) };
            }
            // Incremental (R-234): keep the mapped squiggles; re-check only
            // the blocks the edit touched, plus where the caret left and
            // landed (the word being typed is skipped, so those two can
            // change on a caret move alone).
            const ranges = tr.docChanged ? changedRanges(tr) : [];
            const oldCaret = oldState.selection.head;
            const mappedOld = tr.mapping.map(oldCaret);
            ranges.push([mappedOld, mappedOld], [newState.selection.head, newState.selection.head]);
            const mapped = value.deco.map(tr.mapping, tr.doc);
            return {
              ...cfg,
              deco: recheckRanges(mapped, newState.doc, ranges, cfg.spell, cfg.ignored, cfg.cache, caret),
            };
          },
        },
        props: {
          decorations(state) {
            return spellCheckPluginKey.getState(state)?.deco ?? null;
          },
          handleTextInput(view, from, _to, text) {
            const st = spellCheckPluginKey.getState(view.state);
            if (st?.autocorrect && st.spell) {
              maybeAutocorrect(view, from, text, st);
            }
            // Never consume the input — the character must still type.
            return false;
          },
          handleClick(view, pos, event) {
            const st = spellCheckPluginKey.getState(view.state);
            if (!st?.enabled || !st.spell) return false;
            const hit = misspelledWordAt(view.state, pos, st.spell, st.ignored);
            if (!hit) return false;
            options.onWordClick?.({
              word: hit.word,
              from: hit.from,
              to: hit.to,
              x: (event as MouseEvent).clientX,
              y: (event as MouseEvent).clientY,
            });
            // Return false: let ProseMirror also place the caret. The popover
            // is additive, not a replacement for normal click behaviour.
            return false;
          },
        },
      }),
    ];
  },
});
