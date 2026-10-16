import { useEffect, useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";

import { cn } from "@/utils/cn";

import { findReplaceKey } from "./FindReplaceExtension";

/**
 * Find (and, for editors, replace) — Ctrl/⌘+F and Ctrl/⌘+H in the
 * editor, or the toolbar's search button (WP-4.5, R-226). Enter / Shift+
 * Enter step through matches; Esc closes and clears the highlights.
 */
export function FindBar({
  editor,
  withReplace,
  canReplace,
  onClose,
  initialTerm,
}: {
  editor: Editor;
  withReplace: boolean;
  canReplace: boolean;
  onClose: () => void;
  /** Open already searching for this (a chat citation's passage). */
  initialTerm?: string;
}) {
  const [term, setTerm] = useState(() => {
    if (initialTerm) return initialTerm;
    const { from, to, empty } = editor.state.selection;
    const text = empty ? "" : editor.state.doc.textBetween(from, to, " ");
    return text.length <= 100 && !text.includes("\n") ? text : "";
  });
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(withReplace && canReplace);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => setShowReplace(withReplace && canReplace), [withReplace, canReplace]);
  useEffect(() => {
    findRef.current?.focus();
    findRef.current?.select();
  }, [withReplace]);
  useEffect(() => {
    editor.commands.setFindTerm(term, caseSensitive);
  }, [editor, term, caseSensitive]);
  useEffect(() => () => void editor.commands.clearFind(), [editor]);

  // Match count / position, re-rendered only when they change (R-234).
  useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const s = ed ? findReplaceKey.getState(ed.state) : undefined;
      return s ? `${s.matches.length}:${s.current}` : "";
    },
  });
  const state = findReplaceKey.getState(editor.state);
  const count = state?.matches.length ?? 0;
  const at = count ? (state?.current ?? 0) + 1 : 0;

  const keys = (e: React.KeyboardEvent, onEnter: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const field =
    "h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]";
  const icon = "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-black/5 hover:text-[var(--text)] disabled:opacity-40 dark:hover:bg-white/10";

  return (
    <div
      data-esc-layer
      role="search"
      aria-label="Find in document"
      className="flex flex-col gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 print:hidden"
    >
      <div className="flex items-center gap-1">
        <input
          ref={findRef}
          aria-label="Find"
          value={term}
          placeholder="Find in document"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) =>
            keys(e, () => (e.shiftKey ? editor.commands.findPrevious() : editor.commands.findNext()))
          }
          className={field}
        />
        <span className="w-20 shrink-0 text-center text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
          {term ? (count ? `${at} of ${count}` : "No results") : ""}
        </span>
        <button
          type="button"
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(icon, caseSensitive && "bg-black/10 text-[var(--text)] dark:bg-white/15")}
        >
          <CaseSensitive className="h-4 w-4" />
        </button>
        <button type="button" title="Previous match" aria-label="Previous match" disabled={!count} onClick={() => editor.commands.findPrevious()} className={icon}>
          <ChevronUp className="h-4 w-4" />
        </button>
        <button type="button" title="Next match" aria-label="Next match" disabled={!count} onClick={() => editor.commands.findNext()} className={icon}>
          <ChevronDown className="h-4 w-4" />
        </button>
        {canReplace && !showReplace && (
          <button type="button" onClick={() => setShowReplace(true)} className="h-7 rounded-md px-2 text-xs text-[var(--muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10">
            Replace…
          </button>
        )}
        <button type="button" title="Close find" aria-label="Close find" onClick={onClose} className={icon}>
          <X className="h-4 w-4" />
        </button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-1">
          <input
            aria-label="Replace with"
            value={replacement}
            placeholder="Replace with"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => keys(e, () => editor.commands.replaceCurrent(replacement))}
            className={field}
          />
          <button
            type="button"
            disabled={!count}
            onClick={() => editor.commands.replaceCurrent(replacement)}
            className="h-7 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--text)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
          >
            Replace
          </button>
          <button
            type="button"
            disabled={!count}
            onClick={() => editor.commands.replaceAll(replacement)}
            className="h-7 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--text)] hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
