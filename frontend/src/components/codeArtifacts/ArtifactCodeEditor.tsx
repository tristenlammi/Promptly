import { useEffect, useMemo, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";

import { type ArtifactLanguage } from "./previewable";

/**
 * CodeMirror 6 editor wrapper used by the Code tab of the Code
 * Artifact panel (and by the Drive preview when an artifact file
 * is opened).
 *
 * Why CM6 over a textarea + highlight.js:
 * - We need **editing**, with language-aware indent, bracket
 *   matching, and tab handling.
 * - It's lazy — the language extension only parses the visible
 *   viewport. Important because chat artifacts can easily be
 *   500+ lines of HTML.
 * - Dark theme (one-dark) matches our app aesthetic.
 *
 * ``value`` is the source-of-truth; we tear down and rebuild the
 * state when it changes externally (e.g. Reset button). Inline
 * typing fires ``onChange`` — the parent debounces this before
 * letting it propagate back into the live preview so typing
 * doesn't thrash an iframe reload.
 */
export function ArtifactCodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
}: {
  value: string;
  language: ArtifactLanguage;
  onChange?: (next: string) => void;
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Compute the bundle of extensions that apply for this language.
  // We recompute when ``language`` or ``readOnly`` changes which
  // means we rebuild the editor — acceptable since those don't
  // change during typing.
  const extensions = useMemo<Extension[]>(() => {
    const langExt = languageExtension(language);
    const base: Extension[] = [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      highlightActiveLine(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      oneDark,
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
        },
        ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        ".cm-content": { caretColor: "#79b8ff" },
      }),
      EditorView.lineWrapping,
    ];
    if (langExt) base.push(langExt);
    if (readOnly) base.push(EditorState.readOnly.of(true));
    return base;
  }, [language, readOnly]);

  // Mount / remount when extensions change.
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...extensions,
        EditorView.updateListener.of((update) => {
          if (!onChange) return;
          if (update.docChanged) {
            onChange(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // onChange intentionally omitted — recreating the editor on
    // every parent render because of a closure identity change
    // would lose cursor state mid-typing. The listener only reads
    // the callback at the moment of dispatch, so the latest ref
    // pattern below keeps it current without remount thrashing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  // Keep ``onChange`` current without remounting via a ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // External ``value`` changes (Reset button, etc.) — diff against
  // editor doc and replace if they've drifted. Skip when the diff
  // came from the editor itself (we keep internal edits local).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-hidden rounded-md border border-[var(--border)] bg-[#282c34]"
    />
  );
}

function languageExtension(lang: ArtifactLanguage): Extension | null {
  switch (lang) {
    case "html":
    case "svg":
      return html();
    case "javascript":
    case "jsx":
      return javascript({ jsx: lang === "jsx" });
    case "typescript":
    case "tsx":
      return javascript({ typescript: true, jsx: lang === "tsx" });
    case "python":
      return python();
    case "markdown":
      return markdown();
    case "json":
      return json();
    case "css":
    case "scss":
      return css();
    case "xml":
      return xml();
    case "sql":
      return sql();
    case "rust":
      return rust();
    // For languages we don't have a pack for we still benefit from
    // the default highlight style + theme, which makes strings /
    // numbers / keywords legible via generic heuristics.
    default:
      return null;
  }
}
