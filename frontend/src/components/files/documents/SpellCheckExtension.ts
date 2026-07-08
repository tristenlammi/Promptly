import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type { NspellLike } from "./spellDictionaries";

/**
 * Real-time spell-checking as a ProseMirror decoration overlay.
 *
 * Unlike the browser's native ``spellcheck`` attribute (unreliable, un-
 * styleable, no language control, no custom suggestions), this walks the
 * document, checks each word against an ``nspell`` (Hunspell) instance, and
 * draws a red wavy underline under misspellings via view-only Decorations.
 * Because decorations never touch the document, this is completely safe
 * alongside Yjs collaboration — peers don't see each other's squiggles and
 * the CRDT is untouched.
 *
 * Words inside code (inline ``code`` mark or ``codeBlock``), links, and
 * ``@mention`` chips are skipped — flagging a URL or a variable name as a
 * typo is just noise.
 *
 * Clicking a squiggle fires ``options.onWordClick`` (wired by the editor host
 * to open the suggestion popover). We return ``false`` from ``handleClick`` so
 * the caret still lands where the user clicked — the popover is additive.
 */

export const spellCheckPluginKey = new PluginKey<SpellCheckPluginState>(
  "promptlySpellcheck"
);

/** DOM CustomEvent fired when a user clicks a misspelled word; the editor
 *  host listens for it to open the suggestion popover. ``detail`` is a
 *  {@link SpellCheckWordClick}. */
export const SPELLCHECK_WORD_EVENT = "promptly:spellcheck-word";

export interface SpellCheckWordClick {
  word: string;
  from: number;
  to: number;
  /** Viewport coords of the click, used to anchor the popover. */
  x: number;
  y: number;
}

export interface SpellCheckConfig {
  enabled: boolean;
  spell: NspellLike | null;
  /** Lower-cased words to treat as correct (personal dictionary + ignores). */
  ignored: Set<string>;
}

interface SpellCheckPluginState extends SpellCheckConfig {
  deco: DecorationSet;
}

export interface SpellCheckOptions {
  onWordClick: ((info: SpellCheckWordClick) => void) | null;
}

// Marks / node types whose text should never be spell-checked.
const SKIP_MARKS = new Set(["code", "link"]);
const SKIP_NODES = new Set(["codeBlock", "mention"]);

// A "word" for checking: a run of letters (any script) with internal
// apostrophes. Digits, punctuation, and symbols split words apart. The
// Unicode ``\p{L}`` class keeps accented + non-Latin scripts intact.
const WORD_RE = /\p{L}[\p{L}'’]*/gu;

// Guard against pathological docs — past this many characters we stop
// decorating so a giant paste can't jank typing. (nspell lookups are cheap,
// but building a huge DecorationSet on every keystroke is not.)
const MAX_CHARS = 200_000;

function shouldSkip(node: PMNode, parent: PMNode | null): boolean {
  if (parent && SKIP_NODES.has(parent.type.name)) return true;
  return node.marks.some((m) => SKIP_MARKS.has(m.type.name));
}

function buildDecorations(
  doc: PMNode,
  spell: NspellLike,
  ignored: Set<string>
): DecorationSet {
  if (doc.content.size > MAX_CHARS) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    if (shouldSkip(node, parent)) return;
    const text = node.text;
    for (const m of text.matchAll(WORD_RE)) {
      const word = m[0];
      if (m.index === undefined) continue;
      // Skip trivial / non-alphabetic-ish tokens quickly.
      if (word.length < 2) continue;
      // Words with a lone apostrophe at an edge ("'tis" is fine; "it'" is
      // a boundary artefact) — normalise trailing/leading marks.
      const clean = word.replace(/^['’]+|['’]+$/g, "");
      if (clean.length < 2) continue;
      if (ignored.has(clean.toLowerCase())) continue;
      if (spell.correct(clean)) continue;
      const from = pos + m.index;
      const to = from + word.length;
      decorations.push(
        Decoration.inline(from, to, {
          class: "spellcheck-error",
        })
      );
    }
  });
  return DecorationSet.create(doc, decorations);
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
              spell: null,
              ignored: new Set<string>(),
              deco: DecorationSet.empty,
            };
          },
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(spellCheckPluginKey) as
              | Partial<SpellCheckConfig>
              | undefined;
            const cfg: SpellCheckPluginState = meta
              ? { ...value, ...meta }
              : value;

            // Nothing that affects spelling changed — just keep the existing
            // decorations aligned with any doc edits.
            if (!meta && !tr.docChanged) {
              return {
                ...cfg,
                deco: value.deco.map(tr.mapping, tr.doc),
              };
            }

            if (!cfg.enabled || !cfg.spell) {
              return { ...cfg, deco: DecorationSet.empty };
            }
            return {
              ...cfg,
              deco: buildDecorations(newState.doc, cfg.spell, cfg.ignored),
            };
          },
        },
        props: {
          decorations(state) {
            return spellCheckPluginKey.getState(state)?.deco ?? null;
          },
          handleClick(view, pos, event) {
            const st = spellCheckPluginKey.getState(view.state);
            if (!st?.enabled || st.deco === DecorationSet.empty) return false;
            const hit = st.deco.find(pos, pos);
            if (hit.length === 0) return false;
            const { from, to } = hit[0];
            const word = view.state.doc
              .textBetween(from, to)
              .replace(/^['’]+|['’]+$/g, "");
            options.onWordClick?.({
              word,
              from,
              to,
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
